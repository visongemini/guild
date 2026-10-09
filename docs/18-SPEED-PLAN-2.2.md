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
- A Run's terminal state is persisted before it is shown as finished. A process crash may lose
  at most the last ~100 ms of streamed text of a still-running Run; an OS crash or power loss at
  most the last ~2 s of it (see "Crash window" below). Neither may lose a completed Run, a
  permission decision, or a queued turn.
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

Acceptance: measured spawn-to-ready under 1 s on a warm machine (was 5.3 s median);
time from Send to `session/prompt` on the wire under 100 ms when prewarmed.

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

## WP2 and WP3 implementation notes (persistence)

Branch `speed-persist`. Code: `packages/persistence/src/store.ts`, `schema.ts` (migration v15),
`packages/contracts/src/runtime-turn-event.ts` (constructed-event registry),
`apps/desktop/src/main/live-service.ts` (`notePromptActivity`, `searchConversations`).
Benchmark: `node scripts/bench/persistence-bench.mjs --db <copy of guild.sqlite3> --repeat 3`.

### Stream coalescing

- The store, not the live service, coalesces. `commitLiveRuntimeEvent` keeps its signature and
  results. The first chunk of an entry (`create`) is committed at once. The next chunk is admitted
  against stored state (all historical checks), then opens a window; further chunks of the same
  entry, kind, protocol message id, task, Run, session and epoch with the next receive sequence and
  the next revision are admitted in memory only, because every other store call writes the open
  window before it runs, so stored state cannot change under a window.
- A window is written in ONE commit after 100 ms, or before any other store call (tool or plan
  update, permission, cancel, terminal, queue, settings, backup, close, OS suspend and so on).
  Anything unusual (gap, stale revision, size limit, other entry or kind, replay marker) writes
  the window and is judged by the ordinary path, so the historical error is returned exactly.
- Envelope shape: one `committed_envelopes` row per window holding the event of the window's
  LAST chunk (its `receive_sequence`, `idempotency_key`) with the concatenated payload text, built
  with `createRuntimeTurnEvent` so it parses and digests like any event. The row stands for the
  contiguous receive-sequence range ending at its sequence; `UNIQUE(task, epoch, sequence)` and
  the gapless-successor rule are unchanged. Earlier keys of a window are not stored: an exact
  replay of one is denied as `stale_receive_sequence`, and a replay of the last key of a
  multi-chunk row is reported as `idempotency_collision` (its fingerprint covers the merged
  payload) rather than `duplicate`. In-window duplicates and collisions are answered from memory.
  In-process keys are random UUIDs and are never replayed, so no real path is affected.
- Entry `revision` still counts chunks (a window advances it by its chunk count), so every
  caller's compare-and-set token and the planned `{entryId, appendText, revision}` delta stay
  valid. Readers (`loadConversationEntry`, the three list calls) return the entry with pending
  text applied; `searchConversationEntries` and `verifyIntegrity` write the window first.
- A failed timed write has no caller: the window is dropped (same effect as a crash), the error
  is stored and rethrown by the next store call.
- The stream path never runs the automatic WAL checkpoint (it stalled commits by 20+ ms). A
  checkpoint runs once the stream is quiet for 1 s, or when stream flushes are estimated to have
  written 32 MiB since the last one.

### Durability and crash window

`PRAGMA synchronous = NORMAL` under WAL. Every commit is synchronous (`FULL` for that commit)
except the commits of streamed text and thought chunks (entry create, window flush), which are
synchronous only when 2 s have passed since the last synchronous commit. A synchronous commit
also makes every earlier commit durable. The open-time dirty marker and migrations are
synchronous.

| Event | Process crash (SIGKILL, app crash) | OS crash or power loss |
|---|---|---|
| Streamed text of a running Run | loses the open window, at most 100 ms | loses at most about 2.1 s (open window plus unsynced flushes) |
| Tool, plan, user message, prompt acceptance, queued turn | durable | durable |
| Permission registration, decision, outbox, ACK | durable | durable |
| Terminal commit (Run, correlation, final text, context tokens) | durable | durable |

Neither case can tear a row: each flush is one commit holding the entry text and its envelope.
A completed Run is never lost because its commit is synchronous and orders after all earlier
ones. `fullfsync` is unchanged (off), as before.

### Startup, context tokens, search

- Open verifies the whole database (`integrity_check`, foreign keys, every aggregate, every
  entry and envelope through a cursor, one row alive at a time) only after an unclean shutdown or
  a reaped writer lease. After a clean shutdown it validates lazily when rows are read. An
  explicit `verifyIntegrity()` (backups) still checks everything, now streamed.
- `task_context_usage(task_id, session_id, tokens_used)` is written in the terminal commit.
  For databases written before v15 the value is recovered from the session's most recent terminal
  Runs (`prompt_correlations.terminal_key`, then the envelope by primary key, at most 64 Runs);
  `committed_envelopes` is never scanned.
- `searchConversationEntries` runs `LIKE ... ESCAPE ... LIMIT` over visible user and assistant
  text of active conversations as one sequential pass (`NOT INDEXED`; the default plan fetches
  rows at random, which is several times slower on a cold page cache). ASCII folds in SQL; a
  needle with cased non-ASCII letters is matched in JavaScript over the same rows through a
  cursor. The live service still confirms each candidate with `conversationMatches` and builds
  the snippet.
- Migration v15 (metadata only, no row is read or rewritten): replaces the append-only trigger
  with an O(1) guard (revision strictly increases, byte length never shrinks, first 64
  characters unchanged, plus every old column check) and creates `task_context_usage`. It takes
  about 70 ms on the owner's database.

### Measured

Copy of the owner's 1.02 GB database (115,628 entries, 571,680 envelopes), Node 26.8, APFS
clone per scenario. Other agents' benchmarks and an ffmpeg encode were running (load average
4-9 on 10 cores), so absolute numbers are pessimistic and noisy; the stream rows interleave
before and after runs. "Before" is `45ac713`. Only counts and timings are printed.

| Scenario | Before | After |
|---|---|---|
| Open + verify, clean shutdown | 12.8 to 13.0 s (3 runs) | 6 ms (v15 migration, once: 70 ms) |
| Open + verify, unclean shutdown | 11.9 to 17.4 s (3 runs) | 8.7 s quiet, 12 to 23 s under load (same full verification, streamed, one scan instead of two) |
| First open of the largest task (60,984 entries): restore + context tokens + first page | 626 to 1,510 ms (context tokens 621 to 1,498 ms) | 5 to 12 ms (context tokens about 1 ms) |
| Search, common word / rare word | 727 to 950 ms / 712 to 787 ms | 29 ms / 27 ms |
| 2,000 chunks of 1 to 4 characters, one every ~5 ms: total main-thread persistence time (8 runs, median and range) | 1,710 ms (1,178 to 2,298) | 102 ms (86 to 127): 16.7x less |
| Same, CPU time inside persistence | 1,493 ms | 102 ms |
| Per call p99 / per flush p99 (worst run, worst single flush) | 3.2 ms / none | 0.46 ms / 1.3 ms (2.6 ms, 4.9 ms) |
| Envelope rows for the message | 2,001 | 115 |
| Database bytes added for the message | 3.15 MB | 0.21 MB: 15x less |

On a quieter machine the stream total was 54 to 64 ms (profile runs). Reproduce with
`node scripts/bench/persistence-bench.mjs --db <copy> --repeat 3`; build the pre-change commit in
a separate directory to compare.

### Known behavior differences and follow-ups

- Exact replay of a covered, non-last chunk key is denied as stale instead of reported as a
  duplicate (see the envelope-shape bullet above). Nothing in-process replays keys.
- Search folds ASCII case in SQL; cased non-ASCII letters take the cursor path. Case folding that
  maps non-ASCII text to ASCII (for example the Kelvin sign) is not matched by an ASCII needle.
- Unclean-shutdown verification is unchanged work (about 9 to 20 s on this database) and still
  blocks startup. Moving it after first paint, or limiting history decode to rows newer than the
  last clean checkpoint, is a separate decision.
- Each flush still rewrites the whole entry row, so WAL bytes grow with the entry's text. A very
  long answer (hundreds of KiB) costs a few MiB of WAL per second; chunked text storage would
  remove that and is out of scope here.
- A later compaction of old `committed_envelopes` rows is compatible: nothing reads them on the
  hot path any more, and the context-token value no longer depends on them.

