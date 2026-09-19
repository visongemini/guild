# Guild 2 feature recovery matrix

Status: product plan. This inventory is derived from the filtered Guild 2 contract and current
user requirements. It does not inspect or reuse the 1.x renderer source.

## Product judgment

Guild 2 correctly removed provider behavior that conflicts with its role as a single-user local
client for the official Grok process. The clean-room rewrite also reduced ordinary desktop-client
conveniences too aggressively. "Official Grok only" constrains the execution boundary; it does
not require an empty settings screen or a feature-poor shell.

The target is therefore not to maximize the number of switches. It is to restore every useful,
truthful local control while refusing controls Guild cannot actually enforce or verify.

## Keep and finish in Guild itself

| Capability | Direction | Reason |
| --- | --- | --- |
| Workspace and task creation | Keep | Core local organization |
| Search, pin, rename, archive and delete | Keep and finish | Standard desktop task management |
| Running, queued, permission, interrupted and failed indicators | Delivered in 2.0.6; keep | Truthful multi-task awareness |
| Draft persistence and queued follow-ups | Keep | Local reliability |
| Profile nickname and avatar | Keep | Local-only personalization |
| Official account usage and reset time | Keep | Useful account fact; never estimate |
| Context ring and exact Token details | Keep and finish | Essential long-task feedback |
| Inline image and supported media rendering | Keep and finish | Core conversation fidelity |
| Keyboard shortcuts and discoverable command menu | Restore deliberately | High-frequency desktop convenience |
| Notification and attention policy | Delivered in 2.0.6; keep | Background work informs without stealing focus; explicit click may activate |
| Window, sidebar and last-task restoration | Keep and finish | Native desktop continuity |
| Local data location, export and safe deletion | Add in Data settings | User ownership and recovery |
| Update/version information | Add after release channel exists | Must reflect a real updater, not a decorative switch |

## Project from verified official Grok capabilities

| Capability | Direction | Gate |
| --- | --- | --- |
| Model and reasoning effort | Keep | Only values accepted by official runtime |
| Permission mode and approval requests | Keep and finish | ACP round-trip must be complete |
| Slash commands | Keep and expand | Local core snapshot; official session remains authoritative |
| Skills and plugins | Add a first-class view only when discoverable through official surfaces | Never copy private files or invent enabled state |
| Hooks | Add only after official list/add/remove behavior is verified | Otherwise expose the official slash command |
| Memory and context operations | Add only from official commands/events | Never parse private state directly |
| Session/runtime diagnostics | Add a compact read-only status surface | Facts must come from the official process |
| Login, logout and update | Add only through official Grok lifecycle commands | Guild never handles credentials itself |

## Do not restore

- MiniMax, Ornith or other third-party model/provider adapters.
- OpenAI-compatible shared endpoints, remote gateways or multi-user account sharing.
- Direct upstream requests using `~/.grok/auth.json`.
- Browser-cookie or Keychain harvesting and mandatory startup password prompts.
- Git or branch controls that cannot complete a safe end-to-end workflow.
- Decorative settings whose state is not enforced by either Guild or official Grok.

## Proposed settings information architecture

1. **General** — language, restore last task, new-task workspace, launch behavior, notifications,
   and the explicit "never steal focus for background work" policy.
2. **Grok** — model, reasoning, permissions, runtime status/version and verified official
   capabilities.
3. **Appearance** — only stable user-facing choices that preserve the accepted layout; no redesign.
4. **Data & Privacy** — local data location, export, deletion and browser-sync status.
5. **About** — Guild version, official runtime version, independent-client notice and licensing.

## Delivery order

1. Close attention-stealing, sleep/wake, stalled-run and scroll-performance defects.
2. Restore small high-frequency task and keyboard conveniences.
3. Rebuild Settings around the five sections above, with every control backed by behavior.
4. Surface skills, hooks, memory and lifecycle features only after black-box verification against
   the installed official Grok runtime.
5. Run packaged normal/narrow/wide UI checks and real multi-turn tasks before release.
