# Guild 2 product contract

Stable requirement IDs, severities, owning phases, acceptance stories, and evidence mappings are
normative in `requirements/requirements.yml`. This prose explains product intent; code and release
evidence cite the immutable IDs.

## Product definition

Guild is a bilingual, local-first desktop workspace for running coding and knowledge
tasks through the official Grok process. It is designed for one local user and one
machine profile at a time. Guild 2.0.0 targets macOS; other platforms require a later
product decision and their own parity and release gates.

## Non-negotiable boundaries

1. No shared API gateway, multi-user credential sharing, or externally reachable
   OpenAI-compatible service.
2. No direct upstream requests made with credentials extracted from Grok files.
3. The product name is Guild. It must state that it is independent from xAI.
4. Interactive permissions should use official Grok ACP over stdio. Reduced fallback
   behavior must be visibly disclosed rather than simulated.
5. Starting Guild must not request browser, Keychain, or Grok login access unless the
   user initiates the corresponding feature.

## Required product behaviors

### Projects, workspaces, and tasks

- A project/workspace is the parent of its tasks and conversations.
- A new task cannot send until a valid workspace is selected. If that folder later
  disappears from disk, send is refused before the official process starts and the
  UI names the missing folder.
- The sidebar shows a compact project tree with stable text alignment, task counts,
  selection, persistent pinning, renaming, archiving, deletion, and date-aware recent activity.
  Each conversation keeps the same alignment while its icon truthfully distinguishes running,
  queued follow-up, waiting for permission, failed, interrupted, cancelled, and idle states.
  A collapsed project preserves that visibility by showing its highest-priority task state beside
  the task count, without shifting the project name.
- Project and task context menus work with keyboard and pointer input.
- Concurrent task rows keep a stable user-established order. Starting or queueing a new user turn
  may promote that task; assistant streaming, thoughts, tools, permissions, token updates, draft
  edits and terminal-state changes must never reorder the sidebar underneath the pointer.
- Task identity, workspace, Grok session identity, and run state never silently rebind.
- A new task immediately receives a concise local fallback title from its first instruction. When
  the same official Grok session later reports its semantic session title, Guild adopts one bounded
  short title only while the fallback is still unchanged; a user rename is never overwritten.
- If the official session cannot resume and the user authorizes a replacement, the first replacement
  prompt carries a bounded task-local recovery capsule made only from that task's title, workspace,
  earlier user instructions and observed tool paths that still resolve inside the real workspace.
  Guild durably records the recovery requirement before asking the official runtime to create the
  replacement, so a crash or configuration failure after `session/new` cannot bypass the capsule.
  It never consults another task or global memory.
  If no task-local context exists, an ambiguous continuation such as `continue` is refused before a
  Run or user timeline entry is created; an explicit new task description remains allowed.

### Conversation timeline

- User content and assistant content have unambiguous authorship and consistent alignment.
- User-message actions remain available on hover and keyboard focus without reserving a blank row
  inside the visible message bubble.
- Text, code, images, audio, video, and supported documents display in the conversation.
- Composer text above the closed IPC bound is refused with a named error and is not
  persisted or sent to the official process.
- Typing `/` in the composer immediately shows the versioned core-command snapshot bundled with
  Guild. In parallel, Guild silently requests the current session catalogue from official Grok ACP
  `available_commands_update`; the session-owned list replaces the snapshot when received. Personal
  skill commands are never bundled, command input hints are preserved, and unknown slash text passes
  through unchanged.
- Every submitted slash command has a visible lifecycle acknowledgement derived from the persisted
  user entry and authoritative Run state. Commands that return only session context or hidden
  runtime control events must not leave an unexplained spinner or blank interval.
- Every accepted turn has a truthful foreground lifecycle row before Grok emits its first thought,
  tool, permission, or authored response. It distinguishes queued, preparing, accepted/waiting,
  completing, permission, and stopping states, shows elapsed wait without inventing percentage
  progress, and yields automatically to the first authoritative runtime activity. The row remains
  in normal conversation flow on the same left alignment axis as thinking and tool summaries.
- The composer accepts supported files and images through explicit user selection. Local
  media display may render workspace files; it is not represented as an ACP guarantee.
- One continuous thinking period is grouped into one disclosure, with live and final elapsed
  duration. Adjacent thought chunks do not create a noisy row-per-event transcript. Its collapsed
  summary shows the unique official tool kinds used in that period as compact, accessible icons.
  While live, the summary and sidebar derive a truthful current label such as planning, editing,
  reading, searching, executing, responding, or waiting for approval from official ACP event kind
  and status. When ACP has not reported a specific activity, Guild says only that it is working.
- Tool calls are grouped chronologically, show meaningful status, and expose details on demand.
- When an official tool result contains a bounded image, or its ACP locations identify a regular
  image inside the active workspace, the tool row exposes a localized `View Image` action. The
  first action expands a bounded preview directly below the tool row; clicking that preview opens
  the same keyboard-dismissible full-screen viewer used by inline conversation images. Renderer
  state receives only an opaque `guild-media://` grant and a display label; base64 bodies and local
  paths never cross desktop IPC. Missing, invalid, symlinked, oversized, MIME-mismatched, or
  outside-workspace candidates remain non-clickable.
- Official worker or reviewer sessions multiplexed by Grok remain separate from the root
  conversation. Guild may show their current phase, worker count, and unique tool-kind icons, but
  never persists their authored text as the root assistant reply or approves their permissions as
  though they belonged to the root task.
- File changes, diffs, and terminal output receive reviewable presentations when Grok reports
  them. Opening that task workbench creates a true third application column beside the project
  sidebar and conversation rather than covering the conversation with an overlay. The column has
  its own scroll region, a keyboard/pointer resize separator, and a locally remembered width;
  unsupported surfaces are labeled rather than replaced with decorative Git chrome.
- Permission requests are actionable and bound to the exact task and tool call.
- Long conversations remain responsive through bounded rendering, bounded inactive-task memory,
  and durable persistence; the active conversation is not truncated to enforce the cache bound.
  Reopening a task or reloading its renderer rehydrates its previously requested history pages;
  streaming projections retain the bounded live tail.
- A queued follow-up runs in the same intended task/session after the active turn completes. FIFO is
  the default. An explicit `Interrupt & run` action first persists cancellation of the active Run,
  asks official Grok to stop it, and dispatches the selected queued turn only after the old Run is
  terminal. The two root prompts never overlap.
- `Continuous task` is an explicit Guild mode, separate from official `/goal`. It preserves one
  immutable user objective, alternates one implementation Run with one evidence-based audit Run,
  and exposes cycle, phase, remaining gaps, pause/resume control, completion, and blocker state.
  Only the official Grok ACP process sends model requests. Guild never nests its controller around
  `/goal`, overlaps root prompts, silently narrows the objective, or automatically replays an
  interrupted Run. Manual queued turns take precedence over the next continuous cycle.

### Reliability

- A second and later turn must work without restarting the application.
- Normal quit, crash, renderer reload, OS sleep, lid close, network interruption, and runtime
  process failure have explicit recoverable states.
- After sleep/wake, an existing task remains readable and a new message can be sent without a
  full application restart.
- No task remains permanently in a thinking/running state after its process has ended.
- A runtime interruption records the observed process ID, exit code or signal, bounded stderr byte
  accounting without stderr content, task/run identity, one-way-hashed external session identity,
  and recovery outcome in a private rotated JSONL
  log. Recent incidents and the log location are visible in the diagnostics center. Guild never
  automatically resends an interrupted instruction: it may restore the exact official session,
  while the interrupted Run remains terminal and retry stays an explicit user action. The foreground
  distinguishes the interrupted Run from the restored session, labels an evidence-free outcome as
  unconfirmed rather than unchanged, and offers explicit edit-and-retry plus local diagnostics actions.
- Drafts and completed messages survive normal quit and crash recovery. A saved draft before
  the first sent message also prevents temporary-task cleanup when switching or restarting.
- Replacement-session handoff is durably acknowledged only after the official runtime accepts the
  first capsule-bearing prompt. A prompt too large to carry the bounded capsule is rejected without
  consuming the handoff. Later prompts are sent unchanged, and interrupted work is never automatically
  replayed. Prompt acceptance, its replay proof, and any one-time recovery handoff are committed in one
  database transaction. Guild persists a SHA-256 proof of the complete ordered outbound prompt envelope,
  including resource links. A loaded recovery capsule must match that exact proof, including its task and
  workspace identity. Because ACP replay does not expose enough identity to prove attached resources,
  any resource-bearing historical turn fails closed instead of being guessed. A similar visible short reply
  such as “继续” is never sufficient evidence that two tasks share one session.
- If the outbound prompt frame was written but its local acceptance transaction fails, Guild marks the
  outcome unconfirmed and interrupted. It must not claim that resending is safe or automatically replay it.
- Loaded history is accepted only when completed turns, any consumed recovery capsule, exact plan digest,
  ordered tool evidence, and media bytes/role all reconcile. Ambiguous user-message boundaries and tool
  evidence deliberately reduced for privacy require explicit replacement rather than a guessed resume.

### Account and runtime

- The local Guild profile (nickname and optional avatar) is stored only in Guild's private
  data directory. It is not a Grok account, does not read `~/.grok/auth.json`, and is never
  sent upstream. Avatar files are chosen through the main-process file dialog, validated by
  magic bytes, and served only through `guild-media://`.
- The account panel shows that local profile plus official Grok usage, amount used, limits
  where available, and reset time when the installed official runtime exposes them, clearly
  separate from the Guild application version and Grok runtime version. If official values
  are unavailable, the panel says so and never estimates them. It opens as a non-modal popover
  anchored immediately above the avatar in the lower-left sidebar, resizes with that sidebar,
  and never relocates to the center of the application window.
- Settings open in an independent dialog with General, Grok, Privacy, and About tabs. General
  covers language, restore-last-task, new-task workspace behavior, and persistent background-task
  notifications. Notifications are emitted only for a newly observed permission wait, completion,
  failure, or interruption while Guild is not focused. Delivery never activates Guild; clicking
  the notification is an explicit user action that opens the exact task. Grok model,
  reasoning effort, and tool authorization are sent to the official process. Tool authorization
  defaults to per-request approval; the local user may explicitly choose full access, which maps
  only to the official process's `bypassPermissions` mode and persists until changed. It never
  grants another client access to Guild or exposes a gateway. Browser login sync stays off and is
  labeled unavailable; cold start does not read browser data or the Keychain.
- Native model and reasoning selectors use the active theme's surface and text colors in both their
  closed and option states, including macOS dark appearance.
- The active conversation footer always names context status. When official ACP reports `used`
  and `size`, it shows both exact values and a percentage. Current Grok 1.0.5 instead reports
  exact context occupancy as `_meta.totalTokens` on the official prompt response; Guild shows
  that exact used-token value without inventing a window size or percentage. Missing or invalid
  values remain visibly unavailable; Guild never estimates tokens from rendered conversation text.
- Login/logout/update actions are performed through the official Grok process.
- A dedicated Grok Build feature center exposes every verified user-operable capability of the
  installed official runtime through bilingual typed controls: session commands, account/runtime,
  diagnostics, plugins and marketplaces, MCP servers, official sessions and traces, memory,
  worktrees, leaders, setup, update, and clone. The renderer can never submit raw arguments or a
  shell command; destructive operations require a second explicit confirmation. Administrative
  operations run only while every task and queue is idle, close any retained idle ACP process first,
  require an explicitly selected task workspace, admit exactly one owned Grok command at a time,
  and are aborted and joined before Guild exits. Guild never falls back to its application-data
  directory as an official command working directory. Long-running commands stream sanitized
  throttled progress (including device-login URL and code) into the feature center before process exit.
  Terminal-rendering,
  headless serialization, relay/server, debug, and shell-integration flags stay excluded because
  they are transport or developer surfaces rather than missing desktop settings.
- Guild uses the official Grok Build runtime only. It has no MiniMax, Ornith, third-party model
  adapter, OpenAI-compatible provider route, or selector containing external models. The settings
  surface may select only official Grok models and reasoning efforts supported by the runtime.
- Any model or reasoning information shown by Guild reflects only the official Grok process.
- A reduced official-CLI fallback names its missing capabilities in Chinese and English;
  it never displays interactive permission UI when permissions cannot round-trip.
- Guild remains useful when optional browser synchronization is disabled.

### Desktop interaction

- Window title-bar double-click follows platform maximize/zoom behavior.
- Layout adapts to narrow, default, and wide windows; popovers never clip beyond the window.
- Sidebar task titles consume every available pixel between the aligned state icon and the actual
  trailing metadata; empty mascot or pin slots never reserve width, and the title leaves only a
  small optical gap before the right-aligned activity time.
- The conversation column, composer border, and composer metadata share one responsive left/right
  alignment axis at every supported window width.
- Banny has exactly one persisted decorative placement. It can move in both directions between its
  main-area home and any visible task, can stay at a bounded free position elsewhere in the window,
  and snaps back to its original centered home when dropped near the conversation center. Moving or
  archiving a task must never leave Banny in an unreachable placement.
- The application recovers correctly when external displays are removed or scale changes.
- System resume refreshes lifecycle and renderer state without revealing, restoring, or focusing
  Guild. Only an explicit user activation may bring a background or minimized window forward.
- Background task start/progress/completion, notification delivery, renderer recovery, and a duplicate
  executable launch never reveal, restore, raise, or focus Guild. Renderer recovery reloads content
  inside the same native window, preserving its visibility, bounds, z-order, and focus state.
  Dock/Finder activation, a notification click, and an explicit in-app action are the only accepted
  foreground intents.
- Conversation export uses the same latest-per-tool-call projection as the visible timeline; internal
  ACP tool update history never appears as repeated tools in Markdown or JSON exports.
- Git controls either fit safely or stay hidden until their complete state is available.
- On first launch Guild selects Simplified Chinese for a Chinese system locale and English for
  other system locales. The user's later language choice persists and is never overwritten on launch.
- Local macOS release builds keep one certificate-backed designated requirement across versions so
  privacy and App Management grants can recognize an update as the same Guild application. Moving
  from an older ad-hoc build may require one final authorization; subsequent releases must not fall
  back to a build-hash-bound ad-hoc identity. Public distribution still requires its own Developer ID
  and notarization decision.

### Visual system

- **No visual redesign:** the installed Guild 1.1.13 application is the authoritative
  baseline for visible layout, component hierarchy, spacing, typography, colors, icons,
  shadows, motion, menus, responsive behavior, and interaction outcomes.
- Reproduce that accepted Guild appearance from black-box measurements and independently
  written UI code. Do not copy old CSS, JavaScript, DOM structure, or unverified assets.
- Spacing, typography, icon optical alignment, hover/pressed/focus states, and animation are
  tokenized and measurable.
- The original black-hole G and Banny character may transfer only after BDV ownership and
  canonical asset hashes are recorded in the asset provenance manifest.
- Decorative animation is stable, subtle, accessible, and disabled by reduced-motion settings.

### Visual parity gate

- Capture frozen reference states from the installed 1.1.13 package at narrow, default, and
  wide window sizes in Chinese and English.
- Cover welcome, active conversation, thinking, grouped tools, media, account usage, settings,
  project menus, dialogs, error/recovery states, and sleep/wake return.
- Major alignment axes and component bounds must match exactly where platform rendering is
  deterministic; text baselines and optical icon placement allow at most 1 px deviation.
- Automated perceptual diffs must report no unexplained changed region. Intentional platform
  variance requires a documented mask and human approval.
- Keyboard, pointer, window, responsive, and animation outcomes must match the reference state
  matrix, not merely produce a similar screenshot.
- A reliability fix may introduce only a named, reviewed recovery-state exception; it must not
  preserve a permanent-thinking defect merely to satisfy a screenshot comparison.

## Explicit non-goals for 2.0.0

- Hosting an inference gateway or team server.
- Reimplementing or bundling the Grok model/runtime.
- Routing prompts to third-party or OpenAI-compatible model providers.
- Cloning another product pixel-for-pixel or using its protected assets.
- Redesigning the accepted Guild 1.1.13 interface during the internal rewrite.
- A general-purpose browser or IDE replacement.
- Cloud task synchronization owned by Guild.
- Plugin abstractions without a verified 2.0 product requirement.

## Acceptance stories

1. Cold start with no workspace, choose a folder, send a task, receive thinking/tools/media,
   send a queued follow-up, quit, reopen, and continue the same local task. The same Grok
   session is required only if the runtime advertises and passes session reload; otherwise
   Guild discloses the broken binding and requires explicit replacement.
2. Start a long tool task, close the lid, resume, verify the exact task/run state, and send a
   new message without restarting Guild.
3. Run two tasks in different workspaces concurrently; late events, permissions, and session
   IDs must never cross between them.
4. Resize from narrow to wide while settings, account usage, project menus, and media are open;
   all remain visible and aligned.
5. Disable browser synchronization, relaunch, and verify no Keychain/browser access occurs.
6. Simulate runtime crash, missing binary, malformed event, storage failure, and network loss;
   each produces a truthful recovery path rather than permanent thinking.
7. Open the account panel, edit the local nickname and avatar, open the independent settings
   dialog, change language and startup/workspace behavior, change official Grok model and
   reasoning effort, confirm browser sync stays off, scroll a long conversation, quit and
   reopen, and find the same local profile, settings, and conversation.
8. Open the Grok Build feature center without typing `/`, inspect every verified official capability,
   run representative read-only commands, and confirm destructive actions cannot execute without the
   exact typed fields and a second confirmation.
9. Install two consecutive local Guild releases and verify their designated requirements are
   certificate-stable rather than pinned to each package hash.


## Guild 2.1 frontend redesign (2026-09-12, D-046)

The user explicitly authorized rebuilding the complete frontend. The new visual target
is the first displayed Quiet Workshop concept, admitted by the redesign design-inputs
manifest. The prior static 1.1.13 visual-parity target is superseded for Guild 2.1.
Existing single-user, official-process, persistence and permission boundaries remain.

- Organize project selection, tasks, search, tools and settings as clear user actions.
- Search results target a specific stored message and restore enough history to reveal it;
  highlight the hit and allow navigation between matches without losing drafts.
- Completed/stopped continuous work belongs to its recorded run in the conversation.
  Only actionable active, paused or blocked missions remain near the composer.
- Workbench labels its scope and offers useful empty-state actions. Real files, diffs
  and runtime observations remain distinguishable from model claims.
- Consolidate capability catalogues in Tools & Extensions; common actions precede
  advanced maintenance. Every currently supported command remains accessible.
- Provide clear current-session/default scopes, readable controls, persisted reading
  preferences, complete Chinese/English labels, and accessible keyboard focus.
- New-task suggestions fill a draft without sending it; project identity stays visible.
- Deleting a Guild workspace record never deletes the disk directory. Re-adding the
  same directory creates an empty active container and never revives deleted tasks.
- Local backups have a reviewable restore flow, validate before touching live data,
  retain rollback data, reject active runs and restore only after persistence is closed.

### Composer density refinement (2026-09-12, D-047)

The empty composer reserves one text row plus the attachment/send controls.
Explicit line breaks and wrapped text grow the input naturally; deleting or
sending text shrinks it again. The existing maximum height bounds long drafts,
which scroll internally. The outer composer retains a visible keyboard focus
indicator without a second rectangle around the textarea.

### Wordmark alignment refinement (2026-09-12, D-048)

The visible mascot and GUILD lettering share an optical vertical center.
Brand spacing accounts for transparent padding in the admitted image rather
than aligning only its full bitmap box.
