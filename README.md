# Magpie–Mirasim Harness Bridge

**magpie-mirasim-harness-bridge** connects the agents inside Mirasim to their
corresponding Magpie model catalogs. It is a Magpie background plugin, not a
new Mirasim agent or a login provider.

Mirasim runs Claude Code, Codex, DSH and Pi: the same agents magpie already
wires. This plugin is no agent of its own. It lets each of them, inside
Mirasim, use what magpie gives that agent, and keeps magpie's wiring of them
out of Mirasim's own route.

Mirasim 里跑的 Claude Code、Codex、DSH、Pi，就是 magpie 已经接好的那几个
agent。这个插件不是新的 agent：它让 Mirasim 里的每个 harness 用 magpie 给
该 agent 的模型，并且不让 magpie 对它们的接线串进 Mirasim 自己的线路。

## What it does

| | |
| --- | --- |
| Models | Claude Code in Mirasim lists what magpie gives Claude Code (`magpie models claude`), Codex what it gives Codex, DSH and Pi likewise, under the provider **magpie**. Tick or hide a model for an agent in magpie and Mirasim follows within seconds. Mira Bot runs on Claude Code: its Settings › Model lists Claude Code's. |
| Route | A magpie model runs straight at the gateway, never through Mirasim's relay, on either of Mirasim's routes. Mirasim's own models keep going to its relay. |
| Codex | Codex's own model cache (`~/.codex`, which Mirasim shares) holds magpie's catalog too; on Mirasim's route those rows went to its relay, which refuses them. They are turned off in Mirasim's Codex menu (your own choices kept); the same models come as magpie's. |
| DSH | magpie's wiring of DSH sets the model DSH starts on, in a file Mirasim's DSH sessions share; Mirasim, taking that start for DSH's own default, left its own route's DSH on magpie's model. The start is recorded as one Mirasim selected, so Mirasim puts DSH on its own model. DSH runs only models DSH itself has, which are those magpie's DSH connection registers: exactly DSH's catalog. |
| MCP, skills, instructions | Mirasim's harnesses read the machine's own (`~/.claude`, `~/.codex`, `~/.dsh`, `~/.pi`): manage them in magpie's Library as Claude Code, Codex, DSH and Pi, and Mirasim follows. |
| Usage | Requests count as the harness's own in magpie (claude, dsh, pi); Codex as mirasim, the name Mirasim gives the Codex it starts. |

Turn the plugin off or remove it and Mirasim is put back as magpie's plugin
host goes: the provider and its models out, the Codex rows back, the DSH
record taken out if the plugin put it in. Nothing else is touched.

## How

`index.mjs` starts `adapter.mjs` in magpie's plugin host (Bun); it registers
nothing with magpie. Every 5 s it reads each agent's catalog at the gateway
(`/v1/models`, `Bearer magpie-<agent>`) and writes Mirasim's
`~/.mirasim/setting.json`: one provider (`models.providers.6d616770-…`, every
API declared so Mirasim needn't probe) and one profile per model listing the
harnesses whose catalog has it (stable ids from the model id, so a model
picked somewhere stays picked). Each round writes only what differs and a
gateway that doesn't answer leaves things as they are. What it changed of
Mirasim's own choices is kept in `~/.config/magpie-mirasim/state.json`, to put
back. magpie loads plugins in its app's host and, for a moment, in a host each
of its commands starts; only one instance keeps Mirasim (`owner.json`, renewed
every round, taken over when its holder is gone or 30 s silent), so a command's
host never writes Mirasim or puts it back.

## Install

```sh
magpie plugin add github:SammySnake-d/magpie-mirasim-harness-bridge
```

Alternatively, clone this repository and add its local directory with
`magpie plugin add /absolute/path/to/checkout`. The GitHub repository is the
release source; this project is not published to npm.

This plugin changes Mirasim's local model configuration and its own small
restore ledger. Review the paths in **How** and back up your Mirasim settings
before use. It talks to the loopback Magpie gateway at the port saved in
Magpie settings and uses Magpie's standard local `magpie` credential. Gateway
address or authentication overrides that do not accept those defaults are not
supported by this version. It does not upload your settings to this repository.

The plugin host loads it when it next starts (after an add, at the next
request to a plugin). Code changed later loads after `magpie plugin off
<path>` and `on`.

## Limits

- Mirasim refuses to *add* a model of your own past 50 profiles; magpie's count
  toward them. Hide models for Pi in magpie to make room.
- It runs while magpie's plugin host does. Quit magpie and Mirasim's magpie
  models fail, as every agent wired to magpie.
- The DSH and Codex fixes lean on how Mirasim 0.0.724 decides; a Mirasim that
  decides otherwise leaves them doing nothing, not harm.

## Test

`bun test`: catalogs per harness, the user's providers, profiles and
settings left alone, Codex's menu, DSH's start, a round against a gateway, and
off or removed putting Mirasim back exactly. The tests use isolated fixtures;
they do not certify compatibility with every Mirasim or Magpie release.
