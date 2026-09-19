# ACP and official-runtime capability matrix

Observed runtime was refreshed to `grok 1.0.13 (5e9a58528b76)` on 2026-08-29. This matrix is versioned
evidence, not a promise about later binaries. Guild renegotiates on every process epoch.

| Product need | Surface | Observed status | Guild contract |
|---|---|---|---|
| Initialization | ACP | Proven | Protocol v1 only after successful negotiation |
| Authentication | ACP | Proven with advertised `cached_token`; fresh profile advertises one `grok.com` method and a null default | Never read the credential source; accept the official nullable default and invoke only an advertised method |
| New workspace session | ACP | Proven | Absolute canonical `cwd`; empty MCP list unless explicitly configured |
| Consecutive turns | ACP | Proven | One durable Guild Run per prompt; same task/session binding |
| Streamed text and thought | ACP | Proven | Normalize session-bound updates; coalesce thought per Run |
| Multiplexed worker/reviewer activity | ACP updates for unbound child session IDs | Observed during official goal work | Order per child and expose phase/count/tool kinds only; never persist child-authored text as root output |
| Tool updates | ACP | Proven | Preserve tool-call identity and chronological state |
| Permission allow/deny | ACP | Proven | Exactly-once resolution bound to task/run/session/tool/epoch/window |
| Cancel | ACP notification + prompt terminal response | Proven | Persist `cancel_requested`; notification alone is not terminal evidence |
| Reconnect without history | ACP `session/resume` | Proven; one commands update, zero history replay | Preferred reconnect path |
| Load with replay | ACP `session/load` | Proven; history replayed | Replay admission barrier; exact v2 prompt/content/order/plan/media reconciliation; DP for optional tails; resource-bearing, lossy-tool, or message-boundary-ambiguous history fails closed |
| ACP v1 message IDs | ACP | Not supplied | Optional hint only; never a dedupe prerequisite |
| Same-process concurrency | ACP | Functional with cross-session interleaving | Supported by router, not selected as default topology |
| Isolated-process concurrency | ACP | Proven | Default: one process per active task |
| Prompt images | ACP | Not advertised | Product gap for upstream prompt; local display remains available |
| Prompt audio | ACP | Not advertised | Product gap for upstream prompt; local playback remains available |
| Prompt embedded context | ACP | Advertised | Implement only after schema and workspace boundary tests |
| HTTP/SSE MCP | ACP | Advertised | Disabled by default; opt-in configuration only |
| Account allowance and reset time | ACP/official CLI | Not advertised or observed | Show bilingual unavailable copy; do not estimate |
| Models and reasoning | Official CLI / ACP session config | `grok-4.6` and `grok-4.5` listed; ACP `session/set_model` and legacy `session/set_mode` accepted by installed 1.0.13 | Bounded selector exposes only Grok 4.6/4.5 and their verified efforts; persisted changes apply through the official process, never a provider adapter |
| Dynamic config options | ACP `session/set_config_option` | Method and boolean/select schema verified; installed session currently returned an empty option list | Render only options actually reported by the session and reject invented values |
| Official commands | ACP `available_commands_update` | Core commands plus installed skills/plugins observed | Instant core fallback, replaced by the complete live list after connection |
| Fork | Unstable ACP `session/fork` | Not advertised by installed 1.0.13; initialization reported only `close`, `list`, and `resume` session capabilities | Do not call the unadvertised method; keep the truthful local snapshot/new-session disclosure and re-probe after official runtime updates |
| Login/logout | Official CLI/ACP | Official surfaces exist; destructive logout not exercised | User initiated only; no startup prompt |
| Queue | Guild domain | Not ACP | Durable Guild operation that creates a later Run |
| Sleep/wake | Guild domain + OS/process | Not ACP; real lid gate pending | Liveness and recovery state machine; packaged acceptance required |
| Runtime incident evidence | Process host + Guild domain | Exit code/signal and bounded stderr byte accounting available locally | Private rotated JSONL without stderr content, recent-incident UI, exact-session recovery, no automatic prompt replay |

Evidence: `evidence/runtime/2026-08-26-acp-probe-summary.json` and
`evidence/probes/grok-1.0.13-session-fork.json`.
