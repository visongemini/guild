# Guild 2.2 speed plan

Date: 2026-10-09
Baseline: 2.1.6 (`b010cd2` + test commits), branch `guild-2.2-speed`.

## Evidence (measured 2026-10-09 on the owner's machine)

- Official `grok` 1.0.50 over raw ACP (no Guild), trivial prompt: 9-12 s from
  `session/prompt` to first chunk, warm or cold. A one-sentence question: 9-35 s.
  This floor is upstream (model + proxy). Guild cannot remove it, only avoid adding to it.
- Live DB `Guild-v2/guild.sqlite3`: 1.02 GB. `committed_envelopes` 571,680 rows / 687 MB,
  one ~1.2 KB envelope per streamed chunk (a single "。" gets its own row).
- Persistence lag per streamed event (`committed_at_ms - received.wallClockIso`, last 60k rows):
  avg 59 ms, 11 % over 100 ms, 705 events over 1 s, max 3.4 s. This runs synchronously on
  the Electron main thread (`node:sqlite`, WAL, `synchronous = FULL`).
- Cold `grok` start inside Guild (diagnostics, 107 starts): median 5.3 s, p90 8.2 s, max 25 s.
  Raw `grok agent stdio` reaches `session/new` in ~0.25 s, so most of that is Guild.
- Settings in use: `grok-4.6` + `xhigh`. Guild hard-codes `grok-4.6`/`grok-4.5` (contracts,
  persistence CHECK constraints, ACP profile) while the runtime now advertises `grok-4.7`
  (default, `high`), `grok-4.7-build-fast`, and 256k/500k context windows.

## Invariants that must not regress

- Every upstream request is still made by the official `grok` process. No auth-file reads.
- Single-user local client. Adapter only on 127.0.0.1 (unchanged).
- A Run's terminal state is persisted before it is shown as finished. A crash may lose at most
  the last ~100 ms of streamed text of a still-running Run, never a completed Run, a permission
  decision, or a queued turn.
- No replay of prompts after transport loss (existing rule).
- All existing tests pass, or are updated only where they asserted the removed per-chunk
  behavior; any such test change is listed in the PR notes.

## Work packages

### WP1 runtime cold start (runtime-locator, executable-pin, process-host, live-service lifecycle)

1. Cache the located binary (path, sha256, version) for the app lifetime, keyed by
   inode + size + mtime. Do not re-run `which`, the full hash, or `grok --version` per spawn.
2. Keep one pinned staged copy per sha256 under the staging root and reuse it while its
   stat snapshot (inode, size, mtime, mode 0500, owner) is unchanged. Hash only on first stage.
3. On OS resume, do not close healthy idle `grok` processes. Runs that were active keep the
   existing terminalization. Restart a process only on a real transport fault (write error,
   exit, or existing silence rule).
4. Prewarm: when a task becomes active (open / select / composer focus) and has no live
   controller, start spawn + initialize + authenticate + resume in the background. Never send a
   prompt. Respect the existing idle teardown.
5. Usage popover: reuse a live adapter when one exists instead of spawning a new process.

6. Child environment: Guild always sets `OPENVIKING_RECALL_COMPRESS=off` for the `grok` process
   (a fixed Guild-owned value in `buildChildEnvironment`, never inherited from the parent; the rest of
   the allowlist is unchanged). Measured 2026-10-09: every prompt first runs the user's OpenViking
   memory plugin hook `plugin/openviking-memory/hooks:user_prompt_submit`, which by default spawns a
   `claude -p` digest compressor and takes 12-16 s per prompt. With compression off the same hook takes
   0.3-0.5 s and still injects the recalled context (only not rewritten). The plugin itself is untouched.

Acceptance: measured spawn-to-ready under 1 s on a warm machine (was 5.3 s median);
time from Send to `session/prompt` on the wire under 100 ms when prewarmed.

#### WP1 results (`scripts/bench/runtime-cold-start.mjs`, real `grok` 1.0.50, no prompt sent)

Median ms of 5 runs through locate, pin and spawn, `initialize`, `authenticate` and `session/new`,
with the real `GrokProcessHost` and runtime locator. "cold" is a fresh process with an empty staging
root, "restart" a fresh process with the staged copy already on disk, "warm" the same process again.
The first block was measured on an idle machine, the second pair back to back while the machine was
loaded by parallel work (load average about 5), so absolute values drift by up to 30 % but the
before/after ratio holds.

| scenario | before | after |
|---|---|---|
| cold, idle | 1730 | 1715 (unchanged; see below) |
| restart, idle | 1706 | 403 |
| warm, idle | 1705 | 253 (locate 0, pin 3, initialize 116, session/new 133) |
| cold / restart / warm, loaded | 1815 / 1721 / 1776 | 2381 / 648 / 374 |
| cold / restart / warm, loaded, rerun | 3440 / 2938 / 1723 | 2360 / 800 / 557 |

Where the 1.7 s went: `initialize` alone was 1.27 s, against 0.11 s when the raw official binary is
spawned directly. The cause is macOS inspecting a never-executed file: a freshly copied 168 MB
copy takes 1.97 s on its first `exec` and 12 ms on the second. A new private copy per spawn paid that
every time; the shared copy pays it once per install (or reboot). The app-start warm-up
(`runtime-warmup.ts`) moves that one-time cost into the background: after it the first exec of the
staged copy took 12 ms. A cold start is therefore not faster in the benchmark, which does not include
the warm-up, but is off the critical path in the app. The field median of 5.3 s also contains cold
disk caches and wake-from-sleep effects that this idle-machine benchmark cannot reproduce.

Not measured: Send to `session/prompt` on the wire. Sending a prompt costs the user's quota, so
the prewarmed path was verified with the fake runtime (one start shared by prewarm and send, no
prompt before the send) rather than against the official process.

Finding outside WP1: on this machine the official `grok` advertises 133 slash commands, above the
128-entry `maxContentItems` limit of the ACP codec, and driving `AcpV1Adapter` standalone from a
scratch directory faults with `collection_limit_exceeded` right after `session/new`. Not reproduced
inside the app, but it would stop every start if it applies there. The benchmark therefore reads ACP
responses with a minimal loop instead of `AcpV1Adapter`.

### WP2 streaming write path (store.ts write side, live-service stream handlers)

1. Coalesce streamed text/thought chunks per entry in memory; flush in one transaction every
   100 ms or at any boundary (kind change, tool call/update, permission, plan, cancel, terminal,
   app quit, OS suspend). One envelope per flush, not per chunk.
2. `PRAGMA synchronous = NORMAL` (WAL). Terminal, permission, and queue commits stay durable
   because the WAL commit order is preserved; document the crash window.
3. Prepared-statement cache for hot statements.
4. Do not re-validate events created in-process; do not re-read an entry twice per append.
5. Replace the append-only trigger's O(n) prefix compare with a length check via a migration
   (`||` append already guarantees the prefix).

Acceptance: synthetic 2,000-chunk stream: total main-thread persistence time cut by at least
10x and p99 per-flush time under 15 ms; DB growth per streamed message cut by at least 10x.

### WP3 startup and reads (store.ts open/verify, search, context tokens)

1. Startup integrity: `quick_check` + full table decode only after an unclean shutdown. Clean
   start decodes rows lazily as they are read (decode already validates). Never load all
   `committed_envelopes` into memory.
2. `loadLatestContextTokensUsed`: persist the value per task at turn end (or add an index);
   no full envelope scan on first open.
3. Search: SQL `LIKE ... LIMIT` (or FTS5) over `conversation_entries.text_content`, not a
   decode of all 115k entries inside the command queue.

Acceptance: app open to first bootstrap with a copy of the owner's 1 GB DB under 1.5 s;
first open of the largest task under 300 ms; a search under 200 ms.

### WP4 main to renderer (publish, IPC, preload, renderer)

1. While text streams, send a small delta event `{taskId, entryId, appendText, revision}`
   on its own channel. Rebuild the full bootstrap only on structural change, and at most every
   250 ms while streaming. Tool and sub-agent updates use the non-blocking publish path.
2. `sendMessage` launches the prompt before it publishes.
3. Renderer: memoize timeline rows by `entryId + revision`; batch with `requestAnimationFrame`;
   during streaming, re-parse markdown only for the last block (or render plain text until the
   entry completes); `content-visibility: auto` on finished rows; replace post-commit scroll
   reads with an IntersectionObserver sentinel.

Acceptance: during a long streamed answer, renderer frame time stays under 16 ms at p95 and
the main thread is never blocked over 50 ms by publish work.

### WP5 follow the official model list

Read models and reasoning efforts from the ACP `initialize`/`session/new` advertisement instead
of hard-coded constants. Migrate the `grok_model` CHECK constraints. Show the official
description (e.g. that `grok-4.7-build-fast` costs 2x). Keep the user's current choice; do not
silently change it.

## Measurement harness

`scripts/bench/` (node, no Electron UI): open a copy of a given DB and time open/verify, first
task open, search; feed a synthetic 2,000-chunk stream through the live write path and report
per-flush times and DB growth. Numbers before and after go into the PR notes.
