# Guild 2 production Electron security profile

## Status and scope

This profile is the mandatory production baseline for every `BrowserWindow`,
`WebContentsView`, renderer, preload, session, and custom protocol shipped by Guild 2.
It implements the process boundary in `docs/02-ARCHITECTURE.md` and the conditions of
D-007 in `docs/04-DECISION-LOG.md`. A deviation is a release blocker until it has a
specific threat analysis, a narrower compensating control, tests, and BDV approval in
the decision log. Framework defaults are not evidence of compliance: production code
sets and tests the security-relevant values explicitly.

Guild renders packaged first-party application code. It does not embed remote websites,
provide a general browser, or use `<webview>`. Untrusted conversation text, tool output,
filenames, imported data, and local media metadata are data, never executable content.

## Threat model

Assume that any renderer can be compromised by malformed or hostile content. The
security objective is to prevent that compromise from becoming arbitrary filesystem,
process, credential, database, shell, or Grok access. Also assume that IPC payloads,
custom-protocol URLs, navigation targets, imported state, and stored renderer state can
be attacker-controlled.

The renderer is therefore not a trusted authorization boundary. Main owns durable
state and privileged operations and revalidates every request against its own current
task, workspace, run, window, and capability state.

## Fixed production web preferences

The application calls `app.enableSandbox()` before `ready`. Every production web
contents sets this complete baseline rather than relying on Electron defaults:

| Preference or feature | Required value |
|---|---|
| `contextIsolation` | `true` |
| `sandbox` | `true` |
| `nodeIntegration` | `false` |
| `nodeIntegrationInWorker` | `false` |
| `nodeIntegrationInSubFrames` | `false` |
| `webSecurity` | `true` |
| `allowRunningInsecureContent` | `false` |
| `experimentalFeatures` | `false` |
| `webviewTag` | `false` |
| `plugins` | `false` |
| `navigateOnDragDrop` | `false` |
| preload | one packaged, absolute, integrity-covered Guild preload path |

Production must not pass `--no-sandbox`, enable remote debugging, enable Blink features,
or load an arbitrary preload from configuration, IPC, a URL, a workspace, or user data.
DevTools are unavailable in public production builds; a separately identified internal
diagnostic build may enable them but is not a releasable artifact.

The packaged application evaluates applicable Electron fuses at each Electron upgrade.
At minimum, production disables Run-as-Node and Node CLI inspection, prevents loading
unpacked application code where supported, and enables ASAR integrity validation where
supported. The release record captures the final fuse values and verifies them against
the packaged binary. Guild ships a supported Electron release and has a named security
update cadence; a vulnerable or end-of-support Electron line blocks release.

## Application origin and CSP

Packaged pages are served by a dedicated `guild-app:` custom protocol, not `file://`.
The scheme is registered before `ready` as `standard: true` and `secure: true` only with
the additional capabilities the packaged UI demonstrably needs. It must never set
`bypassCSP`, expose arbitrary filesystem paths, or route to the network. Its handler
serves only an immutable manifest of packaged UI assets after normalized-path and asset
membership checks.

Every application document receives this production policy as a response header:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' guild-media: data: https:; media-src guild-media:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'self'
```

The production policy contains neither `'unsafe-eval'` nor `'unsafe-inline'`. Inline
scripts, string-to-code execution, inline event handlers, remote scripts, remote styles,
and renderer network access are forbidden. If a framework build cannot run under this
policy, the dependency or build configuration changes; the production policy is not
weakened. A development-only policy may add the exact local development origin and HMR
transport, but that branch must be compile-time excluded from production and covered by
a packaged-build assertion.

`data:` is allowed only for bounded, verified raster images materialized in memory. SVG,
scripts, documents, audio, and video cannot use it. Blob URLs are not in the baseline;
adding one requires an explicit source-specific need, revocation lifecycle, size limit,
and CSP amendment review.

Credential-free `https:` is an explicit image-only exception so Markdown image results can
render in the conversation. Guild rejects URLs containing user-info, sets
`referrerPolicy="no-referrer"`, and does not permit the same origin in `connect-src`, scripts,
styles, frames, audio, or video. This is still a privacy tradeoff: the remote image host sees
the request IP address, user agent, and timing when the message is rendered. Guild's Electron
session is not used for website browsing or login, so it does not intentionally hold website
cookies. Users should treat rendering a remote image as contacting its host.

All browser permissions default to deny through session permission request and check
handlers. A product feature may allow one permission only after an explicit user action,
for the exact trusted application origin, with a documented lifetime. Application startup
does not request browser, Keychain, media-capture, notification, or Grok login access.

## Navigation, frames, and new windows

The main process installs guards on every created web contents, including future contents:

- initial application loads go through one main-owned loader that accepts only the fixed
  `guild-app://app/` origin and known entrypoints;
- `will-navigate` and `will-frame-navigate` deny every document navigation except a
  same-document navigation already within the application origin;
- `will-attach-webview` always prevents attachment;
- `setWindowOpenHandler` always returns `{ action: 'deny' }`;
- `file:`, `javascript:`, `data:`, `blob:`, `http:`, `https:`, and unknown schemes never
  become application-frame navigation targets.

The guard uses `URL` parsing and exact scheme/origin/entrypoint comparison. Prefix and
substring tests are forbidden. This guard also covers redirects and subframes; the
programmatic loader separately validates because `will-navigate` is not a complete guard
for main-initiated loads.

User-clicked external links are not opened in Guild. The renderer requests a narrowly
typed `openExternalLink` capability. Main accepts only a freshly parsed `https:` URL with
no username or password, no control characters, and a bounded length, and only from the
focused registered top-level Guild window under a main-owned rate limit. The UI sends this
request only after an explicit link action, but renderer-reported user activation is not an
authorization fact. Main then calls `shell.openExternal`. Other schemes, local paths,
command strings, and unvalidated redirects are denied. Any later requirement for another
scheme needs a separate exact allowlist and decision; it must not broaden the generic link
handler.

## IPC contract and channel allowlist

`packages/contracts` is the only source of IPC names and schemas. It generates a frozen
registry containing, for every operation, the exact channel string, direction, request
schema, success schema, error schema, payload limits, required main-owned capability, and
allowed sender window class. Production registration iterates that registry. An unknown,
duplicate, dynamically constructed, wildcard, or environment-selected channel is denied.

The logical production allowlist is limited to these capability groups:

| Group | Allowed purpose |
|---|---|
| app/settings | public app/runtime versions, locale and user preferences |
| workspace/project/task | explicit selection and validated durable CRUD |
| conversation/draft | bounded projections, pagination, drafts, and attachments |
| run/permission | start, queue, cancel, recovery, and exact run-bound decisions |
| runtime | reported capabilities and explicit official-process lifecycle actions |
| media | issue/revoke opaque grants and read safe metadata, never paths by URL |
| platform | validated external link, file/folder picker, power and Git projections |
| migration | explicit selected-package inspect, preview, confirm, cancel, and rollback |

Adding a capability group or operation requires a contract change and security review.
There is no generic `invoke(channel, ...args)`, `send`, `on`, SQL, filesystem, shell,
process, environment, URL fetch, or arbitrary command capability. Synchronous IPC is
forbidden.

For every request and event:

1. Validate the sender is the expected, live top-level frame of the exact registered
   Guild window and still has the fixed `guild-app://app/` origin. Sender URL alone is
   insufficient; main also checks the owning `webContents` identity and window class.
2. Parse with the registered closed schema before business logic. Reject unknown fields,
   invalid discriminators, invalid Unicode, oversized strings/arrays/binary values,
   non-finite numbers, and excessive nesting.
3. Authorize using main-owned current state. Renderer-supplied task, workspace, run,
   session, permission, and path identifiers are claims, not authority.
4. Canonicalize and scope filesystem paths in main after user selection; reject traversal,
   symlink escape, aliases outside the grant, and time-of-check/time-of-use changes.
5. Validate the response or pushed event against its schema before sending. Return a
   bounded public error code and localized-safe details, never a raw exception, stack,
   SQL text, environment dump, protocol frame, or secret.

Subscriptions expose a named callback wrapper and return a working unsubscribe function.
Preload removes Electron's event object before invoking renderer code. Events carry the
task/run/session tuple required by the architecture, and both main and renderer reject a
late or mismatched event. Rate, count, and byte limits apply before allocation of large
payloads; large media is never copied through IPC.

## Minimal preload surface

Preload exposes one frozen, versioned `window.guild` object through `contextBridge`. Each
method maps to exactly one registered operation with a typed argument and result. It may
perform serialization and subscription cleanup, but it contains no product state,
authorization policy, persistence, filesystem traversal, network client, runtime adapter,
or shell logic.

Preload must not expose any of the following, directly or through a wrapper:

- `ipcRenderer`, generic channel names, or Electron event objects;
- `require`, `process`, `Buffer`, Node globals, environment variables, Electron modules,
  filesystem/process/shell primitives, or constructors that recover them;
- raw `MessagePort`, `webFrame`, `nativeImage`, arbitrary callback registration, or an
  object whose properties can be replaced to expand privilege;
- secrets, tokens, cookies, loopback bearer values, Grok auth material, database handles,
  unrestricted local paths, or crash/log internals.

The preload dependency graph is statically enumerated, bundled with the app, covered by
the package integrity mechanism, and tested for accidental exports. Renderer state and
browser storage contain only non-secret presentation state. Durable authoritative state
belongs in main-owned SQLite.

## External links and local media protocol

External URL opening follows the main-owned `https:` validation path above. Remote Markdown
images use only the narrowly documented `img-src https:` exception; remote audio, video,
documents, frames, objects, scripts, styles, and renderer `fetch` remain forbidden.

Official ACP image and audio payloads are decoded in main, bounded to 8 MiB after base64
decoding, and written under Guild's private media root with a random UUID filename. Local media
is then served only through `guild-media://media/<uuid>.<allowed-extension>`. URLs never contain
the source workspace path. The handler:

The same boundary applies to tool images. Tool-result image blocks are canonical-base64 checked,
MIME allowlisted, magic-byte and dimension checked, decoded by Electron, and replaced with an
opaque grant before persistence or desktop IPC. ACP tool locations may contribute a preview only
after `realpath` proves that a no-follow regular file is inside the task workspace; the copied
private-media filename is random and the renderer receives only the basename as its label.

- accepts only `GET` and `HEAD`;
- accepts only the exact `media` host, no credentials, port, query, or fragment, and a canonical
  UUID filename with an allowlisted extension;
- opens only the joined private-root filename with `O_NOFOLLOW`, rejects symlinks, devices,
  sockets, directories, empty files, and files over 8 MiB;
- sets an allowlisted media MIME derived from verified content/type policy, plus
  `X-Content-Type-Options: nosniff`; SVG and HTML are never served as images;
- returns no directory listing, filesystem error detail, local path, or cross-origin
  access header and never sets `bypassCSP`.

The scheme is registered with only the Electron privileges required for media streaming.
It is registered on the exact session used by Guild windows. `file://` and ad hoc local
HTTP servers are not media fallbacks.

## Secrets and logging

No application-managed authentication, runtime, database, or loopback secret exists in
renderer or preload memory by design. User-authored conversation content can itself be
sensitive; it is rendered only as bounded untrusted data and is never promoted into an
application capability or copied into diagnostic logs. Grok authentication remains inside
the official Grok process and its documented lifecycle. Main never reads
`~/.grok/auth.json` for upstream calls. If a narrowly approved loopback helper ever needs
an unguessable per-process secret, it stays in main/helper memory, is never put in a URL,
renderer payload, environment inherited by unrelated children, log, crash report, or
fixture, and dies with the process.

IPC diagnostics record operation ID, outcome, duration, byte counts, and correlation IDs,
not payload bodies. Protocol logs record grant IDs only after one-way redaction and never
the mapped path. Secret scanning covers packaged renderer assets, source maps, preload,
fixtures, logs, crash data, and release evidence.

## Required verification and release evidence

The packaged application, not only source configuration, must pass:

- preference assertions for every created web contents and a test that `require`, `process`,
  Electron, Node, and arbitrary IPC are unavailable to renderer code;
- CSP tests proving inline/eval/remote script, renderer fetch, frames, and unapproved media
  are blocked under the production artifact;
- navigation, redirect, frame, drag/drop, `window.open`, `<webview>`, and malicious
  `shell.openExternal` test matrices;
- contract tests that reject every unregistered channel, invalid/oversized request,
  unknown field, wrong sender frame/window, stale capability, cross-task tuple, and raw
  event-object exposure;
- local-media tests for traversal and encoding variants, symlink swaps, range edges, MIME
  confusion, revoked/cross-window grants, large files, and disappearance during streaming;
- production fuse, remote-debugging, DevTools, dependency, source-map, and secret scans.

The release evidence records the Electron version, security-review date, preference and
fuse snapshots, generated IPC registry hash, CSP string, protocol test results, and any
approved exception. A failed or missing assertion blocks the release gate.

## Official Electron references

- Security checklist and guidance: https://www.electronjs.org/docs/latest/tutorial/security
- Process sandboxing: https://www.electronjs.org/docs/latest/tutorial/sandbox
- Context isolation: https://www.electronjs.org/docs/latest/tutorial/context-isolation
- Web preferences: https://www.electronjs.org/docs/latest/api/structures/web-preferences
- Context bridge: https://www.electronjs.org/docs/latest/api/context-bridge
- Renderer IPC: https://www.electronjs.org/docs/latest/api/ipc-renderer
- IPC tutorial: https://www.electronjs.org/docs/latest/tutorial/ipc
- Navigation and window controls: https://www.electronjs.org/docs/latest/api/web-contents
- Renderer-created windows: https://www.electronjs.org/docs/latest/api/window-open
- Custom protocols: https://www.electronjs.org/docs/latest/api/protocol
- External shell operations: https://www.electronjs.org/docs/latest/api/shell
