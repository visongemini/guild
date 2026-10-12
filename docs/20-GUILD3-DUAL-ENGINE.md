# Guild 3.0 — Claude Code engine, model sources, browser pane

Date: 2026-10-12, amended 2026-10-13. Owner decision recorded as D-057..D-062 in `docs/04-DECISION-LOG.md`.
This document is the implementation brief for every work package (WP). Read it fully before
changing code. Facts marked **[spike]** were verified on this machine on 2026-10-12 with
`@agentclientprotocol/claude-agent-acp` 0.89.1 (Agent SDK 0.3.293) and `claude` 2.1.291 (the
subscription-token row was re-verified with `claude` 2.1.296); the spike scripts live outside the
repository.

## 1. Goal

One Guild window, two engines:

- **Grok engine**: unchanged official `grok agent stdio`.
- **Claude engine**: the user-installed ACP adapter `claude-agent-acp` (Node script) driving the
  user-installed `claude` binary through the Agent SDK. The user's existing claude.ai subscription
  login (Keychain) is used as is; Guild never reads it.

Inside a Claude task the model picker switches, between turns and inside the same conversation,
among three groups: **Claude (subscription)**, **Online** (vendor Anthropic-compatible endpoints such
as DeepSeek) and **Local** (llama.cpp / Ollama `/v1/messages`). The switch is two-way: a Claude model runs in
a native process, an Online or Local model in a routed one, and a switch that crosses between them restarts
the engine process and resumes the same session; the Claude subscription login never goes through the router
(3.3, D-062). A new task's picker also shows the **Grok** group; the group chosen for the first turn
fixes the task's engine (PC-TASK-001: no silent rebinding).

Plus an isolated **browser pane** in the workbench, controllable by the agent through a loopback MCP
server.

## 2. Verified protocol facts [spike]

| Item | Fact |
|---|---|
| initialize | `authMethods: []` when `claude` is logged in. `agentCapabilities`: `loadSession`, `sessionCapabilities.{resume,list,fork,close,delete,additionalDirectories,subagents}`, `mcpCapabilities.{http,sse}`, `promptCapabilities.{image,embeddedContext}`, `_meta.claudeCode.promptQueueing: true`. Notifications `_auth/status_update` arrive outside sessions. |
| Config options | `mode` (category `mode`: default, acceptEdits, plan, auto, bypassPermissions), `model` (category `model`: default, opus, fable, sonnet, haiku, plus explicit ids), `effort` (category `thought_level`: default, low, medium, high, xhigh, max), `fast` (category `model_config`: on/off). Set with `session/set_config_option {sessionId, configId, value}`. |
| Slash commands | 147-156 entries via `available_commands_update` (Guild cap 512 is enough). |
| Late frames | After the `session/prompt` response the adapter still sends `session_info_update` (title) and sometimes `available_commands_update`. They must be applied as session metadata and must NOT open an agent-initiated Run. |
| Unknown methods | `_guild/ping` answers JSON-RPC `-32601`. Treat -32601 as "alive" for the liveness probe. |
| Resume | Killing the adapter and calling `session/resume` with the same `sessionId` continues the conversation (also across model switches). |
| Model switch | `set_config_option model=<value>` mid-session works (haiku -> sonnet, sonnet -> deepseek etc.). Values must be in the option list. |
| Extra models | Passing `_meta: {claudeCode: {options: {settings: {modelPicker: {options: [{model, label}]}}}}}` in `session/new` / `session/resume` adds those ids to the `model` option list. (Gateway discovery via `/v1/models` did NOT trigger in SDK mode.) |
| Env | The adapter passes its own process env to the spawned `claude`. `CLAUDE_CODE_EXECUTABLE` selects the binary. |
| OpenViking | Recall works inside ACP sessions. `OPENVIKING_AUTO_CAPTURE=false` disables capture and the write hooks while keeping recall (plugin 0.4.4 `config.mjs` envBool). |
| Gateway mode | With `ANTHROPIC_BASE_URL` set, Claude Code disables tool search and sends every tool inline (475 tools, 846 KB on this machine). `ENABLE_TOOL_SEARCH=true` restores deferred loading (11-15 tools per request). |
| Request shape | Claude Code sends API features plain Anthropic-compatible backends reject: messages with `role: "system"`, content blocks `{type:"tool_addition", tool:{type:"tool_definition", definition:{name,description,input_schema}}}`, tools with `defer_loading`, top-level `context_management` and `output_config`. DeepSeek returned 422 until these were normalized. |
| Tool results | DeepSeek enforces "tool_result immediately after tool_use": any text injected into a user message must come after its `tool_result` blocks. |
| Thinking | Cross-vendor thinking blocks: dropping blocks whose signature was not produced by the target vendor kept every request at 200. Local llama.cpp returns thinking with an empty signature. |
| llama.cpp SSE | Not conformant: it opens the text block (index 1) before closing the thinking block (index 0) and sends block 0's `signature_delta` after text started. Claude Code then duplicated the reply text. The router must re-sequence local streams. |
| Subscription token | With only `ANTHROPIC_BASE_URL` (no token), requests reach the router with `Authorization: Bearer sk-ant-oat...`, Claude Code's own subscription token. With `ANTHROPIC_AUTH_TOKEN=<dummy>` also set (`claude` 2.1.296, clean environment) Claude Code sends only `Authorization: Bearer <dummy>` and the subscription token never leaves it. Anthropic's rules forbid intermediating the token, so Guild never lets it reach the router (D-061, section 3.3). |
| Native resume after routed turns | `claude -p --resume <id>` run natively (no `ANTHROPIC_BASE_URL`, the subscription login, straight to `api.anthropic.com`) continues a session whose history contains DeepSeek turns, a DeepSeek thinking block included, with both Haiku and Opus 5.5 (`claude` 2.1.296, clean environment). So the way back to Claude needs no router (D-062). The adapter restores the model of the transcript's last turn on resume (`resumedModelHint`, 0.89.1), so after routed turns a native session reports an id its own model list does not offer; Guild applies the selected Claude model before the first turn. |
| Browser MCP | An HTTP MCP server passed in `mcpServers` (`{type:"http", name, url, headers:[]}`) is used by Claude; each tool call produces a `session/request_permission` (permission card). The client first sends `server/discover` (answer -32601 or a valid result). `webContents.capturePage()` fails with "Current display surface not available" when the window is not visible; CDP `Page.captureScreenshot` works. Attach `webContents.debugger` only after the first page load; `sendCommand` before that hangs. |
| Steering | `initialize` result `_meta.steering.supported: true`; method `_session/steering {sessionId, prompt, _meta:{steering:{idleBehavior:"promptRequired"}}}` -> `{outcome:"injected"}` / `{outcome:"promptRequired", reason:"noRunningTurn"}` / `{outcome:"startedNewTurn"}`. Guild's Steer maps to it for the Claude engine. |
| Account | `_auth/status_update {authStatus:{kind:"account", label:"Claude Max", account:{plan, email, organization}}}`. Guild may show the label/plan; never store, log or display the email. |
| Local latency | A trivial turn on the 27B local model took 48 s (large system prompt prefill). Expected; not a bug. |

## 3. Architecture decisions

### 3.1 Engine per task
`task_metadata.engine` (`grok` | `claude`, default `grok`) is set when the task's first turn is
created and never changes. Process topology stays one engine process per task (D-008).

### 3.2 Claude engine process
- Executable pin: the user's `node` (Mach-O, existing pin) plus the adapter entry script path as
  `argv[0]`. Pin the adapter by package version (supported range `>=0.89.0 <0.90.0`) and a SHA-256
  over its installed `package.json` and `dist/` tree; mismatch refuses to start with a named error.
  **A piece whose bytes differ from its pin is never executed to decide what to do about it.**
  `node` is trusted on first use, once per app launch: the first supported node located in a launch is
  pinned by real path and SHA-256, and from then on its hash is compared (the file is only read) before
  anything runs it again, the `--version` probe included. A node that differs, moved or is gone is
  refused with `engine_integrity_changed` without being run, by every later locate in that launch (the
  engine probe, the warm-up, a new task process); a node update therefore takes effect on the next Guild
  launch. A failed pin check may be followed by one automatic re-locate, and only an update is accepted:
  the adapter `package.json` is read, and another package version is re-pinned while the same version
  with another fingerprint is refused (reading executes nothing). The `claude` binary (about 200 MB) is
  pinned by real path and version string, **not by hash**: a re-locate accepts another real path only when
  it is `.../versions/<v>` in the same `versions` directory as the pinned binary, with a `<v>` that differs from the pinned version (the directory name carries
  the version, the new file is not run to decide), and refuses the same version at another path as well as
  any path outside that layout. The same path is the same binary, so bytes changed in place under it are
  not detected by Guild; the adapter runs it the way the user's own `claude` would run.
  A Claude runtime whose pieces already differ when it is created is returned in the refused state and
  never starts. The Claude status reads "Claude engine files changed unexpectedly; restart Guild to
  accept updated engine files, or reinstall claude-agent-acp". The code is on the IPC failure allowlist;
  the state clears when a later session opens with the pinned files back in place, or after a restart.
- Locator: `claude-agent-acp` from `~/.npm-global/bin`, the user's PATH and Homebrew paths;
  `claude` from `~/.local/bin/claude` / PATH (Mach-O). `node` from PATH (>= 22).
- Env (allowlist + Guild-owned values): PATH, HOME, USER, LOGNAME (claude looks up its Keychain login by account name; without USER it reports "not logged in" [WP-A smoke]), LANG/LC_*, TMPDIR, proxy vars, SSL vars,
  `NO_PROXY=127.0.0.1,localhost` (always), `CLAUDE_CODE_EXECUTABLE=<pinned claude>`. Strip every
  inherited `ANTHROPIC_*` and `CLAUDE_CODE_*` variable first. Do NOT inject the Grok OpenViking
  kill-switch block (D-060). Routed sessions add the variables of 3.3.
- No `--rules` argv. Guild agent rules (if any) go through `_meta.systemPrompt` only if the adapter
  supports append mode; otherwise none.
- Permission mode: `set_config_option mode` after session start (not argv, no restart).
- Start window and lost sessions: `initialize` and `session/new|resume|load` of the Claude adapter wait up to
  300 s (the adapter brings up the Agent SDK, connectors and plugin hooks; 45-125 s were measured under load;
  Grok keeps 30 s). A request that gets no answer in time (`request_timeout`), or a process that dies before
  answering a resume, never marks the session lost: the binding stays `restore_pending` with its retained
  session id, the send fails with `claude_start_timeout` ("Claude is still starting ... Try again in a
  moment"), and the next send resumes it again. Only the agent's own "no such session" answer (ACP -32002,
  `session_not_found`) ends in `restore_failed` (replacement offered; a task without a Run is replaced without
  asking). Any other failure of a resume keeps the session too and stays a plain failure. `session/load` is not
  tried after a resume that was advertised (it would only wait a second window); it is the way back only for an
  agent that does not advertise resume.
- Shutdown and helpers (both engines): the process host signals the engine's process group (TERM, then KILL).
  Helpers the engine started that left its group (Grok's MCP servers such as `chrome-devtools-mcp`, Claude's
  plugin and connector processes in a session of their own) are not reached by that signal and used to survive a
  graceful quit. The host records the engine's identity (pid and `ps` start time) right after the spawn. At stop
  time, while the engine is alive, it reads the engine's descendants outside the group
  (`ps -axo pid=,ppid=,pgid=,lstart=`, walked from the engine pid, at most 256, 1 s bound) and keeps the
  snapshot only if that same table shows the engine with the recorded start time; if the root is missing or its
  start time differs (the pid was reused), or if the engine exited while the table was read (the start time has
  one-second precision; the pid cannot be reused before Guild, its parent, reaps it and observes `exit`), it sweeps
  nothing and logs `helper_sweep_skipped_identity`. As soon as
  the group is gone it sends TERM, then KILL, to exactly those processes, and only to a process whose pid, group
  and start time still match the snapshot. It does not wait for the engine's stdout to close first (a helper
  that inherited it would keep that from ever happening), and a stop that times out sweeps once too. Nothing
  outside the engine's tree is touched. Limitation: an engine that dies on its own (crash, kill from outside)
  has already re-parented its helpers, so nothing links them to it and they are not swept.
- Auth: never call `authenticate` for Claude. If `authMethods` is non-empty and the first session
  fails with auth required, show "Run `claude` once in Terminal and log in" (named reduced state).

### 3.3 Native vs routed sessions
- The mode of the engine process follows the task's selected model (D-062). A task whose selected model is an
  Online or Local model runs in a **routed** process; any other selection, a Claude model or the Claude default,
  runs in a **native** one: no `ANTHROPIC_BASE_URL`, no `ANTHROPIC_AUTH_TOKEN`, the model list is the adapter's own.
  This holds at every start of a process: the switch, a crash recovery and a Guild restart.
- Native to routed. The first time the user picks an Online or Local model in a task whose process is native,
  Guild (between turns, as one serialized start operation that concurrent callers join): restarts the task's
  adapter with the routed environment below, resumes the same session with
  `_meta.claudeCode.options.settings.modelPicker` listing every enabled Online/Local model, sets the model, and
  only after the model is confirmed applied (and the start's projection published) records
  `task_metadata.routed_at_ms` as the last step that can fail (review fix 2026-10-12); a projection
  that cannot be built after the marker is logged, not raised. Every prompt launch (send, queued turn, continuous
  round) first joins a start in flight or due and uses the session it produced. If a run became active before the
  old process closed, the switch is deferred without marking; any failure leaves the task unmarked and surfaces
  `model_router_unavailable` / `model_selection_failed`. For the Claude engine a model that cannot be
  applied refuses the prompt (`model_selection_failed`) instead of running on another model.
- Routed to native (D-062). Picking a Claude model, or clearing the choice (the Claude default), in a task whose
  process is routed restarts the process natively between turns, with the same one serialized start operation:
  the routed process is closed, a native one starts without the router and without any routed variable, resumes
  the same session (same start options as before minus the routed `modelPicker`; the browser MCP server stays),
  and then applies the model. No router is involved, so a router that cannot start does not block the way back.
  Queued and sent prompts wait for the switch (`sessionStartPending`) and go out on the new process only. On any
  failure the selection rolls back to what was running and the refusal is surfaced like other selection failures
  (`unavailable`); a resume that gets no answer in time keeps the session (the binding stays `restore_pending`),
  and only the agent's own "no such session" answer (ACP -32002) replaces it. A session resumed natively after
  routed turns can come back on the routed model of its last turn, which the native model list does not offer;
  the selected Claude model, or the Claude default when nothing is pinned, is applied before the first turn.
- Between models of the same mode nothing restarts: Claude to Claude is a plain `set_config_option`, and so is
  Online to Local or Online to Online (the routed model variables below keep naming the model of the last start).
- **Routed environment (D-061).** Every start of a routed process (the switch, a crash recovery, a Guild
  restart) adds exactly these per-spawn variables, each validated by the Claude profile:
  `ANTHROPIC_BASE_URL=<router url>`; `ANTHROPIC_AUTH_TOKEN=guild-router-<32 random hex>`, new for each
  launch, never logged, redacted from diagnostics (with a base URL alone Claude Code would send its
  subscription token to the router; with this token set it sends only the throwaway value);
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; `ENABLE_TOOL_SEARCH=true`; `OPENVIKING_AUTO_CAPTURE=false`;
  and the routed model applied at that start (the task's selected Online/Local model; no variable when it
  selects none) as `ANTHROPIC_SMALL_FAST_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` (never the
  `ANTHROPIC_DEFAULT_*_MODEL` variables: any of them makes the adapter drop that id from the modelPicker), so
  background requests (titles, summaries, compaction) and subagents stay on the third-party source.
  `ANTHROPIC_API_KEY` is never set (inherited `ANTHROPIC_*` stays stripped). The model variables follow the
  last (re)start: a switch between routed models of a live session is a plain `set_config_option`, so they
  keep naming the earlier source until the next start.
- **Native environment.** A native process gets none of the routed variables. The only per-spawn variable it can
  carry is `OPENVIKING_AUTO_CAPTURE=false`, set when the task has used a routed model at least once
  (`task_metadata.routed_at_ms`, D-062; the dev-only QA capture switch sets it for every native spawn). The
  subscription login therefore goes straight from `claude` to Anthropic.
- **The marker.** `task_metadata.routed_at_ms` means "this task has used an Online or Local model at least
  once". It is written once, after a routed process took the selection, never cleared, and no longer forces a
  process mode (no schema change, schema v19).
- Switching among models of a routed session is a plain `set_config_option` (no restart).
- **Switch UX (D-062).** A cross-mode switch takes 30 to 120 seconds. In a Claude task that has run turns the
  picker shows a muted "Restarts" tag (tooltip "Switching restarts Claude Code, then reconnects this
  conversation", aria-hidden, the meaning in the row's accessible description) on the rows that cross the
  boundary: Online and Local rows while the task runs a Claude model, and the Claude rows and "Use default"
  while it runs an Online or Local one. While the switch runs the picker trigger shows a spinner and
  "Switching...", and one status line above the composer hints says that the engine restarts, usually in 30 to 90
  seconds, and that the message is sent once the switch is done; on failure the line shows the selection-failure
  message. A new task with no turn, a Grok task and rows of the same mode show none of it.
- Selection before Claude has started: the runtime default of a Claude task is Claude's own pick (the
  adapter-reported list, group `claude`) or nothing, which the picker shows as "Claude Code (default model)";
  never a routed model and never a Grok model (a Grok id is refused as a Claude choice unless a router source
  claims it). While the adapter's list is still unknown, the native aliases `default`, `opus`, `sonnet`,
  `haiku` and `fable` can be saved as a task choice or as the global default; they are applied when the
  session starts, and `model_selection_failed` answers if the adapter then does not offer one.
- Never use the adapter's `providers/set` or gateway `authenticate`: they bypass the Claude login
  (adapter source comment on `GatewayAuthMeta`).

### 3.4 Model router (`packages/model-router`, runs in the Electron main process)
- Listens on `127.0.0.1` only, random port, URL `http://127.0.0.1:<port>/<token>/` with a 32-hex
  random token; wrong token -> 404. Binding to any non-loopback address throws at startup (test).
- **Exact registry.** The registry holds the configured Online/Local models of enabled, confirmed
  sources and nothing else. There is no Anthropic upstream and no Anthropic id: the router never opens a
  connection to `api.anthropic.com` (D-061). Any other model gets a JSON error and no upstream, never a
  default: a `claude-*` model -> 400 `invalid_request_error`, "Claude subscription models are not
  available in a task that uses online or local models"; any other unknown model -> 404. A model id a
  source lists is served by that source only.
- **Credential rules (tests):** a request whose `authorization` or `x-api-key` value, after an optional
  `Bearer `, starts with `sk-ant-` (an Anthropic API key or a subscription token) is rejected with 400
  `invalid_request_error` before the body is read or anything is forwarded; the router logs the fixed code
  `anthropic_credential_rejected` (and `console.warn` a fixed string) and never the value. Requests to
  Online/Local sources forward only an allowlist of request headers (`anthropic-version`, `content-type`,
  `accept`, `user-agent`, `x-app`, `x-stainless-*`, `anthropic-dangerous-direct-browser-access`,
  `x-claude-code-*`); `authorization`, `x-api-key` and `anthropic-beta` are never among them. The
  source key is then set (`x-api-key` and `Authorization: Bearer`). Redirects are never followed.
  Credential and header values are never logged; logs carry model, source id, status, booleans.
- **Keys** come from a user-designated env file (path + variable name per source, default file
  `~/.config/guild/keys.env` on this machine), read in main when the router starts or when a
  source is confirmed; kept in memory only; never in SQLite, IPC payloads, renderer or logs.
- **Host binding.** Adding a source or changing its base URL / key variable requires a native
  confirmation dialog in main (`dialog.showMessageBox`) naming the variable and the host. The router
  only sends a key to the host it was confirmed for. Renderer requests alone cannot activate a change.
- Online sources: https only. Local sources: http or https; the host is resolved once per request,
  every resolved address must be loopback or in 100.64.0.0/10 (Tailscale), and the request is then
  sent to the first validated address as an IP literal (IPv6 bracketed), never to the hostname, so
  a second DNS answer cannot reach the connection (DNS rebinding). Local https is allowed only when
  the host is already an IP literal (a certificate name cannot match a rewritten IP, `localhost` included);
  any other https host, `https://localhost` among them, answers 403 `local_https_requires_ip`.
  `http://localhost` stays allowed and is rewritten to the loopback address it resolves to. No `Host` header is set.
- **Transport selection.** The router calls `fetchImpl(url, init, { sourceKind })` with the kind of the
  source it chose for that request. The Electron host uses the direct (no proxy) session for `local`
  and the proxied session otherwise, from that argument only, never from the URL or the live registry.
- **Compat layer** (every request the router serves):
  1. `role:"system"` messages are removed; their text is queued and inserted as one
     `<system-reminder>` text block into the next user message **after** its `tool_result` blocks
     (or appended as a trailing user message if none follows).
  2. `tool_addition` blocks (in any message) are removed and their `definition` appended to `tools`
     (dedupe by name against non-deferred tools).
  3. Tools with `defer_loading: true` are removed; remaining tools keep only
     `name`, `description`, `input_schema` (and `type` when not `custom`).
  4. Top-level `context_management` and `output_config` are removed.
  5. Consecutive same-role messages are merged; in user messages `tool_result` blocks come first.
  6. Empty content becomes `[{"type":"text","text":"(empty)"}]`.
- **Thinking provenance.** The router records `sha256(signature)[:32] -> source id` for every non-empty
  thinking signature it sees in responses (SSE `signature_delta`, `content_block_start`, or JSON).
  Persistence goes through an injected store (Guild: SQLite table `thinking_provenance`).
  Before forwarding to source X, `thinking`/`redacted_thinking` blocks not produced by X are dropped,
  and so are blocks of unknown provenance, whatever the signature looks like (Claude turns made before
  a task was routed were never seen by the router). Rows that Guild 3.0.0 recorded under the id
  `anthropic` prove nothing for any source; the id stays reserved. An empty (or missing) signature is
  never recorded and such unsigned thinking blocks are dropped for every target, Local included.
- **SSE normalizer** for Local sources: re-sequence content blocks so a block's events (deltas,
  `signature_delta`, `content_block_stop`) are emitted before any event of a higher index; buffer the
  higher block until the lower one stops.
  The buffer is capped at 8 MiB of held event text and 64 waiting blocks (so at most 65 tracked blocks), checked before
  every insertion, including a block start lower than every open block; on overflow the router
  aborts the upstream request, ends the client stream with an Anthropic-style SSE `error` event
  (`api_error`) and logs `router.stream_overflow` (route, source, limit).
- **Connection test (D-063).** Settings > Model sources can test a source whose address is confirmed. The main
  process reads the key as the router host does (the source's key file and variable), applies the same source
  rules as a turn (`source-policy.ts`, shared with the router: host binding, never an Anthropic host or
  `sk-ant-` key, Online https, Local loopback or 100.64.0.0/10 resolved once, https for Local on an IP literal
  only) and sends one `POST {baseUrl}/v1/messages` with `{model, max_tokens: 1, messages: [ping]}` per model
  (at most three at a time, 15 s timeout, `redirect: "manual"`, the Online proxied or Local direct transport
  of the router host). Each model answers with one of: ok and its latency; key wrong or no permission (401,
  403); no such model (404, a `not_found_error`, or a 400/422 whose error *message* says the model is unknown or
  missing; a 400 about a token limit or a thinking mode stays its status code); cannot connect; timeout; another
  status code. Nothing is sent, and the one reason is named, for an unconfirmed source, a key variable with no
  value, an Anthropic key in the variable, or an address the rules forbid. The answer carries statuses only:
  never the key, a header or a response body. IPC `guild:v1:model-sources:test`.
- `GET /<token>/v1/models` returns the Online/Local models (Anthropic list format).
- No OpenAI-protocol translation. Every supported backend speaks Anthropic Messages natively.
- Router lifetime = Guild main process lifetime; it starts lazily on first routed session.

### 3.5 Browser pane
- `WebContentsView` in the workbench column as a new tab "Browser" (next to Files / Review);
  session partition `persist:guild-browser`; `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, no preload, `backgroundThrottling: false`.
- Navigation only `http:`, `https:`, `about:blank`; `window.open` opens a new pane tab (max 5) or is
  denied; all permission requests denied (camera, mic, geolocation, notifications, clipboard-read...);
  downloads require a native save dialog; no external login state copied (PC-SEC-002 unchanged).
- UI: address bar, back/forward/reload, tabs, "agent is operating" badge with "Take over" which
  pauses agent control (tools return "paused by user") until "Resume agent".
- Security profile split (docs/09): Guild's own renderer keeps every existing guard; only
  webContents created by the browser module in partition `persist:guild-browser` get the navigation
  allowance. The guard functions key on the webContents id registry, not on URL heuristics.
- **Browser MCP server** (main, no new dependency): minimal MCP over Streamable HTTP with JSON
  responses on `127.0.0.1:<random>/<token>/mcp`; methods `initialize`, `notifications/initialized`,
  `ping`, `tools/list`, `tools/call`; other methods -32601. Tools: `navigate{url}`, `back`, `forward`,
  `reload`, `screenshot` (CDP `Page.captureScreenshot`, PNG), `read_page` (CDP accessibility tree,
  lines `[ref_<backendNodeId>] role "name"`), `get_text`, `find{query}`, `click{ref}|{x,y}`,
  `type{text}` (CDP `Input.insertText`), `key{key}`, `scroll{direction,amount}`,
  `console_messages`, `network_requests`, `tabs_list`, `tab_select`. No `eval`.
- **Window zoom.** The renderer reports the pane's rectangle in CSS pixels; main multiplies x/y/width/height
  by the Guild window's `webContents.getZoomFactor()` (rounded) before `setBounds`, and re-applies the last
  rectangle when the zoom changes (`zoom-changed`, and every later layout pass reads the factor afresh).
- Passed to engines in `session/new`/`session/resume` `mcpServers` as
  `{type:"http", name:"guild-browser", url, headers:[]}` for Claude, and for Grok only if its
  initialize advertises `mcpCapabilities.http`.
- Tool calls go through the engine's normal permission flow (permission cards).
- **A call is bound to its start.** Each tool call captures the control generation (bumped by every
  "Take over") and the active tab and its page when it starts, and every step goes to that tab. Right
  before each CDP command and each navigation the call checks the generation (mismatch: the paused
  message) and that its tab is still open (else a tab-changed message). Input and screenshots also
  need the bound tab to still be the shown one, and until a call has sent actionable input (a pressed mouse
  button, a key going down or a typed character, inserted text; pointer movement and wheel events do not
  count), `DOM.*` and `Input.*` steps need the page not to have navigated since the call began (a ref or
  coordinate belongs to that page).

### 3.6 OpenViking (D-060, D-062)
Claude engine: OpenViking on (no kill-switch env). Routed Claude sessions: `OPENVIKING_AUTO_CAPTURE=false`
(recall stays), and so does every process, native ones included, of a task that has used a routed model
(`task_metadata.routed_at_ms`), so third-party output never enters the memory store. A task that never used a
routed model keeps capture as the user configured it. Grok engine: unchanged kill-switch block.

### 3.7 Online-model reminder
Whenever a task switches to an Online model of a vendor (model source) not yet agreed to in that task, a confirmation states that CLAUDE.md, memory,
the conversation, and browser page text/screenshots in the conversation will be sent to <vendor>.
Option "Don't remind me again in this workspace" persists in `workspace_prefs`. Local and Claude
models never remind, and neither does a switch back to Claude (D-062). The reminder is per task and per vendor
and stands alone in its dialog: the one-way notice of D-061 is gone with the lock.

### 3.8 Grok-only features under the Claude engine (truthful reduced capability, PC-FALLBACK-001)
Steer -> `_session/steering` (queue when `promptRequired`). Conversation rewind -> files only (existing fallback).
Usage panel -> context usage from `usage_update`; quota "Managed by Claude Code". Grok control
center and Grok slash snapshot -> Grok engine only. Phase line -> generic phases only. Content the adapter emits after a prompt response (rare: v1 holds a turn open while its background work runs) is dropped and reported as `late_update_dropped` (known 3.0 limitation); `async_task_*` session updates are ignored extensions.

### 3.9 Claude group layout in the model picker (PC-MODEL-001)
The adapter lists every model Claude Code knows; the picker reads that list and shows less of it. These
rules apply to the Claude group only (Grok, Online and Local rows are unchanged) and read names and ids the
adapter reported, never a hard-coded list of models:
- **Rows shown.** The Default row, and the newest model of each known family (Opus, Sonnet, Haiku, Fable):
  family and version are parsed from the display name ("Opus 5.5"), else from the id; a tie at the newest
  version keeps every row; a model whose family is not recognized is always shown. Every other Claude model
  sits in a collapsed row at the end of the group, "Older models (N)", which opens
  inline and starts open when the selected model is one of them. The row is a keyboard-reachable option of the
  listbox; collapsed models are not in the keyboard order or the tab stop.
- **Default row.** Named "Default (Opus 5.5)" where the part in parentheses is
  the adapter's description of the Default row when that reads like a model name, else just "Default"; the
  trigger shows the same real model name ("Opus 5.5 · Default").
- **Descriptions.** zh-CN replaces the adapter's English text with a description of the family (Opus:
  complex and everyday work, Sonnet: speed and ability in balance, Haiku: fastest, for simple quick tasks,
  Fable: the hardest and longest tasks); a family it does not know keeps the adapter text, and so does
  every row in English.
- **Efforts.** The Claude effort segment reads from the strongest down like Grok's: Default, Max, Extra high,
  High, Medium, Low (the adapter lists them weakest first; an id the table does not know keeps the adapter's
  order after the known ones). Settings > Engines lists the same way. All wording is localized in
  `packages/ui/src/locales.ts`.
- **Online and Local rows** show the context window their source states ("1M context") and, when the source
  says the model accepts images, a muted "Supports images" on the same line.
- **Settings default (3.0.2).** The control lists the adapter's own Default row once, as the localized
  "Claude Code default" option, then the same newest-per-family rows with the same descriptions, and the older
  models in a group.

## 4. New identifiers

Decisions: **D-057** dual engine and per-task binding; **D-058** model router; **D-059** browser pane
and browser MCP; **D-060** OpenViking amendment (supersedes the D-052 amendment for the Claude engine);
**D-061** subscription credentials never traverse the router and the Claude-to-routed switch is one-way
(amends D-058); **D-062** the switch is two-way, switching back restarts natively and resumes, the subscription
still never traverses the router (supersedes the one-way clause of D-061).

Requirements (new; old ones remain with disposition `superseded_by`):

| ID | Title | Supersedes |
|---|---|---|
| PC-ENG-001 | Two engines; engine fixed per task at the first turn; truthful reduced capability per engine | — |
| PC-ENG-002 | Claude engine runs the user-installed adapter and claude binary, pinned; Guild never reads Claude credentials | — |
| PC-MODEL-001 | Grouped model picker (Grok / Claude / Online / Local); only models reported by the engine or configured sources; the switch between a Claude model and an Online or Local one is two-way (native or routed process by selected model, restart and resume, "Restarts" tags and switching status) | PC-ACC-001 (model clauses) |
| PC-ROUTE-001 | Router loopback-only, random token, exact registry of Online/Local models, unknown model 404 (Claude model 400), no redirects | PC-SEC-001 (gateway clause, extended) |
| PC-ROUTE-002 | Credential rules: no Claude credential ever reaches the router (throwaway auth token, Anthropic-looking credentials rejected), no Anthropic upstream; third-party keys from a user env file, host-bound by native confirmation, never persisted or logged | — |
| PC-ROUTE-003 | Compat layer, thinking provenance, local SSE normalization | — |
| PC-BROWSER-001 | Isolated browser pane (partition, sandbox, navigation and permission policy, security-profile split) | — |
| PC-BROWSER-002 | Browser MCP loopback server, tool set without eval, permission cards, user takeover | — |
| PC-PRIV-001 | Online-model reminder with per-workspace opt-out | — |
| PC-OV-001 | OpenViking policy per engine and routed state; capture stays off for every process of a task that has used a routed model | — |
| PC-SET-002 | Settings tabs General / Engines / Model sources / Privacy / About | PC-SET-001 |

Commit messages cite at least one of these IDs (traceability policy).

## 5. Work packages

All WPs branch from `guild3`, each in its own git worktree under `~/Workzone/guild3-wt/<wp>`.
File ownership avoids conflicts; anything outside the listed paths needs a note in the WP report.

| WP | Scope | Owns |
|---|---|---|
| WP0 | Governance text: decisions D-057..D-060 (D-061 followed), requirement entries and dispositions, README (zh/en boundary list), PROVENANCE.yml, NOTICE / THIRD-PARTY-NOTICES (independence from xAI and Anthropic), docs/01 contract, docs/09 security profile split, docs/15, docs/02/12 notes | `docs/`, `requirements/`, `README.md`, `PROVENANCE.yml`, `NOTICE`, `THIRD-PARTY-NOTICES` |
| WP-B | Contracts + persistence: `GuildEngine`, per-engine model id grammar, per-engine catalogs and defaults, IPC channels/validators for task engine, model sources (no secrets), workspace prefs, browser pane commands; schema v19 (`task_metadata.engine`, `routed_at`, `model_sources`, `workspace_prefs`, `thinking_provenance`, per-engine defaults, catalog keyed by engine, relaxed CHECKs) with migration tests | `packages/contracts`, `packages/persistence` |
| WP-C | `packages/model-router` (new workspace package, registered in root `workspaces`, `tsconfig`, `scripts/run-tests.mjs`): everything in 3.4 with unit tests against fake upstream servers (including recorded llama.cpp SSE) | `packages/model-router`, root registration lines |
| WP-D | Browser: main-process `browser-pane.ts`, `browser-mcp.ts`, security guard split in `window-security.ts`, `BrowserPane.tsx` UI component (standalone, wired later by WP-E), tests | `apps/desktop/src/main/browser-*.ts`, `window-security.ts`, `packages/ui/src/BrowserPane*` |
| WP-A | Runtime: `EngineProfile`, Claude profile, process host generalization, node+adapter pin, Claude locator, codec/adapter dialect (model ids, `_meta.claudeCode.options`, mcpServers passthrough, late frames, no auto-auth, -32601 liveness), tests with `FakeProcess` | `packages/runtime-grok`, `apps/desktop/src/main/runtime-locator.ts`, new `claude-locator.ts` |
| WP-E | Orchestration + UI: `live-service.ts` engine selection, routed switch (3.3), router and browser MCP lifetime, feature gating, OpenViking env policy, reminder dialog, settings Engines / Model sources UI with native confirmation, grouped `ModelPicker`, new-task engine binding, locale strings zh/en, fixture service | `apps/desktop/src/main`, `packages/ui` |
| WP-F | Packaging (`verify-package.mjs` updates), installed-app QA script for both engines, release notes, install with backup | `apps/desktop/scripts`, `scripts/` |

Order: WP0, WP-B, WP-C, WP-D in parallel -> WP-A (needs WP-B contracts) -> WP-E -> WP-F.

## 6. Acceptance (installed app)

1. All existing tests pass; real Grok two-turn queued task passes.
2. Claude subscription task: file write/read, permission card, restart + resume; `/status` shows no gateway.
3. Same task Opus -> DeepSeek with tools: the Online reminder is the only dialog; the rows of the other mode
   carry the "Restarts" tag and the composer shows the switching status while the engine restarts; the routed
   process has the throwaway token and no API key. Then back to Opus 5.5: the native process has no
   `ANTHROPIC_BASE_URL`, no `ANTHROPIC_AUTH_TOKEN`, no `ANTHROPIC_API_KEY` and `OPENVIKING_AUTO_CAPTURE=false`,
   an Opus turn recalls what the DeepSeek turn said, and the router log shows no request served by Anthropic,
   no `claude-*` request answered and no rejected Anthropic credential.
4. Local model turn through the router; no duplicated text.
5. Browser: manual login persists across restart; agent navigates a local dev server, screenshots,
   clicks; badge + takeover work; pane cannot reach Node or Guild UI.
6. OpenViking recall in Claude tasks; no capture in routed sessions, nor in the native ones of a task that has used
   a routed model; nothing in Grok tasks.
7. Security tests: non-loopback bind fails, bad token 404, no secrets in logs, package scan passes.
8. Reduced capability states render truthfully (no blank or stuck spinner).
