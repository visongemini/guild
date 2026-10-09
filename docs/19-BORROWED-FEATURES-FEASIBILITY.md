# Borrowed features: competitor patterns and grok 1.0.50 feasibility

Date: 2026-10-09. Live checks ran against grok 1.0.50 (c58f321264ba); source reads against the
public grok-build tree (1.0.45, `crates/codegen`, abbreviated `SH` = `xai-grok-shell/src`,
`GB` = `crates/codegen`). Extension methods are NOT advertised in capabilities: probe with a
harmless call per process start and treat -32601 as unsupported. On the wire every extension
starts with an underscore (`_x.ai/...`); bare `x.ai/...` returns -32601.

Security note: `_x.ai/mcp/servers_updated` prints MCP server settings (including tokens) in
plain text, and the `authenticate` reply `_meta` carries the account email. Never persist raw
messages Guild does not recognise.

## Competitor landscape (verified 2026-10-09)

| Product | Kind | Grok link | Notes |
|---|---|---|---|
| Grok App (RongleCat/grok-app) | Tauri 2 desktop, Grok-only | ACP `grok agent stdio` | 1,417 stars, v0.2.39 (2026-10-08), MIT, notarized. Broadest Grok-specific feature set. |
| T3 Code (pingdotgg/t3code) | Electron/web/mobile multi-agent console | ACP, Grok Build is one of six providers | 26.5k stars, alpha. Best architecture: server-owned process, event log, per-thread subscription, hidden git ref checkpoints. Open Grok bugs: effort not mapped, stale "working". |
| phuryn/grok-build-vscode | VS Code sidebar + Electron desktop | ACP | 33k installs, 5.0 rating. Best detail: queue vs Steer, per-turn changed-files card, narrow permissions. |
| rimusz/grok-build-desktop | SwiftUI macOS 26+ | ACP | Small. Honest rewind (conversation only), worktree badges, notifications. |
| Zed / JetBrains | Editors with ACP registry | ACP | Thinnest UI for Grok. |

Patterns worth copying, by owner:
1. Stream render without full re-render; memoized stable markdown prefix (Grok App #1072, #1113).
2. Tool output collapsed by default and offloaded when collapsed (Grok App #1018/#1029).
3. Sidebar and session list virtualized/paginated; never scan all sessions on the main thread
   (phuryn #109; Grok App #1253/#1254).
4. Send only the viewed thread; keep payloads small (T3 Code, worst case under 40 KB).
5. Truthful waiting phases with elapsed time (official TUI waiting-reason enum; Grok App
   "Still waiting for the first reply..." at 12 s, stall banner at 150 s).
6. Pass reasoning effort when opening/resuming a session; effort visible next to the composer.
7. Status dots and unread markers (phuryn: running / waiting for you / new result / error).
8. Notifications that deep-link to the task (rimusz).
9. Queue by default, explicit Steer (phuryn, rimusz).
10. Narrow permissions per program (phuryn).
11. Per-turn "changed N files" card with diff against turn start (phuryn).
12. Checkpoints and rewind of conversation and files (T3 Code hidden refs).
13. Per-task worktree with badge, apply, discard (phuryn, rimusz).
14. Do not break prompt cache; no auto-resend on 403/quota.
15. Health checks without side effects (T3 Code).

## F1a Model and reasoning effort (size S-M)

- Lists: `initialize` `_meta.modelState`; `session/new` `models` and `configOptions`
  (`model` category `model`, `reasoning_effort` category `thought_level`).
- Push updates: `session/update` `config_option_update`; `_x.ai/session_notification`
  `model_changed {model_id, reasoning_effort}`; `_x.ai/models/update`.
- Set: `session/set_config_option {sessionId, configId, value}` (validates; bad effort -> -32602).
  `session/set_model {sessionId, modelId, _meta:{reasoningEffort, contextWindow?}}` silently
  ignores a bad effort, so prefer set_config_option. At creation `_meta.reasoningEffort` on
  `session/new` (live); resume/load read `_meta.reasoningEffort` (source `SH/agent/mvp_agent/session_setup.rs:1011`).
- Live: switching model/effort between turns keeps context in the same session. After the first
  turn, a model with a different `agentType` is refused (`MODEL_SWITCH_INCOMPATIBLE_AGENT`).
- Design: migration adds `task_runtime_settings(task_id, model_id, reasoning_effort,
  context_window, revision, updated_at_ms)`; global defaults stay in `app_settings`; selector is
  built from the session's advertised options; apply via set_config_option after new/resume and
  between turns; stop `setRuntimeSettings` from closing every adapter. Default for new installs
  and the owner: `grok-4.7` + `high` (owner approved 2026-10-09).

## F1b First-token phase indicator (size S)

Live timeline of one turn: 0.01 s `_x.ai/queue/changed` + `_x.ai/sessions/changed` (working);
0.04 s `_x.ai/session_notification` `hook_run_started {event_name:"user_prompt_submit"}`;
8.0 s `hook_execution` (the owner's OpenViking compressor; see todo); 12.1 s first
`agent_thought_chunk`; 13.5 s first `agent_message_chunk`. Later: `tool_call_delta_chunk {name}`,
`pending_interaction {kind:"permission"}` / `interaction_resolved`, `retry_state {attempt,
max_retries, reason}`, `response_completed`, `turn_completed`, `_x.ai/session/prompt_complete`.
Session start: `_x.ai/session/setup {phase}`, `_x.ai/mcp/init_progress`.
Labels (total and per-phase elapsed): Starting Grok, Opening session, Sent (soft notice at
10 s if not accepted), Queued #n, Running hooks (n), Waiting for model, Thinking, Preparing
tool <name>, Waiting for your permission, Running <tool>, Retrying a/b, Responding.
Admit only these signals; store no text from them.

## F4 Steer (size M)

- `_x.ai/interject {sessionId, text, interjectionId?, content?}` -> `{status:"queued"}`; all
  clients then get `_x.ai/session/interjection {sessionId, text, interjectionId}`. Live: sent
  during a 12 s tool call, consumed in the same turn at the next safe point
  (`SH/extensions/interject.rs`, `SH/session/acp_session_impl/run_loop.rs:2057`).
- No running turn: grok converts it into a queued prompt with id prefix `interject-fallback-`.
- A second `session/prompt` during a turn is queued by grok (`_x.ai/queue/changed`), not
  cancelled. `_meta.sendNow:true` cancels the running turn: never use it.
- Design: Steer stores a conversation entry with a client `interjectionId`, sends
  `_x.ai/interject`, marks delivered on the echo; on -32601 fall back to Guild's durable queue.
  Guild must accept agent-started fallback turns (`turn_completed` with a prompt id Guild did
  not send) and replayed interjections.
- Limits: no proof the model consumed it beyond the echo; a long tool call delays it.

## F2 Checkpoints, changed-files card, rewind (size M + M-L)

- Official: `_x.ai/rewind/points {sessionId}` -> `rewind_points[{prompt_index, created_at,
  num_file_snapshots, has_file_changes, prompt_preview}]`; `_x.ai/rewind/execute {sessionId,
  targetPromptIndex, mode: all|conversation_only|files_only, force}`; `force:false` is a dry run
  returning `clean_files` and `conflicts`. Live: hidden model context really is truncated; reply
  includes `prompt_text` for the composer. Fork exists only as `_x.ai/session/fork` (untested).
- Official file snapshots only cover edit tools (`SH/tools/notification_bridge.rs:355`), not
  shell edits. `_x.ai/hunk-tracker/*` needs `clientCapabilities._meta["x.ai/hunkTracker"]`.
- T3 Code: refs `refs/t3/orchestration-v2/checkpoints/<b64(sha256(scope))>/ordinal/<n>`; capture
  with a temporary `GIT_INDEX_FILE`, `add -A`, `write-tree`, `commit-tree`, `update-ref`; baseline
  before the first turn, checkpoint at each turn end; untracked included, ignored excluded;
  card from `diff --numstat`. Its restore ends with `reset`, which drops staged changes: do not copy.
- Design: `refs/guild/checkpoints/<taskId>/<ordinal>` at Run start and end; card from
  `git diff --numstat -z`; table `run_checkpoints(task_id, run_id, prompt_index, start_ref,
  end_ref, files_json, status)`. Rewind: dry run, then `conversation_only` officially, then
  restore files from Guild's git checkpoint, mark later runs `rolled_back`. Non-git folders use
  official `mode:"all"`. Verify `prompt_index` against Guild's turn count first. Say plainly what
  cannot be undone (network/MCP effects, commits/pushes made by shell, memory writes).

## F3 Per-task worktree (size M-L)

- CLI: `grok worktree create|list --json|show|rm -f|gc|detach|salvage|clean-artifacts`,
  `grok -w`. ACP `_x.ai/git/worktree/create|list|remove` work; `_x.ai/git/worktree/apply`
  failed both live tests (`GB/xai-grok-workspace/src/worktree/mod.rs:2609`). No merge command.
- Design: Guild runs local git: `git worktree add -b guild/<slug> <guildData>/worktrees/<taskId>
  <base>`; session `cwd` = worktree (through the workspace authorization check); table
  `task_worktrees(task_id, source_workspace_id, path, branch, base_commit, status
  active|applied|discarded, timestamps)`; branch badge with dirty/ahead counts; Apply = commit +
  `git merge --no-ff` with conflict preview; Discard = `git worktree remove --force` +
  `branch -D` after confirmation. A fresh worktree lacks ignored files such as node_modules.
