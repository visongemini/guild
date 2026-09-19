# Grok Build 1.0.13 capability-to-GUI inventory

Date: 2026-08-29
Observed binary: `grok 1.0.13 (5e9a58528b76)`
Guild candidate: 2.0.11

This inventory is based on the installed official binary's `--help`, subcommand help,
`inspect --json`, and a live ACP `initialize` + `session/new` negotiation. It describes the
current machine, not an eternal promise about later Grok releases.

## Exposed as native Guild controls

| Official capability | Official surface | Guild 2.0.11 |
| --- | --- | --- |
| Grok model | `--model`, ACP `session/set_model` | Grok 4.6 / 4.5 selector; external providers remain deliberately excluded |
| Reasoning effort | `--reasoning-effort`, ACP mode | Verified effort selector per model |
| Permission policy | `--permission-mode` | All six official modes: default, acceptEdits, auto, dontAsk, bypassPermissions, plan |
| Web search | `--disable-web-search` | Persisted new-session toggle |
| Planning | `--no-plan` | Persisted new-session toggle |
| Subagents | `--no-subagents` | Persisted new-session toggle |
| Maximum turns | `--max-turns` | Persisted bounded selector, including unlimited |
| Dynamic session options | ACP `configOptions` + `session/set_config_option` | Boolean and select controls are generated from the active official session; invented values are rejected |
| Official slash commands | ACP `available_commands_update` | Instant bundled core catalogue, then the complete live official list replaces it |
| Context usage | ACP usage update / prompt metadata | Ring in the composer; exact tokens appear on click when reported |
| Tool activity, thought, plan, permission | ACP session updates | Collapsed activity groups with tool-kind icons and explicit approval UI |
| Session continuity | ACP `session/resume` / `session/load` | Restores the official session when advertised, otherwise asks before replacement |
| Stop | ACP `session/cancel` | Durable cancellation and bounded forced recovery |
| Account usage | official `_x.ai/billing` extension | Read only on demand from the profile popover; Guild never estimates |

## Exposed through the official command catalogue

The live ACP command list is authoritative and includes core commands, installed plugins, skills,
workflows, and locally configured extensions. Guild does not hard-code personal skill names. Core
commands are available immediately so typing `/` never waits for a runtime round trip; after the
session connects, the official list replaces the fallback.

Verified core commands include `/compact`, `/always-approve`, `/flush`, `/dream`, `/memory`,
`/context`, hook management, `/plugins`, `/session-info`, `/feedback`, `/deep-research`,
`/workflow`, `/goal`, and `/loop`.

## Exposed as task/client features

| Capability | Guild surface |
| --- | --- |
| Conversation search | Local title and full-transcript search |
| Conversation export | Owner-selected local Markdown or JSON file |
| Branch from a conversation | Clearly labelled local transcript snapshot plus a new official Grok session |
| Task files and review | Task workbench built from official tool locations and diffs |
| Workspace terminal | Explicit user click only |
| Rename, pin, archive, restore, delete | Task context menu |

The current branch action is deliberately **not** described as an exact upstream fork. ACP defines
an unstable `session/fork` method, but the installed Grok 1.0.13 process did not advertise it in the
2026-09-01 initialization probe. Guild therefore does not call that method. The local transcript
snapshot plus new official Grok session disclosure is the truthful available behavior.

## Not copied into the GUI

These flags exist because Grok Build is also a terminal/headless/developer product, but they do not
represent missing GUI settings:

- terminal rendering: `--fullscreen`, `--minimal`, `--no-alt-screen`;
- headless serialization: `--output-format`, `--json-schema`, `--include-partial-messages`,
  `--single`, `--prompt-file`, `--prompt-json`, `--verbatim`;
- transport/developer overrides: `agent serve`, relay URLs, proxy base URLs, debug files, leader
  sockets;
- shell completions and clipboard wrapper;
- raw session IDs and command-line resume syntax, because Guild owns that mapping in its task store.

Guild also does not expose a shared server or OpenAI-compatible gateway, does not read
`~/.grok/auth.json`, and does not offer external-model adapters. Those exclusions are product and
security boundaries, not hidden Grok features.

## Administrative surfaces exposed in 2.0.11

The Grok Build feature center gives `mcp`, `plugin` and marketplace management, `memory`, `sessions`,
`export`, `trace`, `worktree`, `update`, `setup`, `leader`, `doctor`, `inspect`, `du`, `clone`,
login/logout, version and model discovery their own bilingual forms. The action catalogue is tested
against the main-process allowlist so a newly added allowlisted action cannot silently lack GUI.
Every field is bounded and the main process rejects extra parameter keys. Destructive operations
such as logout, memory clear, plugin uninstall, remote trace upload, worktree removal, setup/update,
MCP command registration, and leader termination require a second explicit confirmation. Management
is available only when a task workspace is selected and all tasks and queued turns are idle; it
closes retained ACP processes, owns one official command at a time, never uses Guild's application
data directory as a workspace, and cannot survive Guild shutdown.

The model-discovery result filters out locally configured external providers. This is intentional:
Guild remains an official-Grok-only client even if the user's standalone TUI has extra provider
configuration. Server/relay/headless/rendering/debug/shell-integration flags remain excluded by the
client boundary described above.
