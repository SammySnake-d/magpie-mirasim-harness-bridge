import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MirasimBridge } from "./adapter.mjs"

const scratch = []
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "magpie-mirasim-resource-test-")); scratch.push(dir)
  const paths = {
    setting: join(dir, "setting.json"), library: join(dir, "magpie", "library.json"),
    librarySkills: join(dir, "magpie", "library", "skills"), mirasimSkills: join(dir, "mirasim-skills"), magpieSettings: join(dir, "magpie", "settings.json"),
    codexCache: join(dir, "models.json"), dshPatch: join(dir, "dsh.yml"), dshLedger: join(dir, "ledger.json"),
    magpiePlugins: join(dir, "magpie", "plugins.json"), state: join(dir, "state.json"), lock: join(dir, "owner.json"),
  }
  mkdirSync(join(paths.librarySkills, "example-skill"), { recursive: true })
  writeFileSync(join(paths.librarySkills, "example-skill", "SKILL.md"), "---\nname: example-skill\ndescription: test\n---\n")
  writeFileSync(paths.setting, JSON.stringify({ models: { providers: {}, profiles: {} }, connectors: { installed: {}, tombstones: [] } }))
  writeFileSync(paths.magpieSettings, "{}")
  writeFileSync(paths.library, JSON.stringify({
    mcp: [
      { name: "existing", transport: "stdio", command: "node", args: ["server.js"], agents: ["codex"] },
      { name: "github", transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer fixture-secret" }, agents: ["dsh"] },
    ],
    skills: [{ name: "example-skill", agents: ["codex"] }],
  }))
  const calls = []
  const installedRows = [{ id: "custom-existing", entry: { name: "existing" }, enabledAgents: [] }]
  const host = { async call(atom, args = {}) {
    calls.push({ atom, args })
    if (atom === "listConnectors") return { type: "connectors", agents: ["claude", "codex", "dsh", "pi", "kimi"], installed: structuredClone(installedRows) }
    if (atom === "listSkills") return { type: "skills", skills: [{ name: "example-skill", source: "codex", scope: "global", managed: false, path: join(paths.librarySkills, "example-skill") }] }
    if (atom === "installConnector") { installedRows.push({ id: args.request.custom.id, entry: { name: args.request.custom.name }, enabledAgents: [] }); return { type: "connectors", installed: structuredClone(installedRows) } }
    if (atom === "setConnectorEnabled") { const row = installedRows.find(r => r.id === args.id); if (args.enabled && !row.enabledAgents.includes(args.agentId)) row.enabledAgents.push(args.agentId); if (!args.enabled) row.enabledAgents = row.enabledAgents.filter(a => a !== args.agentId); return { type: "connectors", installed: structuredClone(installedRows) } }
    if (atom === "syncAgentSkills") return { type: "skillsSynced", imported: ["example-skill"], skipped: [] }
    if (atom === "toggleSkill") return { type: "skills", skills: [{ name: args.name, managed: true, scope: "global", enabled: true }] }
    throw new Error(`unexpected ${atom}`)
  } }
  const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [] }) })
  return { dir, paths, host, calls, fetchImpl }
}

test("bridge imports Magpie-only MCPs and skills without overwriting existing connectors", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const bridge = new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host })
  await bridge.sync()
  const installed = calls.filter(c => c.atom === "installConnector")
  expect(installed).toHaveLength(1)
  expect(installed[0].args.request).toMatchObject({ custom: { id: "custom-github", name: "github", remote: { url: "https://example.invalid/mcp" } }, mode: "remote", secrets: { Authorization: "Bearer fixture-secret" } })
  expect(calls.filter(c => c.atom === "setConnectorEnabled")).toEqual([
    { atom: "setConnectorEnabled", args: { id: "custom-existing", agentId: "codex", enabled: true } },
    { atom: "setConnectorEnabled", args: { id: "custom-github", agentId: "dsh", enabled: true } },
  ])
  expect(calls.filter(c => c.atom === "syncAgentSkills")).toEqual([{ atom: "syncAgentSkills", args: { agent: "codex", skills: ["example-skill"], scope: "global" } }])
})

test("empty libraries, tombstones and user-owned names are respected", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const setting = JSON.parse(readFileSync(paths.setting, "utf8"))
  setting.connectors.tombstones = ["custom-github"]
  writeFileSync(paths.setting, JSON.stringify(setting))
  writeFileSync(paths.library, JSON.stringify({ mcp: [
    { name: "github", transport: "http", url: "https://example.invalid", agents: ["dsh"] },
    { name: "existing", transport: "stdio", command: "node", agents: ["codex"] },
  ], skills: [] }))
  await new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host }).sync()
  expect(calls.filter(c => c.atom === "installConnector")).toEqual([])
  expect(calls.filter(c => c.atom === "syncAgentSkills")).toEqual([])
  writeFileSync(paths.library, JSON.stringify({ mcp: null, skills: null }))
  await new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host }).sync()
})

test("unsupported MCP policies and disabled skills are never broadened", async () => {
  const { connectorRequest } = await import("./resource-sync.mjs")
  for (const server of [
    { name: "sse", transport: "sse", url: "https://example.invalid" },
    { name: "oauth", transport: "http", url: "https://example.invalid", oauth: { clientId: "x" } },
    { name: "filtered", transport: "stdio", command: "node", disabledTools: ["write"] },
    { name: "secret-url", transport: "http", url: "https://example.invalid/?token=fixture" },
    { name: "../escape", transport: "stdio", command: "node" },
  ]) expect(connectorRequest(server)).toBeNull()
  const request = connectorRequest({ name: "example", transport: "stdio", command: "node", env: { API_KEY: "fixture-secret", OTHER: "other" } })
  expect(request.custom.stdio.env).toEqual([{ name: "API_KEY", secret: true, required: false }, { name: "OTHER", secret: true, required: false }])
  expect(request.secrets).toEqual({ API_KEY: "fixture-secret", OTHER: "other" })
  const { dir, paths, host, calls, fetchImpl } = fixture()
  writeFileSync(paths.library, JSON.stringify({ mcp: [], skills: [{ name: "example-skill", agents: ["codex"], offHere: true }] }))
  await new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host }).sync()
  expect(calls.filter(c => c.atom === "syncAgentSkills")).toEqual([])
})

test("failed MCP import does not stop skill import and a later round retries", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const original = host.call.bind(host)
  let failed = false
  host.call = async (atom, args) => {
    if (atom === "installConnector" && !failed) { failed = true; calls.push({ atom, args }); throw new Error("secret-bearing error must not be logged") }
    return original(atom, args)
  }
  const logs = []
  const bridge = new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host, log: x => logs.push(x) })
  await bridge.sync()
  expect(calls.filter(c => c.atom === "syncAgentSkills")).toHaveLength(1)
  expect(logs.join("\n")).not.toContain("secret")
  bridge.resourceRetryAt = 0
  await bridge.sync()
  expect(calls.filter(c => c.atom === "installConnector")).toHaveLength(2)
})

test("a same-name but different native skill is not selected as the import source", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const original = host.call.bind(host)
  host.call = (atom, args) => atom === "listSkills"
    ? Promise.resolve({ type: "skills", skills: [{ name: "example-skill", source: "codex", scope: "global", managed: false, path: dir }] })
    : original(atom, args)
  await new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host }).sync()
  expect(calls.filter(c => c.atom === "syncAgentSkills")).toEqual([])
})


test("Magpie harness changes are mirrored, without enabling unsupported agent IDs", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const bridge = new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host })
  await bridge.sync()
  const library = JSON.parse(readFileSync(paths.library, "utf8"))
  library.mcp.find(x => x.name === "github").agents = ["claude", "claude-desktop"]
  writeFileSync(paths.library, JSON.stringify(library))
  await bridge.sync()
  const toggles = calls.filter(c => c.atom === "setConnectorEnabled" && c.args.id === "custom-github").map(c => [c.args.agentId, c.args.enabled])
  expect(toggles).toEqual([["dsh", true], ["claude", true], ["dsh", false]])
  expect(toggles.some(x => x[0] === "claude-desktop")).toBe(false)
})

test("removing a Magpie MCP disables only the bridge-mirrored agents, without uninstalling it", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const bridge = new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host })
  await bridge.sync()
  const library = JSON.parse(readFileSync(paths.library, "utf8"))
  library.mcp = library.mcp.filter(x => x.name !== "github")
  writeFileSync(paths.library, JSON.stringify(library))
  await bridge.sync()
  const toggles = calls.filter(c => c.atom === "setConnectorEnabled" && c.args.id === "custom-github").map(c => [c.args.agentId, c.args.enabled])
  expect(toggles).toEqual([["dsh", true], ["dsh", false]])
  expect(calls.some(c => c.atom === "uninstallConnector")).toBe(false)
})


test("a DSH-only Magpie skill is imported as a full Mirasim-owned copy", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const source = join(paths.librarySkills, "example-skill")
  mkdirSync(join(source, "references"))
  writeFileSync(join(source, "references", "proof.txt"), "fixture")
  writeFileSync(paths.library, JSON.stringify({ mcp: [], skills: [{ name: "example-skill", agents: ["dsh"] }] }))
  const original = host.call.bind(host)
  host.call = (atom, args) => atom === "listSkills" ? Promise.resolve({ type: "skills", skills: [] }) : original(atom, args)
  const bridge = new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host })
  await bridge.sync()
  expect(readFileSync(join(paths.mirasimSkills, "example-skill", "references", "proof.txt"), "utf8")).toBe("fixture")
  expect(calls.filter(c => c.atom === "toggleSkill")).toEqual([{ atom: "toggleSkill", args: { name: "example-skill", scope: "global", enabled: true } }])
})

test("an MCP gaining unrepresentable tool restrictions is no longer mirrored", async () => {
  const { dir, paths, host, calls, fetchImpl } = fixture()
  const bridge = new MirasimBridge({ paths, dir, fetchImpl, resourceClient: host })
  await bridge.sync()
  const library = JSON.parse(readFileSync(paths.library, "utf8"))
  library.mcp.find(x => x.name === "github").disabledTools = ["dangerous-write"]
  writeFileSync(paths.library, JSON.stringify(library))
  await bridge.sync()
  const toggles = calls.filter(c => c.atom === "setConnectorEnabled" && c.args.id === "custom-github").map(c => [c.args.agentId, c.args.enabled])
  expect(toggles).toEqual([["dsh", true], ["dsh", false]])
})
