// Mirasim runs Claude Code, Codex, DSH and Pi: the same CLIs magpie wires one
// by one. This plugin is no agent of its own; it lets each of them, inside
// Mirasim, use what magpie gives that agent, and keeps magpie's wiring of
// them out of Mirasim's own route. It runs in magpie's plugin host (Bun),
// every few seconds, while the plugin is on; turned off or removed, it puts
// Mirasim back as the host goes.
//
// In ~/.mirasim/setting.json Mirasim keeps its own-key models: providers, and
// profiles (one model each, listing the harnesses it shows in) under
// `models`. A harness started on a profile goes straight to its provider,
// never through Mirasim's relay, whichever route the session is on. So:
//
//  - one provider: magpie's gateway;
//  - one profile per model, listing the harnesses whose own catalog at the
//    gateway has it (Codex in Mirasim offers what magpie gives Codex, …);
//  - Codex's menu: the rows Mirasim reads from Codex's own cache (~/.codex,
//    where magpie's wiring of Codex puts its catalog) turned off, as the
//    profiles stand in for them and on Mirasim's route they went to its relay;
//  - DSH: the model magpie starts it on recorded as one Mirasim selected, so
//    Mirasim's route puts DSH on Mirasim's model rather than leaving it there.
//
// Each round reads the files and the gateway afresh and writes only what
// differs, so it may stop and start again anywhere.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MirasimAtomClient, resourceSignature, syncResources } from "./resource-sync.mjs"

export const NAME = "magpie-mirasim"
export const HERE = dirname(fileURLToPath(import.meta.url))
// The provider's id, fixed: "magpie" in hex, then "mirasi".
export const PROVIDER_ID = "6d616770-6965-4000-8000-6d6972617369"
// The harnesses Mirasim runs that magpie wires as agents of the same id.
export const HARNESSES = ["claude", "codex", "dsh", "pi"]
// The key the harnesses send. Not an agent's own key: the gateway then tells
// the agent by its User-Agent, as it does for magpie's own wiring of each.
export const KEY = "magpie"
// Profile ids begin "magp" in hex.
const OURS = "6d616770-"

const home = homedir()
const magpieDir = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "magpie")
export const PATHS = {
  setting: join(home, ".mirasim", "setting.json"),
  codexCache: join(home, ".codex", "models_cache.json"),
  // the DSH profile Mirasim's DSH sessions read (linked into each one's home)
  dshPatch: join(home, ".dsh", "profiles", "web", "cordis.patch.yml"),
  // the model selections Mirasim knows it put DSH on
  dshLedger: join(home, ".mirasim", "agent-homes", "dsh", "selections-written.json"),
  library: join(magpieDir, "library.json"),
  librarySkills: join(magpieDir, "library", "skills"),
  mirasimSkills: join(home, ".mirasim", "skills"),
  mirasimRun: join(home, ".mirasim", "run"),
  magpieSettings: join(magpieDir, "settings.json"),
  magpiePlugins: join(magpieDir, "plugins.json"),
  // what this plugin changed of Mirasim's own, to put back
  state: join(home, ".config", NAME, "state.json"),
  // which instance of the plugin keeps Mirasim (see claim)
  lock: join(home, ".config", NAME, "owner.json"),
}

// A claim older than this, unrenewed, is its holder's no longer.
const STALE_MS = 30000

// Mirasim's effort rungs; magpie's "none" is Mirasim's "off".
const RUNGS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

export function gateway(settings) {
  const url = `http://127.0.0.1:${settings?.port || 3425}`
  return { url, v1: `${url}/v1` }
}

export function provider(gw) {
  // Every API is served at the gateway, so the harnesses each take their own:
  // Claude Code, DSH and Pi Anthropic Messages, Codex Responses. Declared, so
  // Mirasim needn't probe: its probe can't tell the gateway's answer to a
  // model it doesn't serve from a path that isn't there (both 404), and would
  // ask again every half hour.
  const wire = {
    anthropicMessages: "present",
    responses: "present",
    chatCompletions: "present",
    anthropicBaseURL: gw.url,
    anthropicAuth: "bearer",
    openaiBaseURL: gw.v1,
  }
  return {
    id: PROVIDER_ID,
    kind: "anthropic",
    name: "magpie",
    baseURL: gw.url,
    // A command, not an inline key: Mirasim seals inline keys with a key of
    // its own; a command it runs as it is.
    credential: { source: "command", argv: ["/bin/echo", KEY] },
    extraHeaders: null,
    // wireOverride decides; wire, what Mirasim keeps of a probe, is filled in
    // too, so it doesn't probe ("full": prompt_cache_key is taken)
    wireOverride: wire,
    wire: { ...wire, responsesFields: "full", probedAt: "2026-01-01T00:00:00.000Z" },
    validation: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

// cyrb128: a non-cryptographic 128-bit hash, enough to give each model id a
// stable profile id of its own (a model picked somewhere, as Mira Bot's,
// stays picked).
function cyrb128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1, h2, h3, h4].map(h => (h >>> 0).toString(16).padStart(8, "0")).join("")
}

// A UUID-shaped profile id: "6d616770" then the model id's hash, with the
// version and variant nibbles of a v4 UUID.
export function profileId(modelId) {
  const h = cyrb128(modelId)
  return `${OURS}${h.slice(0, 4)}-4${h.slice(5, 8)}-8${h.slice(9, 12)}-${h.slice(12, 24)}`
}

// Mirasim sorts profiles by createdAt; a fixed time per position keeps the
// catalogs' order and the file unchanged while they are.
function stamp(i) {
  const two = n => String(n).padStart(2, "0")
  return `2026-01-01T${two(Math.floor(i / 3600) % 24)}:${two(Math.floor(i / 60) % 60)}:${two(i % 60)}.000Z`
}

function efforts(levels) {
  const out = []
  for (const e of levels || []) {
    const id = e === "none" ? "off" : e
    if (!RUNGS.includes(id) || out.some(r => r.id === id)) continue
    out.push(id === e ? { id } : { id, wire: e })
  }
  return out
}

// The profiles the catalogs call for, by id. catalogs: harness → the
// gateway's /v1/models entries for that agent, in its order.
export function profilesFor(catalogs) {
  const byModel = new Map()
  for (const h of HARNESSES) {
    for (const m of catalogs[h] || []) {
      if (!byModel.has(m.id)) byModel.set(m.id, { model: m, agents: new Set() })
      byModel.get(m.id).agents.add(h)
    }
  }
  const out = {}
  let i = 0
  for (const [id, { model, agents }] of byModel) {
    const at = stamp(i++)
    const context = model.context_window > 0 ? model.context_window : model.context_length > 0 ? model.context_length : null
    const output = model.max_output_tokens > 0 ? (context ? Math.min(model.max_output_tokens, context) : model.max_output_tokens) : null
    const pid = profileId(id)
    out[pid] = {
      id: pid,
      name: model.magpie_label || model.display_name || id,
      providerId: PROVIDER_ID,
      modelId: id,
      efforts: efforts(model.reasoning_levels),
      effort: null,
      maxOutputTokens: output,
      contextWindow: context,
      // in Mirasim's order of them, which is the order of HARNESSES
      agents: HARNESSES.filter(h => agents.has(h)),
      headerRules: null,
      requestBodyRules: null,
      createdAt: at,
      updatedAt: at,
    }
  }
  return out
}

const ours = p => p && p.providerId === PROVIDER_ID && String(p.id || "").startsWith(OURS)

// settings with this plugin's provider made `prov` and its profiles `want`
// (prov null: neither), or null when they already are. The user's providers
// and profiles and every other setting are left as they are.
export function withModels(settings, prov, want) {
  const models = settings.models || {}
  const providers = { ...(models.providers || {}) }
  const have = models.profiles || {}
  if (prov) providers[PROVIDER_ID] = prov
  else delete providers[PROVIDER_ID]
  const profiles = {}
  for (const [k, p] of Object.entries(have)) if (!ours(p)) profiles[k] = p
  if (prov) Object.assign(profiles, want)
  const mine = (provs, profs) =>
    JSON.stringify([provs[PROVIDER_ID] ?? null, Object.entries(profs).filter(([, p]) => ours(p)).sort(([a], [b]) => a.localeCompare(b))])
  if (mine(models.providers || {}, have) === mine(providers, profiles)) return null
  return { ...settings, models: { ...models, providers, profiles } }
}

// Mirasim's Codex menu lists, besides its own models, those in Codex's own
// model cache (~/.codex, shared with Codex outside Mirasim), where magpie's
// wiring of Codex puts its catalog. They duplicate the profiles, and on
// Mirasim's own route are sent to Mirasim's relay, which refuses them. These
// are the ones to keep out of that menu: the cache's models named
// provider/model (Codex's own never are), save those Mirasim lists under an id
// of its own (mira/gpt-6-astra as gpt-6-astra).
export function codexNatives(cache, own) {
  const out = []
  for (const m of cache?.models || []) {
    const id = m.slug || m.id
    if (!id || !id.includes("/")) continue
    if (own.has(id.slice(id.indexOf("/") + 1))) continue
    if (!out.includes(id)) out.push(id)
  }
  return out
}

// settings with Codex's menu turning off exactly `hide` of what this plugin
// turns off (`was`, from its state), the user's own choices kept; and what it
// turns off now. A model the user had turned off already stays theirs.
export function withCodexOff(settings, hide, was) {
  const en = settings.modelEnablement || {}
  const off = en.codex?.off || []
  const users = off.filter(id => !was.includes(id))
  const mine = hide.filter(id => !users.includes(id))
  const next = [...users, ...mine]
  if (JSON.stringify(next) === JSON.stringify(off)) return { settings: null, mine }
  return { settings: { ...settings, modelEnablement: { ...en, codex: { ...(en.codex || {}), off: next } } }, mine }
}

// The model DSH starts on, from the last agent-default-model of a cordis
// patch (magpie's wiring of DSH writes one): [provider, model, effort], as
// Mirasim keys a selection.
export function dshStart(patch) {
  const lines = String(patch || "").split("\n")
  let found = null
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- id:\s*agent-default-model\b/)
    if (!m) continue
    const indent = m[1].length
    const v = {}
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (new RegExp(`^\\s{0,${indent}}- `).test(l)) break
      const kv = l.match(/^\s+(provider|model|reasoningEffort):\s*"?([^"#]*?)"?\s*(#.*)?$/)
      if (kv) v[kv[1]] = kv[2]
    }
    if (v.provider && v.model) found = [v.provider, v.model, v.reasoningEffort || ""]
  }
  return found
}

// Mirasim leaves DSH on its own start when a session is to run DSH's default
// model, unless DSH stands on a selection Mirasim knows it made, taking the
// start to be DSH's own default model. The start magpie writes in the DSH
// profile both share is another model, so Mirasim's own route ran DSH's
// default model on magpie's. Known as one of its selections, Mirasim puts DSH
// on the model asked for, as it does for every other. The ledger with `add`
// in and `drop` out, or null when it already is.
export function withLedger(ledger, add, drop) {
  const written = Array.isArray(ledger?.written) ? ledger.written : []
  let next = drop && drop !== add ? written.filter(k => k !== drop) : written
  if (add && !next.includes(add)) next = [...next, add]
  if (JSON.stringify(next) === JSON.stringify(written)) return null
  return { ...ledger, written: next }
}

// Whether magpie has this plugin on: its entry in plugins.json (by the folder
// it was added from, or by name from npm), not turned off. undefined when
// plugins.json can't be read: then nothing is put back.
function sameDirectory(a, b) {
  try { return realpathSync(a) === realpathSync(b) }
  catch { return resolve(a) === resolve(b) }
}

export function pluginOn(plugins, { dir = HERE, name = NAME, installedDir, manifest } = {}) {
  if (!Array.isArray(plugins?.plugins) || plugins.plugins.some(p => !p || typeof p.spec !== "string")) return undefined
  const entries = plugins.plugins
  const direct = entries.find(p => p.spec === dir || p.spec === name || p.spec.startsWith(`${name}@`))
  if (direct) return !direct.off
  // GitHub installations are registered by Git spec, while the running
  // package lives under node_modules. Trust only the installed package's
  // own manifest mapping, never a similarly named repository.
  if (installedDir && sameDirectory(dir, installedDir)) {
    if (!entries.length) return false
    if (!manifest?.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies)) return undefined
    const spec = manifest.dependencies[name]
    if (spec === undefined) return false
    if (typeof spec !== "string" || !spec) return undefined
    const entry = entries.find(p => p.spec === spec)
    return !!entry && !entry.off
  }
  return false
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return undefined
    throw e
  }
}

// Written whole through a temp file and a rename, as Mirasim writes it, the
// file's mode kept (setting.json holds Mirasim's sign-in: 0600).
function writeJSON(path, value) {
  let mode = 0o600
  try {
    mode = statSync(path).mode & 0o777
  } catch {}
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.magpie.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

// Applies change to the file as it is now, read again right before the
// write, so what Mirasim wrote in between is kept.
function update(path, change) {
  const cur = readJSON(path)
  if (cur === undefined) return false
  const next = change(cur)
  if (!next) return false
  writeJSON(path, next)
  return true
}

export async function catalogs(base, fetchImpl = fetch) {
  const out = {}
  for (const h of HARNESSES) {
    const r = await fetchImpl(`${base}/v1/models`, {
      headers: { authorization: `Bearer magpie-${h}` },
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) throw new Error(`catalog ${h}: ${r.status}`)
    out[h] = (await r.json()).data || []
  }
  return out
}

export class MirasimBridge {
  constructor({ paths = PATHS, fetchImpl = fetch, every = 5000, log = () => {}, dir = HERE, pid = process.pid, isAlive = alive, resourceClient } = {}) {
    Object.assign(this, { paths, fetchImpl, every, log, dir, pid, isAlive })
    this.timer = null
    this.running = null
    this.resourceClient = resourceClient || (paths.mirasimRun ? new MirasimAtomClient(paths.mirasimRun) : null)
    this.resourceKey = null
    this.resourceRetryAt = 0
  }

  state() {
    return readJSON(this.paths.state) || {}
  }

  // magpie runs the plugin in its app's host and, for a moment, in a host
  // each of its commands starts; two of them writing Mirasim and its state
  // at once lose what the plugin changed (a restore by one, a round by the
  // other). So one keeps Mirasim: the one whose claim is fresh and alive;
  // the others leave it alone. Renewed every round, taken over once its
  // holder is gone or 30 s silent.
  claim() {
    try {
      const cur = readJSON(this.paths.lock)
      if (cur && cur.pid !== this.pid && this.isAlive(cur.pid) && Date.now() - statSync(this.paths.lock).mtimeMs < STALE_MS) return false
    } catch {}
    writeJSON(this.paths.lock, { pid: this.pid })
    return this.owns()
  }

  owns() {
    try {
      return readJSON(this.paths.lock)?.pid === this.pid
    } catch {
      return false
    }
  }

  // One round: Mirasim's models and Codex's menu, then DSH's start, each on
  // its own, so a gateway that doesn't answer leaves the models as they are
  // and lets the rest through. Returns what it changed.
  async sync() {
    const changed = [], failed = []
    if (!existsSync(this.paths.setting)) return changed // no Mirasim here
    const state = this.state()
    const was = JSON.stringify(state)
    try {
      const gw = gateway(readJSON(this.paths.magpieSettings))
      const cats = await catalogs(gw.url, this.fetchImpl)
      if (update(this.paths.setting, s => withModels(s, provider(gw), profilesFor(cats)))) changed.push("models")
      const own = new Set(Object.keys(readJSON(this.paths.setting)?.modelRosterCache?.models || {}))
      const hide = codexNatives(readJSON(this.paths.codexCache), own)
      let mine = state.codexOff || []
      if (update(this.paths.setting, s => {
        const r = withCodexOff(s, hide, state.codexOff || [])
        mine = r.mine
        return r.settings
      })) changed.push("codex menu")
      state.codexOff = mine
    } catch (e) {
      failed.push(`models: ${e.message}`)
    }
    try {
      let patch
      try {
        patch = readFileSync(this.paths.dshPatch, "utf8")
      } catch {}
      const start = dshStart(patch)
      const add = start ? JSON.stringify(start) : null
      const prev = state.dshStart || null
      let added = false
      if (update(this.paths.dshLedger, l => {
        const written = Array.isArray(l?.written) ? l.written : []
        // ours to take out later only if it is we who put it in
        added = !!add && !written.includes(add)
        return withLedger(l, added ? add : null, prev && prev !== add ? prev : null)
      })) changed.push("dsh start")
      if (added) state.dshStart = add
      else if (prev && prev !== add) delete state.dshStart
    } catch (e) {
      failed.push(`dsh: ${e.message}`)
    }
    if (this.paths.library && this.paths.librarySkills && this.resourceClient) {
      const key = resourceSignature(this.paths, this.resourceClient)
      if (key && key !== this.resourceKey && Date.now() >= this.resourceRetryAt) {
        try {
          const result = await syncResources({ paths: this.paths, client: this.resourceClient, tracked: state.mcpMirror, log: this.log })
          if (result.tracked) state.mcpMirror = result.tracked
          if (result.changed) changed.push("resources")
          if (result.retry) this.resourceRetryAt = Date.now() + 30000
          else { this.resourceKey = resourceSignature(this.paths, this.resourceClient); this.resourceRetryAt = 0 }
        } catch (e) {
          failed.push(`resources: ${e.message}`)
          this.resourceRetryAt = Date.now() + 30000
        }
      }
    }
    if (JSON.stringify(state) !== was) writeJSON(this.paths.state, state)
    if (failed.length) this.log(`mirasim: ${failed.join("; ")}`)
    return changed
  }

  // Mirasim as it was before the plugin: the provider and its profiles out,
  // Codex's menu and DSH's ledger without what the plugin added. Synchronous,
  // for a host on its way out.
  restore() {
    const state = this.state()
    if (existsSync(this.paths.setting)) {
      update(this.paths.setting, s => withModels(s, null, {}))
      update(this.paths.setting, s => withCodexOff(s, [], state.codexOff || []).settings)
    }
    if (state.dshStart) update(this.paths.dshLedger, l => withLedger(l, null, state.dshStart))
    rmSync(this.paths.state, { force: true })
  }

  // The host is going: when magpie no longer has the plugin on (turned off,
  // removed), put Mirasim back; on a restart or magpie quitting, leave it.
  // Only the instance keeping Mirasim does either.
  exit() {
    try {
      if (!this.owns()) return
      const base = dirname(this.paths.magpiePlugins)
      let manifest
      try { manifest = readJSON(join(base, "plugins", "package.json")) } catch {}
      const installedDir = join(base, "plugins", "node_modules", NAME)
      if (pluginOn(readJSON(this.paths.magpiePlugins), { dir: this.dir, installedDir, manifest }) === false) this.restore()
      rmSync(this.paths.lock, { force: true })
    } catch {}
  }

  tick() {
    if (this.running) return this.running
    if (!this.claim()) return Promise.resolve()
    this.running = this.sync()
      .then(c => c.length && this.log(`mirasim: updated ${c.join(", ")}`))
      .catch(e => this.log(`mirasim: ${e.message}`))
      .finally(() => (this.running = null))
    return this.running
  }

  start() {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.every)
    this.timer.unref?.()
    return this
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }
}
