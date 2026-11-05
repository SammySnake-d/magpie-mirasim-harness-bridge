// Import Magpie Library resources and mirror their per-agent MCP choices.
// Use Mirasim host atoms for connector validation, secret storage and UI
// notifications; never patch the Mirasim application.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

const AGENTS = ["claude", "codex", "dsh", "pi"]
const SKILL_SOURCES = ["claude", "codex", "agents"]
const NAME = /^[A-Za-z0-9_-]+$/
const expected = { listConnectors: "connectors", installConnector: "connectors", setConnectorEnabled: "connectors", listSkills: "skills", syncAgentSkills: "skillsSynced", toggleSkill: "skills" }

function signature(path) {
  try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}` } catch { return null }
}

export class MirasimAtomClient {
  constructor(runDir) { this.runDir = runDir }

  // Never guess between multiple non-default hosts; 4970 is the installed
  // desktop's normal port. One remaining host is safe to use as a fallback.
  endpoint() {
    let files
    try { files = readdirSync(this.runDir).filter(x => /^local-\d+\.token$/.test(x)) } catch { return null }
    const file = files.includes("local-4970.token") ? "local-4970.token" : files.length === 1 ? files[0] : null
    if (!file) return null
    return { port: Number(file.slice(6, -6)), tokenPath: join(this.runDir, file) }
  }

  signature() {
    const end = this.endpoint()
    return end ? `${end.port}:${signature(end.tokenPath)}` : null
  }

  async call(atom, args = {}) {
    const end = this.endpoint()
    if (!end) throw new Error("Mirasim desktop host not available")
    const token = readFileSync(end.tokenPath, "utf8").trim()
    if (!token) throw new Error("Mirasim desktop token unavailable")
    const response = await fetch(`http://127.0.0.1:${end.port}/api/atoms/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mirasim-token": token },
      body: JSON.stringify({ atom, args, timeoutMs: 8000, maxFrames: 30 }),
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error(`${atom}: HTTP ${response.status}`)
    const result = await response.json()
    if (!result.ok) throw new Error(`${atom}: request failed`)
    const frame = result.frames?.find(f => f.type === expected[atom])
    if (!frame) throw new Error(`${atom}: no completion frame`)
    return frame
  }
}

export function connectorId(name) {
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return slug ? `custom-${slug}` : null
}

// All environment and header values go through Mirasim's secret store, not
// the connector entry or logs. OAuth and tool filters have no equivalent in
// this import contract, so leave them alone rather than widening access.
export function connectorRequest(server) {
  if (!server || !NAME.test(server.name || "") || server.oauth || server.disabledTools?.length) return null
  const id = connectorId(server.name)
  const base = { id, name: server.name, vendor: "custom", category: "custom", description: "Imported from Magpie Library", descriptionZh: "从 Magpie 资源库导入", official: false }
  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || !server.command.trim() || !Array.isArray(server.args || [])) return null
    const secrets = server.env || {}
    if (Object.values(secrets).some(v => typeof v !== "string")) return null
    return { custom: { ...base, stdio: { command: server.command, args: server.args || [], env: Object.keys(secrets).map(name => ({ name, secret: true, required: false })) } }, mode: "stdio", secrets }
  }
  if (server.transport === "http") {
    let url
    try { url = new URL(server.url) } catch { return null }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|key|password|auth|credential/i.test(k))) return null
    const secrets = server.headers || {}
    if (Object.values(secrets).some(v => typeof v !== "string")) return null
    return { custom: { ...base, remote: { url: server.url, transport: "http", auth: Object.keys(secrets).length ? "apikey" : "open", headerFields: Object.keys(secrets).map(name => ({ name, secret: true, required: false })) } }, mode: "remote", secrets }
  }
  return null
}

function samePath(a, b) {
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

function skillSourceMatches(row, libraryPath, library, agent, name) {
  if (samePath(row.path, libraryPath)) return true
  // Magpie can be configured to give an agent a copy instead of a symlink.
  return library?.applied?.[agent]?.skills?.includes(name) && existsSync(join(row.path, ".magpie-library"))
}

// Some Mirasim versions do not discover the DSH/Pi skill stores. In that
// case mirror the same full directory as its built-in sync does, using a
// staging directory and an exclusive destination reservation. Never replace
// an existing skill, and never operate on the Magpie source afterwards.
function copySkill(paths, name) {
  if (!paths.mirasimSkills) return false
  const source = join(paths.librarySkills, name)
  if (!existsSync(join(source, "SKILL.md")) || existsSync(join(source, "SKILL.md.disabled"))) return false
  mkdirSync(paths.mirasimSkills, { recursive: true })
  const stage = mkdtempSync(join(paths.mirasimSkills, ".magpie-import-"))
  const dest = join(paths.mirasimSkills, name)
  let reserved = false
  try {
    const copied = join(stage, "content")
    cpSync(source, copied, { recursive: true, dereference: true, errorOnExist: true, force: false })
    try { mkdirSync(dest); reserved = true } catch (e) { if (e.code === "EEXIST") return false; throw e }
    renameSync(copied, dest); reserved = false
    return true
  } finally {
    if (reserved) try { rmdirSync(dest) } catch {}
    rmSync(stage, { recursive: true, force: true })
  }
}

export async function syncResources({ paths, client, tracked: previous = {}, log = () => {} }) {
  let library
  try { library = JSON.parse(readFileSync(paths.library, "utf8")) } catch (e) {
    if (e.code === "ENOENT") return { changed: false, retry: false }
    throw new Error("Magpie Library is unreadable")
  }
  if ((library.mcp != null && !Array.isArray(library.mcp)) || (library.skills != null && !Array.isArray(library.skills))) throw new Error("Magpie Library is incomplete")
  const settings = JSON.parse(readFileSync(paths.setting, "utf8"))
  const tombstones = new Set(settings.connectors?.tombstones || [])
  let changed = false, retry = false
  let hostAgents = AGENTS
  const tracked = { ...previous }
  const notices = []

  try {
    const frame = await client.call("listConnectors")
    if (!Array.isArray(frame.installed)) throw new Error("invalid connector list")
    if (!Array.isArray(frame.agents)) throw new Error("invalid agent list")
    const supported = frame.agents.filter(a => typeof a === "string")
    hostAgents = supported
    const existing = new Map(frame.installed.map(c => [c.id, c]))
    const disableTracked = async (name, old) => {
      let row = existing.get(old.id)
      if (!row || row.entry?.name !== name) return true
      let failed = false
      for (const agent of old.agents || []) {
        if (!(row.enabledAgents || []).includes(agent)) continue
        try {
          const result = await client.call("setConnectorEnabled", { id: row.id, agentId: agent, enabled: false })
          const updated = result.installed?.find(c => c.id === row.id)
          if (!updated || (updated.enabledAgents || []).includes(agent)) throw new Error("not applied")
          row = updated; existing.set(row.id, row); changed = true
        } catch { notices.push(`MCP ${name}: ${agent} disable failed`); retry = true; failed = true }
      }
      return !failed
    }
    const present = new Set((library.mcp || []).map(s => s?.name).filter(Boolean))
    for (const server of library.mcp || []) {
      const id = connectorId(server?.name)
      if (!id || !Array.isArray(server.agents) || tombstones.has(id)) continue
      // A connector with this ID but another name belongs to the user.
      let row = existing.get(id)
      if (row && row.entry?.name !== server.name) { notices.push(`MCP ${server.name}: name collision`); continue }
      if (!row) {
        const sameName = [...existing.values()].find(c => c.entry?.name === server.name)
        if (sameName) row = sameName
      }
      const request = connectorRequest(server)
      // Never enable an entry whose Magpie policy cannot be represented.
      if (!request) {
        notices.push(`MCP ${server.name}: unsupported settings`)
        const old = tracked[server.name]
        if (old && await disableTracked(server.name, old)) tracked[server.name] = { ...old, agents: [] }
        continue
      }
      if (!row) {
        // Re-read immediately before the host call, respecting an intervening
        // manual install or uninstall rather than reinstalling its credentials.
        const latest = JSON.parse(readFileSync(paths.setting, "utf8")).connectors || {}
        if (latest.installed?.[id] || latest.tombstones?.includes(id)) continue
        try {
          const result = await client.call("installConnector", { request })
          row = result.installed?.find(c => c.id === id)
          if (!row) throw new Error("not installed")
          existing.set(id, row); changed = true
        } catch {
          notices.push(`MCP ${server.name}: import failed`); retry = true; continue
        }
      }
      const desired = new Set(server.agents.filter(a => supported.includes(a)))
      let enabled = new Set(row.enabledAgents || [])
      for (const agent of supported) {
        const on = desired.has(agent)
        if (enabled.has(agent) === on) continue
        try {
          const result = await client.call("setConnectorEnabled", { id: row.id, agentId: agent, enabled: on })
          const updated = result.installed?.find(c => c.id === row.id)
          if (!updated || (updated.enabledAgents || []).includes(agent) !== on) throw new Error("not applied")
          row = updated; existing.set(row.id, row); enabled = new Set(row.enabledAgents); changed = true
        } catch { notices.push(`MCP ${server.name}: ${agent} enablement failed`); retry = true }
      }
      tracked[server.name] = { id: row.id, agents: [...enabled].filter(a => supported.includes(a)) }
    }
    // Removing a library entry stops only the agent permissions previously
    // mirrored by this bridge; the installed connector and credentials stay.
    for (const [name, old] of Object.entries(tracked)) {
      if (present.has(name)) continue
      if (await disableTracked(name, old)) delete tracked[name]
    }
  } catch { notices.push("MCP: Mirasim unavailable"); retry = true }

  try {
    const frame = await client.call("listSkills", { scope: "global" })
    if (!Array.isArray(frame.skills)) throw new Error("invalid skill list")
    const managed = new Set(frame.skills.filter(s => s.scope === "global" && s.managed).map(s => s.name))
    const selected = new Map(SKILL_SOURCES.map(agent => [agent, []]))
    for (const skill of library.skills || []) {
      if (!NAME.test(skill?.name || "") || skill.offHere || managed.has(skill.name) || !Array.isArray(skill.agents) || !skill.agents.some(agent => hostAgents.includes(agent))) continue
      const libraryPath = join(paths.librarySkills, skill.name)
      let found = false
      for (const agent of [...SKILL_SOURCES].sort((a, b) => Number(skill.agents.includes(b)) - Number(skill.agents.includes(a)))) {
        // The host picks the FIRST row of this source/name; match that exact
        // row before requesting import, not another same-name skill.
        const row = frame.skills.find(s => s.scope === "global" && !s.managed && s.source === agent && s.name === skill.name && s.path)
        if (row && row.enabled !== false && skillSourceMatches(row, libraryPath, library, agent, skill.name)) {
          selected.get(agent).push(skill.name); found = true; break
        }
      }
      if (!found) {
        try {
          if (copySkill(paths, skill.name)) {
            // Mirasim's toggle is a no-op on an enabled copy, but emits the
            // host notification that refreshes the existing Settings page.
            const result = await client.call("toggleSkill", { name: skill.name, scope: "global", enabled: true })
            if (!result.skills?.some(s => s.name === skill.name && s.scope === "global" && s.managed)) throw new Error("not visible")
            managed.add(skill.name); changed = true
          } else if (!existsSync(join(paths.mirasimSkills || "", skill.name))) {
            notices.push(`skill ${skill.name}: source unavailable`); retry = true
          }
        } catch { notices.push(`skill ${skill.name}: import failed`); retry = true }
      }
    }
    for (const [agent, skills] of selected) {
      if (!skills.length) continue
      try {
        const result = await client.call("syncAgentSkills", { agent, skills, scope: "global" })
        if (!Array.isArray(result.imported) || !Array.isArray(result.skipped)) throw new Error("invalid skill result")
        changed ||= result.imported.length > 0
        if (result.skipped.some(s => s.reason !== "exists")) { notices.push(`skills ${agent}: some imports failed`); retry = true }
      } catch { notices.push(`skills ${agent}: import failed`); retry = true }
    }
  } catch { notices.push("skills: Mirasim unavailable"); retry = true }
  if (notices.length) log(`mirasim resources: ${notices.join("; ")}`)
  return { changed, retry, tracked }
}

export function resourceSignature(paths, client) {
  const library = signature(paths.library)
  const host = typeof client.signature === "function" ? client.signature() : "fixture"
  if (!library || !host) return null
  // Connector edits are also input: if a user changes Mirasim directly, the
  // next pass restores Magpie's selected harnesses without rereading secrets.
  try {
    const c = JSON.parse(readFileSync(paths.setting, "utf8")).connectors || {}
    const installed = Object.entries(c.installed || {}).map(([id, v]) => [id, v.entry?.name, (v.enabledAgents || []).slice().sort()]).sort(([a], [b]) => a.localeCompare(b))
    return `${library}|${host}|${JSON.stringify([installed, (c.tombstones || []).slice().sort()])}`
  } catch { return null }
}
