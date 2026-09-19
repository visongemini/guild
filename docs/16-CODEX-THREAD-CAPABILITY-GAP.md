# Codex thread capability gap audit

Date: 2026-08-29
Guild baseline: 2.0.10 source candidate
Scope: actions and status attached to one task/thread, not global settings or model features.

## Evidence boundary

- Codex capability names come from the current Codex desktop task surface available in this
  environment. OpenAI's public documentation does not currently enumerate every desktop task-menu
  item, so this report does not pretend that the public docs are a complete menu specification.
- Guild status comes from the closed renderer IPC contract, persistence interface, task menu,
  runtime method allowlist, tests, and the current deterministic UI capture.
- Visual capture: `evidence/ui/thread-feature-audit-2026-08-29/01-thread-list.png`.

## Capability matrix

| Thread capability | Codex | Guild 2.0.10 | Judgment |
| --- | --- | --- | --- |
| Open and continue a thread | Yes | Yes | Keep |
| Continue while another turn is running | Follow-up task/message support | Yes, durable queued follow-ups | Guild is already strong |
| Stop current work | Yes | Yes | Keep |
| Running / queued / approval / failure status | Yes | Yes, distinct sidebar states | Keep |
| Rename | Yes | Yes | Complete |
| Pin / unpin | Yes | Yes, persisted ordering | Complete |
| Archive / restore | Yes | Yes | Complete |
| Delete | Yes | Yes, confirmed destructive action | Complete |
| Search tasks | Yes | Workspace, title, and bounded local transcript search | Complete |
| Fork in the same directory | Yes | Local transcript snapshot + new Grok session, with explicit disclosure | Useful but not an exact upstream fork |
| Fork into an isolated worktree | Yes | Missing | Do not add until Guild has a complete Git/worktree workflow |
| Move/handoff between checkout, worktree, host, or cloud | Yes | Missing | Codex-specific infrastructure; not a near-term Guild feature |
| Immutable share link | Yes | Missing | Do not add a public Guild gateway; prefer local export |
| Export conversation | Thread can be shared | Local Markdown + JSON export | Complete without a public gateway |
| Open thread-owned file/browser/terminal/review tabs | Yes | Local file, terminal, and diff workbench | Browser remains absent until an owned browser surface exists |
| Read status without opening the thread | Yes | Yes through sidebar projection | Complete for the user-facing case |
| Background completion notification | Yes | Yes | Complete |
| Exact task context usage | Yes | Yes when official Grok reports it | Complete within official-data limits |
| Restore the exact runtime session after restart | Yes | Yes through Grok resume/load when advertised | Complete with truthful failure recovery |
| Per-thread model and reasoning override | Supported in Codex task control | Global idle-session setting in Guild | Consider only if official Grok safely supports per-session changes |
| Decorative per-thread pet seat | No baseline requirement | Yes in 2.0.7 | Guild-only personality feature; no task authority |

## The fork problem is not just a missing menu item

Codex can fork its own thread and, when requested, pair that fork with a worktree. ACP defines an
unstable `session/fork` method, but the installed Grok 1.0.13 process does not advertise it: the
2026-09-01 initialization probe reported only `close`, `list`, and `resume` session capabilities.
An ACP client must not call an unadvertised experimental method. Copying the visible transcript into
a new Guild record therefore still does not clone Grok's hidden context or tool state.

Guild must not label a transcript copy as an exact fork. The safe implementation choices are:

1. After a future official Grok runtime advertises fork and exact ownership is proven, upgrade the
   action to the official method.
2. Until then, offer **New chat from here** and say clearly that it starts a new Grok session with a
   local transcript snapshot. Do not imply hidden context continuity.

## Recommended delivery order

1. Keep **New chat from here**, its new-session disclosure, and transcript-copy bounds covered by tests.
2. Keep local Markdown/JSON export and bounded transcript search release-gated.
3. Keep task files, explicit terminal opening, and diffs inside the canonical workspace boundary.
4. Re-probe each official Grok runtime update; upgrade to exact ACP fork only after capability
   advertisement plus separate-process ownership, recovery, and cancellation all pass.
5. Leave worktree fork, cross-host handoff, cloud share links, and Git branch controls out until a
   complete, safe end-to-end workflow exists.

## Bottom line

Guild now has the ordinary housekeeping menu, local export, transcript search, and thread-owned
file/review surfaces. Exact upstream fork is currently an official-runtime capability gap, and a
complete worktree lifecycle remains a product gap; the current branch action keeps an explicit
semantic downgrade rather than pretending either capability exists.
