# Official Grok ACP falsification spike

## Rule

Run headlessly against the exact installed official `grok` binary. Use `grok agent stdio`,
JSON-RPC/NDJSON, a disposable workspace, and scrubbed raw-frame logs. Do not build Guild UI
or read Grok authentication files. Stop and revise the product contract at the first P0 fail.

## Sequence

1. Record `grok version`, launch command, binary hash, update-suppression support, and public
   protocol references. If the installed binary does not recognize the current documented
   `--no-auto-update` flag, record that fact and prove the binary hash stayed stable.
2. Send `initialize` with only client capabilities Guild actually implements; save protocol
   version, authentication methods, and every advertised capability/config option.
3. Select only an advertised non-interactive authentication method and send `authenticate`.
   The client must not open, parse, copy, or log the credential source.
4. Create a session with an absolute disposable `cwd` and no undeclared MCP servers.
5. Prompt a turn that exercises text, thoughts, a tool, and permission when advertised.
6. Resolve one permission allow and one deny; verify session/run/tool identifiers.
7. Persist cancel intent, send the `session/cancel` notification, then wait for terminal prompt
   response or bounded process-exit/kill evidence. The notification itself is not an ack.
8. Send a second prompt on the same session without restarting the process.
9. Kill and respawn. Probe advertised `session/resume` first and assert zero history replay;
   send another prompt. In a separate process, probe `session/load`, capture all updates before
   its response as replay, and send another prompt.
10. Record whether message IDs are present and stable, but never make them a v1 correctness key.
11. During a run, close the lid or suspend for at least 60 seconds; on wake classify continued
   stream, process death, or alive-silent transport. A fresh send must work without app restart.
12. Compare two sessions in one process with two isolated processes. Attempt cross-session
    permission/event injection and check authentication/lock contention.
13. Probe usage, models, login/logout, version, and update only through documented ACP or
    official CLI operations; classify absent values as product gaps.
14. Inject missing binary, immediate exit, truncated JSON, garbage stdout, late events, and
    auth expiry. Each run must reach a truthful bounded state.

## Required evidence

- scrubbed raw stdin/stdout/stderr frames and monotonic timestamps;
- capability matrix with `ACP-primary`, `official-CLI-fallback`, or `product-gap` per item;
- process-topology decision and failure-domain analysis;
- session-reload verdict and exact product copy required when it fails;
- lid-close/liveness result;
- accepted runtime contract and state-machine revision.

## Falsifiers

- No usable `session/new` with a workspace: Guild 2 cannot be a Grok coding client as scoped.
- No second prompt on the same live session: the current reliability contract is false.
- No usable resume or guarded load: quit/reopen may keep the local task but cannot promise silent
  same-session continuation.
- No permission round trip: permission UI is unavailable in fallback mode.
- Alive-silent stdio after wake: Phase 1 requires liveness timeout and explicit interruption.
- No official usage/reset surface: the account popover must show “unavailable,” never an estimate.

## 2026-08-26 live result

The core runtime campaign passed authentication, session creation, consecutive turns,
permissions, cancel terminalization, resume, load/replay, post-restore prompts, and both
concurrency topologies. Resume emitted no history; load replayed history; ACP v1 message IDs
were absent; a shared process interleaved a late session-bound event. The accepted first-slice
contract therefore prefers resume, guards load as replay, and uses one process per active task.

Evidence: `evidence/runtime/2026-08-26-acp-probe-summary.json`. Real lid close and the injected
failure matrix remain Phase 1 packaged gates and are not represented as passed.
