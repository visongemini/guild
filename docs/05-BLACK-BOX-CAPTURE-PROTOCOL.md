# Guild 1.1.13 black-box capture protocol

## Purpose

Create reproducible visual and interaction requirements without obtaining old source,
DOM/CSSOM, private application data, or extracted package contents.

## Allowed instruments

- OS-level screenshots and screen recordings.
- Screen rulers, pixel/color measurement, and perceptual image comparison.
- macOS accessibility APIs limited to user-visible role, label, value, state, and screen
  geometry. Do not retain hidden identifiers or hierarchy that is not needed to describe
  visible behavior.
- OS-level process inspection limited to process names, parent/child topology, and public
  command-line evidence needed to identify the rendering/runtime class.
- Pointer, keyboard, window resize, scale, display, language, theme, reduced-motion, and
  sleep/wake observation.
- Manually prepared fixture content that contains no old private data.

## Forbidden instruments

- Electron/Chromium DevTools, `--remote-debugging-port`, inspector protocols, DOM or CSSOM
  queries, computed-style export, React/Vue inspection, or source maps.
- ASAR unpacking, application-bundle extraction, binary decompilation, or resource harvesting.
- Reads of old Guild source, diffs, logs, databases, browser storage, caches, Application
  Support data, or review transcripts that expose implementation structure.
- Copying third-party application captures as Guild implementation specifications.

## Capture record

Each artifact records:

- installed app version and package hash;
- macOS version, display scale, locale, theme, reduced-motion state, and window dimensions;
- fixture identifier and exact interaction sequence;
- instrument and method;
- screenshot/video hash and crop coordinates;
- observed geometry, timing, and interaction outcome;
- design-lineage classification and reviewer;
- any approved parity exception and reason.

## Required state matrix

Capture Chinese and English at narrow, default, and wide sizes for: new task/workspace
selection, idle and long conversations, continuous thinking, grouped tools, permission allow
and deny, file/image/media, queued follow-up, project tree/menu, account usage unavailable and
available, settings/popovers, Git hidden/available, runtime failure, session broken, resize,
external-display return, and sleep/wake return.

Streaming captures include timestamps for chunk coalescing, elapsed-time updates, tool-group
expansion, permission arrival, media insertion, cancel, and recovery. A still image alone is
not evidence for motion or event ordering.

## Baseline acceptance

The capture operator and a separate reviewer confirm that only allowed instruments were used.
The manifest is frozen and hashed before the corresponding clean implementation session. A
later correction creates a new manifest version; it never silently replaces an accepted input.
