import { MirasimBridge } from "./adapter.mjs"

// magpie's plugin host loads this beside every other plugin; one bridge per
// host, however often the host calls it. It registers nothing with magpie:
// it only keeps Mirasim in step with magpie's wiring of each harness.
const instance = Symbol.for("magpie.mirasim.bridge.v1")

export default async function Mirasim(input) {
  if (!globalThis[instance]) {
    const log = message => {
      try {
        void input?.client?.app?.log?.({ body: { service: "mirasim", level: "info", message } })?.catch?.(() => {})
      } catch {}
    }
    const bridge = new MirasimBridge({ log }).start()
    globalThis[instance] = bridge
    // The host owns shutdown and its exit is synchronous; never install
    // signal handlers or end a host shared with other plugins.
    process.once("exit", () => bridge.exit())
  }
  return {}
}
