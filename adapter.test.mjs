import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HARNESSES, KEY, MirasimBridge, PROVIDER_ID, codexNatives, dshStart, gateway, pluginOn, profileId,
  profilesFor, provider, withCodexOff, withLedger, withModels,
} from "./adapter.mjs"

const gw = gateway({})
const m = (id, extra = {}) => ({ id, magpie_label: `${id} · p`, context_window: 200000, max_output_tokens: 64000, reasoning_levels: ["none", "low", "high"], ...extra })
const catalogs = {
  claude: [m("vendor-a/model-large")],
  codex: [m("mira/example-large"), m("mira/example-small")],
  dsh: [m("vendor-a/model-large"), m("vendor-c/model-large")],
  pi: [m("vendor-a/model-large"), m("mira/example-large"), m("vendor-c/model-large"), m("vendor-d/auto")],
}

test("is a named plain plugin with Mirasim's picture: no agent or login provider", () => {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
  expect(pkg.main).toBe("./index.mjs")
  // Presentation metadata only; no provider or new agent is declared.
  expect(Object.keys(pkg.magpie).sort()).toEqual(["icon", "name"])
  expect(pkg.magpie.name).toBe("Mirasim–Magpie Harness Bridge")
  expect(pkg.magpie.icon).toMatch(/^data:image\/png;base64,/)
  expect(pkg.dependencies).toBeUndefined()
  expect(pkg.scripts.postinstall).toBeUndefined()
  expect(HARNESSES).toEqual(["claude", "codex", "dsh", "pi"])
})

test("the provider is magpie's gateway (its port from magpie's settings), every API declared, the plain key", () => {
  expect(gateway({ port: 3499 })).toEqual({ url: "http://127.0.0.1:3499", v1: "http://127.0.0.1:3499/v1" })
  const p = provider(gw)
  expect(p).toMatchObject({ id: PROVIDER_ID, kind: "anthropic", name: "magpie", baseURL: "http://127.0.0.1:3425" })
  expect(KEY).toBe("magpie")
  expect(p.credential).toEqual({ source: "command", argv: ["/bin/echo", "magpie"] })
  expect(p.wireOverride).toEqual({
    anthropicMessages: "present", responses: "present", chatCompletions: "present",
    anthropicBaseURL: gw.url, anthropicAuth: "bearer", openaiBaseURL: gw.v1,
  })
  expect(p.wire).toMatchObject({ ...p.wireOverride, responsesFields: "full" })
  expect(JSON.stringify(provider(gw))).toBe(JSON.stringify(p))
})

test("each model shows in exactly the harnesses whose own catalog has it: Codex never gets a model magpie keeps from Codex", () => {
  const want = profilesFor(catalogs)
  const agentsOf = id => want[profileId(id)].agents
  expect(agentsOf("vendor-a/model-large")).toEqual(["claude", "dsh", "pi"])
  expect(agentsOf("mira/example-large")).toEqual(["codex", "pi"])
  expect(agentsOf("mira/example-small")).toEqual(["codex"])
  expect(agentsOf("vendor-c/model-large")).toEqual(["dsh", "pi"])
  expect(agentsOf("vendor-d/auto")).toEqual(["pi"])
  expect(Object.keys(want).length).toBe(5)
})

test("a profile carries the gateway's facts: label, window, capped output, effort ladder, a sortable createdAt; ids are stable", () => {
  const p = profilesFor({ pi: [m("x/big", { context_window: 1000, max_output_tokens: 5000 })] })[profileId("x/big")]
  expect(p).toMatchObject({ name: "x/big · p", modelId: "x/big", providerId: PROVIDER_ID, contextWindow: 1000, maxOutputTokens: 1000, effort: null })
  expect(p.efforts).toEqual([{ id: "off", wire: "none" }, { id: "low" }, { id: "high" }])
  const order = Object.values(profilesFor(catalogs)).map(p => p.createdAt)
  expect([...order].sort()).toEqual(order)
  expect(profileId("vendor-a/model-small")).toBe(profileId("vendor-a/model-small"))
  expect(profileId("a/b")).toMatch(/^6d616770-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
  const ids = new Set()
  for (let i = 0; i < 2000; i++) ids.add(profileId(`provider-${i % 37}/model-${i}`))
  expect(ids.size).toBe(2000)
})

const user = { id: "u-1", providerId: "other", modelId: "deepseek", createdAt: "2026-10-21T00:00:00Z", agents: ["claude"] }
const settings = (extra = {}) => ({
  auth: { token: "keep-me" },
  models: { providers: { other: { id: "other" } }, profiles: { "u-1": user }, activeProfileByAgent: { claude: null } },
  ...extra,
})

test("puts the provider and the profiles in beside the user's, every other setting as it was; then writes nothing", () => {
  const next = withModels(settings(), provider(gw), profilesFor(catalogs))
  expect(next.auth).toEqual({ token: "keep-me" })
  expect(next.models.activeProfileByAgent).toEqual({ claude: null })
  expect(next.models.providers.other).toEqual({ id: "other" })
  expect(next.models.providers[PROVIDER_ID].baseURL).toBe(gw.url)
  expect(next.models.profiles["u-1"]).toEqual(user)
  expect(Object.keys(next.models.profiles).length).toBe(6)
  expect(withModels(next, provider(gw), profilesFor(catalogs))).toBeNull()
})

test("a model a harness's catalog drops leaves that harness in Mirasim, and Mirasim altogether when no catalog has it", () => {
  const once = withModels(settings(), provider(gw), profilesFor(catalogs))
  const next = withModels(once, provider(gw), profilesFor({ ...catalogs, codex: [m("mira/example-large")], pi: [m("vendor-a/model-large")] }))
  expect(next.models.profiles[profileId("mira/example-small")]).toBeUndefined()
  expect(next.models.profiles[profileId("vendor-d/auto")]).toBeUndefined()
  expect(next.models.profiles[profileId("mira/example-large")].agents).toEqual(["codex"])
})

test("taken out (no provider): the provider and every profile of the plugin go, the user's stay", () => {
  const once = withModels(settings(), provider(gw), profilesFor(catalogs))
  const back = withModels(once, null, {})
  expect(back.models.providers).toEqual({ other: { id: "other" } })
  expect(Object.keys(back.models.profiles)).toEqual(["u-1"])
})

const cache = { models: [{ slug: "example-large" }, { slug: "mira/example-large" }, { slug: "vendor-c/model-large" }, { slug: "vendor-d/auto" }, { slug: "vendor-c/model-large" }] }

test("Codex's menu loses the cache's magpie models, but no model of Codex's own nor one Mirasim lists as its own", () => {
  expect(codexNatives(cache, new Set(["example-large"]))).toEqual(["vendor-c/model-large", "vendor-d/auto"])
})

test("turning them off keeps the user's own choices, and a model the user had off stays theirs; nothing to hide puts them back", () => {
  const s = { modelEnablement: { codex: { off: ["gpt-5.6", "vendor-d/auto"] } }, keep: 1 }
  const r = withCodexOff(s, ["vendor-c/model-large", "vendor-d/auto"], [])
  expect(r.settings.modelEnablement.codex.off).toEqual(["gpt-5.6", "vendor-d/auto", "vendor-c/model-large"])
  expect(r.mine).toEqual(["vendor-c/model-large"])
  expect(r.settings.keep).toBe(1)
  expect(withCodexOff(r.settings, ["vendor-c/model-large", "vendor-d/auto"], r.mine).settings).toBeNull()
  expect(withCodexOff(r.settings, [], r.mine).settings.modelEnablement.codex.off).toEqual(["gpt-5.6", "vendor-d/auto"])
})

const patch = `- id: llm-pi-ai
  config:
    providers: {}
- id: agent-default-model # magpie
  config:
    provider: magpie-anthropic
    model: "vendor-c/model-large"
    reasoningEffort: "max"
- id: dsh-better-reasoning-effort
  config: {}
`
const START = '["magpie-anthropic","vendor-c/model-large","max"]'

test("reads the model DSH starts on from the DSH profile magpie wires", () => {
  expect(dshStart(patch)).toEqual(["magpie-anthropic", "vendor-c/model-large", "max"])
  expect(JSON.stringify(dshStart(patch))).toBe(START)
  expect(dshStart("- id: other\n")).toBeNull()
  expect(dshStart(undefined)).toBeNull()
})

test("DSH's start becomes one of the selections Mirasim knows, once, and only what the plugin put in comes out", () => {
  const ledger = { written: ['["local-example","example-model","max"]'] }
  const next = withLedger(ledger, START, null)
  expect(next.written).toEqual(['["local-example","example-model","max"]', START])
  expect(withLedger(next, START, null)).toBeNull()
  expect(withLedger(next, null, START).written).toEqual(['["local-example","example-model","max"]'])
  expect(withLedger(next, START, START)).toBeNull()
})

test("on or off in magpie: by the folder it was added from or by name, off when turned off or gone, unknown unread", () => {
  const dir = "/p/plugin"
  expect(pluginOn({ plugins: [{ spec: dir }] }, { dir })).toBe(true)
  expect(pluginOn({ plugins: [{ spec: dir, off: true }] }, { dir })).toBe(false)
  expect(pluginOn({ plugins: [{ spec: "other" }] }, { dir })).toBe(false)
  expect(pluginOn({ plugins: [{ spec: "magpie-mirasim@latest" }] }, { dir })).toBe(true)
  expect(pluginOn(undefined, { dir })).toBeUndefined()
})

test("a git installation belongs to the exact registered package and preserves an unknown state", () => {
  const dir = "/test/magpie/plugins/node_modules/magpie-mirasim"
  const spec = "github:example/magpie-mirasim-harness-bridge"
  const manifest = { dependencies: { "magpie-mirasim": spec } }
  const options = { dir, installedDir: dir, manifest }
  expect(pluginOn({ plugins: [{ spec }] }, options)).toBe(true)
  expect(pluginOn({ plugins: [{ spec, off: true }] }, options)).toBe(false)
  expect(pluginOn({ plugins: [] }, options)).toBe(false)
  expect(pluginOn({ plugins: [{ spec }] }, { ...options, manifest: undefined })).toBeUndefined()
  expect(pluginOn({ plugins: [{ spec }] }, { ...options, manifest: { dependencies: [] } })).toBeUndefined()
  expect(pluginOn({ plugins: [{ spec: null }] }, options)).toBeUndefined()
  expect(pluginOn({ plugins: [{ spec }] }, { ...options, dir: "/another/copy" })).toBe(false)
  expect(pluginOn({ plugins: [{ spec: "github:someone/another-plugin" }] }, options)).toBe(false)
})

function home() {
  const dir = mkdtempSync(join(tmpdir(), "mirasim-bridge-"))
  const paths = {
    setting: join(dir, "mirasim", "setting.json"), codexCache: join(dir, "codex.json"), dshPatch: join(dir, "dsh.yml"),
    dshLedger: join(dir, "ledger.json"), magpieSettings: join(dir, "magpie", "settings.json"),
    magpiePlugins: join(dir, "magpie", "plugins.json"), state: join(dir, "state", "state.json"),
    lock: join(dir, "state", "owner.json"),
  }
  mkdirSync(join(dir, "mirasim")); mkdirSync(join(dir, "magpie"))
  const s = settings({ modelEnablement: { codex: { off: ["gpt-5.6"] } } })
  writeFileSync(paths.setting, JSON.stringify(s, null, 2) + "\n"); chmodSync(paths.setting, 0o600)
  writeFileSync(paths.codexCache, JSON.stringify(cache))
  writeFileSync(paths.dshPatch, patch)
  writeFileSync(paths.dshLedger, JSON.stringify({ written: [] }))
  writeFileSync(paths.magpieSettings, JSON.stringify({ port: 3425 }))
  writeFileSync(paths.magpiePlugins, JSON.stringify({ plugins: [{ spec: dir }] }))
  return { dir, paths, before: readFileSync(paths.setting, "utf8"), ledgerBefore: readFileSync(paths.dshLedger, "utf8") }
}
const fakeFetch = (seen = []) => async (url, init) => {
  const h = init.headers.authorization.replace("Bearer magpie-", "")
  seen.push([url, h])
  return { ok: true, json: async () => ({ data: catalogs[h] }) }
}

test("a round against a gateway: each harness's own catalog asked, Mirasim written once, setting.json kept private", async () => {
  const { dir, paths } = home()
  const seen = []
  const b = new MirasimBridge({ paths, fetchImpl: fakeFetch(seen), dir })
  expect(await b.sync()).toEqual(["models", "codex menu", "dsh start"])
  expect(seen).toEqual(HARNESSES.map(h => [`${gw.url}/v1/models`, h]))
  const s = JSON.parse(readFileSync(paths.setting, "utf8"))
  expect(Object.keys(s.models.profiles).length).toBe(6)
  expect(s.models.providers[PROVIDER_ID].name).toBe("magpie")
  expect(s.modelEnablement.codex.off).toEqual(["gpt-5.6", "mira/example-large", "vendor-c/model-large", "vendor-d/auto"])
  expect(JSON.parse(readFileSync(paths.dshLedger, "utf8")).written).toEqual([START])
  expect(statSync(paths.setting).mode & 0o777).toBe(0o600)
  expect(await b.sync()).toEqual([])
})

test("a gateway that doesn't answer leaves Mirasim's models as they were", async () => {
  const { dir, paths } = home()
  await new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir }).sync()
  const before = readFileSync(paths.setting, "utf8")
  const down = async () => { throw new Error("ECONNREFUSED") }
  await new MirasimBridge({ paths, fetchImpl: down, dir }).sync()
  expect(readFileSync(paths.setting, "utf8")).toBe(before)
})

test("no Mirasim here: nothing is made", async () => {
  const { dir, paths } = home()
  require("node:fs").rmSync(paths.setting)
  expect(await new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir }).sync()).toEqual([])
  expect(existsSync(paths.setting)).toBe(false)
})

test("turned off in magpie, the host's exit puts Mirasim back exactly; a restart with it on leaves it", async () => {
  const { dir, paths, before, ledgerBefore } = home()
  const b = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir })
  await b.tick()
  b.exit() // still on: a restart, or magpie quitting
  expect(JSON.parse(readFileSync(paths.setting, "utf8")).models.providers[PROVIDER_ID]).toBeDefined()
  const next = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir }) // the host after the restart
  await next.tick()
  writeFileSync(paths.magpiePlugins, JSON.stringify({ plugins: [{ spec: dir, off: true }] }))
  next.exit()
  expect(JSON.parse(readFileSync(paths.setting, "utf8"))).toEqual(JSON.parse(before))
  expect(JSON.parse(readFileSync(paths.dshLedger, "utf8"))).toEqual(JSON.parse(ledgerBefore))
  expect(existsSync(paths.state)).toBe(false)
})

test("git-installed plugin stays installed across host exit and restores only when switched off", async () => {
  const { dir, paths, before, ledgerBefore } = home()
  const spec = "github:example/magpie-mirasim-harness-bridge"
  const installedDir = join(dir, "magpie", "plugins", "node_modules", "magpie-mirasim")
  mkdirSync(installedDir, { recursive: true })
  writeFileSync(join(dir, "magpie", "plugins", "package.json"), JSON.stringify({ dependencies: { "magpie-mirasim": spec } }))
  writeFileSync(paths.magpiePlugins, JSON.stringify({ plugins: [{ spec }] }))
  const b = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir: installedDir })
  await b.tick()
  b.exit()
  expect(JSON.parse(readFileSync(paths.setting, "utf8")).models.providers[PROVIDER_ID]).toBeDefined()
  const next = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir: installedDir })
  await next.tick()
  writeFileSync(paths.magpiePlugins, JSON.stringify({ plugins: [{ spec, off: true }] }))
  next.exit()
  expect(JSON.parse(readFileSync(paths.setting, "utf8"))).toEqual(JSON.parse(before))
  expect(JSON.parse(readFileSync(paths.dshLedger, "utf8"))).toEqual(JSON.parse(ledgerBefore))
})

test("an unreadable git installation manifest never triggers a destructive restore", async () => {
  const { dir, paths } = home()
  const spec = "github:example/magpie-mirasim-harness-bridge"
  const installedDir = join(dir, "magpie", "plugins", "node_modules", "magpie-mirasim")
  mkdirSync(installedDir, { recursive: true })
  writeFileSync(join(dir, "magpie", "plugins", "package.json"), "{incomplete")
  writeFileSync(paths.magpiePlugins, JSON.stringify({ plugins: [{ spec }] }))
  const b = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir: installedDir })
  await b.tick()
  b.exit()
  expect(JSON.parse(readFileSync(paths.setting, "utf8")).models.providers[PROVIDER_ID]).toBeDefined()
  expect(existsSync(paths.lock)).toBe(false)
})

test("removed from magpie, the same; a ledger entry Mirasim had already is not the plugin's to take", async () => {
  const { dir, paths } = home()
  writeFileSync(paths.dshLedger, JSON.stringify({ written: [START] }))
  const b = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir })
  await b.tick()
  writeFileSync(paths.magpiePlugins, JSON.stringify({ plugins: [] }))
  b.exit()
  expect(JSON.parse(readFileSync(paths.setting, "utf8")).models.providers[PROVIDER_ID]).toBeUndefined()
  expect(JSON.parse(readFileSync(paths.dshLedger, "utf8")).written).toEqual([START])
})

test("one instance keeps Mirasim: another (a command's host) leaves it alone, and its exit never puts Mirasim back", async () => {
  const { dir, paths } = home()
  paths.lock = join(dir, "state", "owner.json")
  const app = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir, pid: 101, isAlive: () => true })
  const cli = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir, pid: 202, isAlive: () => true })
  await app.tick()
  expect(app.owns()).toBe(true)
  const before = readFileSync(paths.setting, "utf8")
  writeFileSync(paths.magpiePlugins, JSON.stringify({ plugins: [] })) // removed: as a command's host would see it
  await cli.tick()
  cli.exit()
  expect(cli.owns()).toBe(false)
  expect(readFileSync(paths.setting, "utf8")).toBe(before)
  app.exit() // the app's host goes: it keeps Mirasim, so it puts Mirasim back, all of it
  const s = JSON.parse(readFileSync(paths.setting, "utf8"))
  expect(s.models.providers[PROVIDER_ID]).toBeUndefined()
  expect(s.modelEnablement.codex.off).toEqual(["gpt-5.6"])
  expect(existsSync(paths.lock)).toBe(false)
})

test("a holder gone (or silent) is taken over", async () => {
  const { dir, paths } = home()
  paths.lock = join(dir, "state", "owner.json")
  mkdirSync(join(dir, "state"), { recursive: true })
  writeFileSync(paths.lock, JSON.stringify({ pid: 999 }))
  const b = new MirasimBridge({ paths, fetchImpl: fakeFetch(), dir, pid: 101, isAlive: pid => pid !== 999 })
  await b.tick()
  expect(b.owns()).toBe(true)
  expect(JSON.parse(readFileSync(paths.setting, "utf8")).models.providers[PROVIDER_ID]).toBeDefined()
})
