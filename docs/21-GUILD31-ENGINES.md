# Guild 3.1 - more engines: OpenAI Codex first, Gemini next

Date: 2026-10-13. Owner decision recorded as D-066 in `docs/04-DECISION-LOG.md`. This document is the
implementation brief for Guild 3.1 part 1 (the generic multi-engine foundation and the Codex engine).
Facts marked **[spike]** were measured on this machine on 2026-10-13 with `@agentclientprotocol/codex-acp`
2.2.2 (bundled `@openai/codex` 0.160.1, native `codex-cli 0.160.1`), node 26.8.1, an existing ChatGPT
subscription login made by the owner with `codex login`, and the owner's real `~/.codex` configuration. The
spike scripts live outside the repository. Guild 3.0 stays as `docs/20-GUILD3-DUAL-ENGINE.md`; nothing there
changes for the Grok and Claude engines.

## 1. Goal

A task can run on a third engine, **OpenAI Codex** with the owner's ChatGPT subscription, next to Grok and Claude
Code, in the same window and with the same model picker, permission cards, browser pane and per-turn model line.
The work is split so a fourth engine (Gemini) is a small addition: the engine list, the picker groups, the per-engine
defaults, the settings section, the sidebar marker and the wording are driven by one engine registry instead of
`grok | claude` conditionals. Grok and Claude behave exactly as in 3.0.5.

## 2. Spike findings [spike]

The question was whether the Codex ACP adapter can use the ChatGPT subscription login that `codex login` already
made, headlessly, without Guild touching credentials. It can.

| Item | Fact |
|---|---|
| Package | `@agentclientprotocol/codex-acp` 2.2.2, `bin: codex-acp -> dist/index.js`. `files` is `dist/index.js` (one 1.7 MB bundle, its JavaScript dependencies inlined), `README.md`, `LICENSE`, `package.json`. Apache-2.0. |
| Codex core | The adapter does not talk to OpenAI itself. It starts `codex app-server` (JSON-RPC over stdio) and translates. It depends on `@openai/codex ^0.160.1`; npm installs the native Mach-O (`@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, 241 MB, plus `codex-code-mode-host`, 65 MB) into the adapter's own `node_modules` (346 MB in all). Without `CODEX_PATH` the adapter runs `process.execPath <resolved>/@openai/codex/bin/codex.js app-server`, a wrapper that only adds `CODEX_MANAGED_*` variables and spawns the native binary. With `CODEX_PATH=<native binary>` it spawns that binary directly. Both were run; both work. |
| Which codex | The owner's global `codex` (`~/.npm-global/bin/codex`, 0.160.0) is not used by the adapter. The login is shared because both read `~/.codex` (`auth.json`; Guild never opens it). |
| initialize | 0.1 s to 4 s. `agentCapabilities`: `loadSession`, `sessionCapabilities.{resume,list,close,delete,fork,additionalDirectories,subagents}`, `mcpCapabilities.{http:true,sse:false,acp:false}`, `promptCapabilities.{image,embeddedContext}`, `auth.logout`, `providers`, `_meta.authStatus`. `_meta.steering.supported: true`. |
| Auth methods | `authMethods` is `[api-key, chat-gpt]` even when logged in (the adapter does not shrink the list). **No `authenticate` call was needed**: a clean `env -i` process with only `HOME USER LOGNAME PATH` and the proxy variables created a session and ran turns on the subscription. Guild never calls `authenticate` for Codex. |
| Account | Out-of-session notification `_auth/status_update {authStatus:{kind:"account", label:"ChatGPT Plus", account:{email, plan:"plus"}}}` (same wire as the Claude adapter). Other kinds the adapter source defines: `api_key` ("OpenAI API key"), `gateway`, `external` ("AWS Bedrock"), `none` ("Not logged in"). The e-mail is never read by Guild. |
| Not logged in | With an empty `CODEX_HOME`, `initialize` still succeeds and `session/new` fails with JSON-RPC `-32000` "Authentication required" (ACP `authRequired`), no `_auth/status_update`. |
| session/new | Result keys `sessionId, models, modes, configOptions`; 1 s to 3.3 s. Config options (select unless noted): `mode` (category `mode`: `read-only` "Read-only", `workspace-write` "Workspace access", `agent` "Auto review", `agent-full-access` "Full access"; initial `agent`), `collaboration_mode` (category `collaboration_mode`: `default`, `plan`), `model` (category `model`: seven ids on this account, such as `gpt-6.1-sol`, `gpt-6-luna`, `gpt-5.6-luna`; current = the owner's `config.toml` default), `reasoning_effort` (category `thought_level`: `low medium high xhigh max ultra`, the list is rebuilt for the selected model: the Luna models end at `max`), `fast-mode` (category `model_config`, `off`/`on`). |
| Model ids | Bare ids in `configOptions` (`gpt-6.1-sol`). The legacy `models.availableModels` list repeats every model once per effort as `gpt-6.1-sol[low]`; it is the only place that tells a model's efforts before that model is selected. |
| Cheapest model | `gpt-5.6-luna` ("Older fast and efficient model") with effort `low`; used for every spike turn. |
| Resume | Killing the adapter and calling `session/resume` (or `session/load`, which replays the history as `user_message_chunk` / `agent_message_chunk` / `tool_call` before its result) with the same `sessionId` continues the conversation (the model recalled the file it created). **The resumed session does not restore the model, the effort or the mode**: it came back on `gpt-6.1-sol`, effort `high`, mode `agent`. Guild applies the stored selection and permission mode after every start, before the first prompt. |
| Missing session | `session/resume` of an unknown id answers `-32603` "Internal error" with `data.details` "no rollout found for thread id ..."; a malformed id answers `-32603` "invalid session id". Not `-32002`. The Codex dialect classifies the first as "session not found". |
| Permissions | `session/request_permission` toolCall `{kind:"execute"\|"edit"\|..., title:"Run command"\|"Edit files", rawInput, locations?}`. Option kinds seen: command `allow_once` "Yes, proceed", `allow_always` "Yes, and don't ask again for commands that start with `...`" (id `accept_execpolicy_amendment`, **writes a persistent rule into the user's Codex rules**), `reject_once` "No, and tell Codex what to do differently" (id `cancel`); file edit `allow_once`, `allow_always` ("don't ask again for these files", id `allow_for_session`), `reject_once`; MCP tool `allow_once` "Allow", `allow_always` "Allow for this session" (id `allow_session`), `allow_always` "Always allow" (id `allow_always`), `reject_once` "Cancel". |
| When it asks | Observed: `read-only` asked for a file edit and for commands; `workspace-write` asked for an MCP tool call (it did not ask for a command that wrote inside the workspace in the two runs made); `agent` (Auto review) sent no request for an MCP call but a "Guardian Review" tool call (`kind: think`, text "Status: Approved ... Rationale: ...") showing an automated reviewer's decision; `agent-full-access` ran a shell loop with no request. |
| Reject / cancel | `reject_once` on a command or edit ended the turn with `stopReason: "cancelled"`; on an MCP call the tool failed ("user cancelled MCP tool call") and the turn went on (`end_turn`). A permission answered with the ACP `cancelled` outcome ended the turn `cancelled`. |
| Tool calls | `tool_call` / `tool_call_update` with `kind: execute` (content `{type:"terminal", terminalId}` and `_meta.terminal_info`, `_meta.terminal_exit`), `edit` (content `{type:"diff", path, oldText, newText}`), `think` (guardian review), MCP calls (`title: "mcp.<server>.<tool>"`, `rawInput {server, tool, arguments}`, `_meta.is_mcp_tool_call`). Without the client `terminal` capability the adapter still sends `terminal` content. |
| Turn frames | `session_info_update` with `_meta.codex.threadStatus {type:"active"\|"idle", activeFlags:["waitingOnApproval"]}` and, once, the title; `agent_thought_chunk`, `agent_message_chunk`, `usage_update {used, size}` (context tokens used and window, 258400 here), `available_commands_update` (57 commands at start, 220 after the first turn: built-in `plan mcp skills status review review-branch review-commit compact goal rename logout` plus every skill as `$name` or `$plugin:name`). |
| Prompt result | `{stopReason, usage:{totalTokens, inputTokens, cachedReadTokens, cachedWriteTokens, outputTokens, thoughtTokens}, _meta:{quota:{token_count, model_usage:[{model, token_count}]}}}`. `model_usage[0].model` names the model that answered. |
| Late frames | After the prompt result: `available_commands_update` every time; after a cancel also the `tool_call_update` frames of the still running command. They must be applied as session metadata or dropped, never open an agent-initiated Run (same rule as Claude, `late_update_dropped`). |
| Cancel | `session/cancel` (a notification) answers the pending prompt within 25 ms with `stopReason: "cancelled"`, and the session accepts the next prompt at once. **A foreground shell command Codex started is not stopped by it**: `for i in $(seq 1 120); do date +%s >> beat.txt; sleep 1; done` kept appending after the cancelled result, until the adapter process group was killed (Guild's process host does that on close and quit; the command died with it). Codex has a targeted stop (`_session/async_task/stop`) only for clients that negotiate the AIR `asyncTasks` capability. Guild does not in 3.1; the reduced state is documented (section 4.8). |
| Steering | `_session/steering {sessionId, prompt, _meta:{steering:{idleBehavior:"promptRequired"}}}` -> `{outcome:"injected"}` during a turn (the final reply obeyed the injected instruction). **Codex ignores `idleBehavior`**: with no turn running it answers `{outcome:"startedNewTurn"}` and runs the text as a new turn. Guild therefore never asks while its own prompt is not in flight, and cancels a turn it did not start. |
| Fork | `session/fork {sessionId, cwd, mcpServers}` -> `{sessionId, modes, configOptions}`; the fork knew the earlier conversation. |
| HTTP MCP | `mcpServers: [{type:"http", name, url, headers:[]}]` in `session/new` works; the Codex app-server (not the adapter) connects (`initialize`, `notifications/initialized`, `tools/list`, `tools/call` over POST with `Accept: text/event-stream, application/json`; the JSON response form is accepted). The loopback URL needs `NO_PROXY=127.0.0.1,localhost` in the adapter's environment. |
| Unknown methods | `_guild/ping` answers `-32601`; the liveness probe treats it as alive. `session/list` lists the owner's own Codex sessions: Guild never calls it. |
| Process tree | `node adapter -> [node codex.js] -> codex native (same process group)`, then, each in its own process group, every MCP server and plugin helper of the owner's `~/.codex/config.toml` (computer-use, node_repl, a Schwab connector, the OpenViking proxy ...) and every shell command. The helper sweep of `docs/20` 3.2 (descendants outside the group, identity-checked) is the mechanism that covers them. After the spike clients signalled the process group, none of the helper processes looked for (the MCP servers, `sleep`) was left running. |
| OpenViking | The owner's Codex has the OpenViking memory plugin; its hooks (`SessionStart`, `UserPromptSubmit`, `Stop` ...) are loaded by adapter sessions (the app-server log lists them), so spike turns may have been captured into the memory store. For the Codex plugin `OPENVIKING_MEMORY_ENABLED` **has no effect** (its own doctor says so); the switches are `OPENVIKING_AUTO_RECALL=false` and `OPENVIKING_AUTO_CAPTURE=false`. Guild sets both and the Grok block (config files to `/dev/null`, URLs to a closed loopback port). |
| Persona and config | Codex loads the owner's `~/.codex/AGENTS.md`, `config.toml` (plugins, MCP servers, hooks) and skills exactly as the owner's own `codex` does; Guild does not isolate them. |
| Latency | A model turn of one word took 6 s to 58 s through the owner's proxy; the adapter itself is quick (initialize and session start under 5 s). The start windows of the Claude adapter (`docs/20` 3.2) are reused with a smaller bound (180 s). |

Not tested, so not claimed: image prompts, `plan` collaboration mode, `fast-mode`, subagent sessions, `/goal`.

## 3. Foundation: N engines

### 3.1 Engine registry (contracts)
`GUILD_ENGINES = ["grok", "claude", "codex"]`. The model groups become `grok | claude | codex | online | local`
(`codex` is the group of the Codex engine, named "ChatGPT" in the picker). One descriptor per engine holds what the rest
of the code used to infer from the engine's name: its picker groups, its marker letter for the sidebar (`G`, `C`, `X`),
whether it is an *add-on engine* and, for those, the permission modes it offers. **Add-on engines** are the engines that
are neither Grok nor Claude: a user-installed ACP adapter with the user's own login, no model router, no Online or Local
models, Guild-level defaults stored per engine. `codex` is the first; Gemini is the second.

### 3.2 Schema 21 (forward-only)
Guild 3.0.x databases (schema 19 and 20) migrate on open.
1. `task_metadata.engine` and `runtime_model_catalog.engine` stop listing engine names in a CHECK: they accept a
   lowercase identifier (`^[a-z][a-z0-9]{1,15}$`), and the application's engine registry is the allowlist. Adding an
   engine is then not a schema change. SQLite cannot alter a CHECK, so both tables are rebuilt (the standard twelve step
   procedure with `foreign_keys` off during the rebuild and `foreign_key_check` before commit); the indexes and the
   triggers of `task_metadata` are recreated byte for byte, `routed_at_ms` stays legal only on a Claude task.
2. The two triggers that keep a task's runtime model in its engine's grammar treat every engine but Grok as the wider
   grammar (`COALESCE(engine, 'grok') = 'grok'` is the strict case).
3. `engine_defaults(engine PRIMARY KEY, model, effort, permission_mode)` holds the Guild-level defaults of the add-on
   engines. A missing row means "follow the engine's own default, permission mode `workspace-write`" (the first add-on
   engine's value; each engine states its own).
4. A task bound to an engine the build does not know (a database written by a later Guild) cannot be created; reading
   one fails closed with the existing integrity error.

### 3.3 Everything else keyed by engine
Catalog cache rows, model-picker catalogs (`modelCatalogs`), the Engines settings section, the sidebar marker, the
locale wording of a task's conversation, the process profile and the runtime factory are all looked up by engine. The
Claude-only machinery (router, native and routed processes, `modelPicker`, OpenViking capture policy) stays Claude's.

## 4. The Codex engine

### 4.1 Process
- Executable: the user's `node` (>= 22, pinned per launch exactly like the Claude engine: first supported node of the
  launch, SHA-256 compared before every run) running the adapter's `dist/index.js`.
- Locator: `codex-acp` from `~/.npm-global/bin`, the user's PATH and the Homebrew paths; supported adapter versions
  `>=2.0.0 <3.0.0`; the pin is the package version plus a SHA-256 over `package.json` and every file under `dist/`, as for
  Claude; a mismatch refuses to start (`adapter_changed`) and a later locate accepts only an update.
- Bundled core: found from the adapter's package root the way Node resolves it (its own `node_modules`, then the
  ancestors'), `@openai/codex-<platform>-<arch>/vendor/<triple>/bin/codex`, a real Mach-O whose version is read from the
  neighbouring `codex-package.json` (never by running it). It is pinned by real path, version and size (241 MB is not
  hashed at every spawn, like the 200 MB `claude`), handed to the adapter as `CODEX_PATH`, so the binary Guild checked is
  the binary that runs. A locate after a failed check accepts a core only when the adapter's version changed.
- Environment: the Claude allowlist (PATH, LANG, LC_*, TMPDIR, proxy and SSL variables, `USER`, `LOGNAME`;
  `NO_PROXY=127.0.0.1,localhost` always), no inherited `CODEX_*` or `OPENAI_*` variable, so `CODEX_HOME` is never
  redirected and no API key can reach the adapter. Guild-owned values: `CODEX_PATH`, `OPENVIKING_AUTO_RECALL=false`,
  `OPENVIKING_AUTO_CAPTURE=false` and the Grok OpenViking block (docs/20 3.6 for the policy: Claude Code and Codex are
  the engines OpenViking is meant for, but a Guild Codex session neither reads nor writes the store).
- Start windows: `initialize` and `session/new|resume|load` wait up to 180 s; a request without an answer is
  `request_timeout` (the session is kept, the send says Codex is still starting), a process that dies before answering a
  resume does not lose the session. Only the missing-session answer of section 2 ends in `restore_failed`.
- No model router. Codex talks to OpenAI itself; the Online reminder and the router never apply to a Codex task.

### 4.2 Login
Guild never reads `~/.codex` and never calls `authenticate`. A Codex that is not logged in fails `session/new` with
`-32000`; Settings > Engines then says "Not logged in. Run `codex login` in Terminal." The account line shows the
adapter's ChatGPT plan label (for example "ChatGPT Plus") when the adapter reports a ChatGPT account, and "Managed by
Codex" for any other kind. There is no API key field.

### 4.3 Models and effort
The picker group "ChatGPT (subscription)" lists the models of the `model` config option. The efforts of every model come
from `models.availableModels` (`id[effort]`), the effort of the selected model from the `reasoning_effort` option; both
are applied with `session/set_config_option`, model first. The strongest-first order of the efforts knows `ultra`.
Before any Codex session exists the group offers one row, "Codex (default model)", which binds a new task to Codex and
follows Codex's own default (same rule as Claude Code's first run). `fast-mode` and `collaboration_mode` are not shown.
After every start (new, resume, load) the stored selection is applied before the first prompt, because a resumed
session forgets it (section 2); a model the session does not offer refuses the prompt (`model_selection_failed`).
Clearing a task's own model pins nothing: the live session keeps the model it runs (the projection says so, as for Grok) and
a session that starts afterwards runs on Codex's own pick or the Settings default.

### 4.4 Permission mode
Guild's selector shows the four adapter modes with its own Chinese and English wording: Read-only, Workspace access
(default), Auto review, Full access. The mode is a config option, applied after every session start and before every
turn, and a failed change refuses the turn: a resumed session comes back in `agent` (Auto review) and must never run
looser than the setting. Permission cards use the 3.0.2 labels by ACP kind; an "always" option keeps the agent's own
words unless they say "session", so the persistent-rule option of a command reads as the agent wrote it.

### 4.5 Browser pane
The browser MCP server is handed to `session/new|resume|load` when `initialize` advertised `mcpCapabilities.http`.

### 4.6 Steer, queue, fork, rewind
Steer maps to `_session/steering` and is attempted only while Guild's own prompt is in flight; `injected` is success,
`promptRequired` (Guild-side, no wire call) and `failed` fall back to an ordinary message, and `startedNewTurn` (a race:
the turn ended while the request was in flight) cancels the turn Codex started and falls back as well. Queued messages
are Guild's own queue. Branch copies Guild's local transcript and starts a new Codex session (as for Claude).
Conversation rewind is files only (Codex has no conversation rewind through ACP).

### 4.7 Usage and account
The usage panel shows the context ring from `usage_update` and "Quota: managed by Codex". The per-turn model line
(3.0.2) shows the display name of the model the Run started on.

### 4.8 Reduced states (PC-FALLBACK-001)
Not installed (adapter or its bundled core missing, unsupported adapter major): the command `npm install -g
@agentclientprotocol/codex-acp`. Not logged in: `codex login`. Changed files: the existing integrity text, naming
`codex-acp`. **Stop** ends the turn but a foreground shell command Codex already started may keep running until the
task's process closes; the Stop help text for a Codex task says so. A turn Codex runs on its own after a cancel is
cancelled, never shown.

## 5. Acceptance (installed app)
1. A fresh Codex task: the picker's "ChatGPT" group lists the account's models, the cheapest is chosen, one turn runs a
   tool behind a permission card, the footer names the model.
2. Quit and reopen Guild; the task resumes (the stored model and permission mode are applied before the next turn).
3. The sidebar shows the task with the Codex marker; Settings > Engines shows the Codex section and its status.
4. Grok and Claude tasks behave as in 3.0.5.

Automated as check I of `scripts/run-guild3-qa.mjs` (run with `GUILD_QA_CODEX_ACP=<codex-acp package directory>`, which the script
hands to the unpackaged app as the dev-only `GUILD_DEV_CODEX_ACP`; a packaged app ignores it, and the locator pins whatever it
finds there like any other install). It uses a fresh isolated data directory, the cheapest model of the account (the first
`Luna` entry of the list, effort low), the `read-only` mode so that a shell write needs approval, decides the card through the
UI, then quits and relaunches Guild and sends a second turn. It asserts: the ChatGPT group lists every model the account
reports, the card appears and clears, the file is written, the footer and the stored label name the model, the adapter process
has `CODEX_PATH` set, the OpenViking switches off and no Anthropic or OpenAI variable, the sidebar shows the `X` marker next
to the Grok and Claude markers, the account card is Codex's (plan label only when reported), Settings > Engines shows the Codex
section, the same Codex rollout holds both turns after the restart, and the mode and model are applied again before the
second turn. The rollouts the run created (those naming its workspace) are removed at the end; Codex's own index and database
rows for them are left alone.

## 6. What the owner installs
`npm install -g @agentclientprotocol/codex-acp` (Node >= 22 already on PATH; the package brings its own Codex core), and
`codex login` once if `codex` is not logged in (it is, on this machine).
