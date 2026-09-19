# Guild 2 roadmap and release gates

The phases are gated by evidence, not dates.

## Phase 0 — provenance and feasibility

Deliverables:

- blank repository and provenance charter;
- product contract and architecture decision record;
- Fable provenance review and Grok runtime review;
- public-documentation references for selected protocols;
- recorded ACP falsification spike against the installed official Grok runtime;
- decided process topology and an ACP/official-CLI/product-gap capability matrix;
- dependency shortlist with license, security, packaging, and maintenance assessment;
- black-box 1.1.13 visual/interaction state inventory created under the instrument-level
  capture protocol, including streaming and recovery states;
- design-lineage classification for every visual region;
- asset provenance manifest for the black-hole G, Banny, fonts, sounds, and bundled media;
- clean implementation sandbox policy, input-manifest template, and filtration log.
- immutable requirement IDs with severity, owning phase, and acceptance evidence mapping;
- orthogonal Run, session binding, transport/epoch, power, and permission transition tables;
- accepted Electron security profile and neutral migration interchange contract.

Exit gate:

- no old source in the repository or implementation context;
- live evidence identifies each required runtime behavior as ACP-primary,
  official-CLI-fallback, or product-gap;
- `session/resume`, `session/load`, permissions, usage, and concurrency are never assumed;
- unresolved ownership and protocol questions are explicit blockers;
- the visual baseline is reproducible without reading old renderer source.

## Phase 1 — vertical runtime slice

Deliverables:

- packaged shell, workspace picker, one task, and the topology proven in Phase 0;
- ACP handshake, streaming text/thought/tool events where advertised, permission round
  trip where advertised, cancel, liveness, and truthful terminal outcomes;
- SQLite persistence, WAL/crash checks, and typed IPC;
- Chinese/English switching;
- one accepted 1.1.13 conversation surface and composer reproduced from the black-box
  baseline with no redesign; full sidebar/tree parity remains Phase 2;
- explicit session-broken and reduced-fallback UI states when required by evidence.

Exit gate:

- two consecutive turns in one task;
- quit/reopen continuation with the same Grok session when `session/load` was proven;
  otherwise the local task remains intact and replacement is explicit, never silent;
- real lid-close during a running turn, wake without restart, readable history, truthful
  run state, and a successful fresh send;
- renderer reload during a run without duplicate process or duplicate send;
- no credential reads or external listener;
- malformed, silent-alive, process-death, missing-runtime, and storage-failure states
  recover truthfully.

## Phase 2 — durable conversation experience

Deliverables:

- grouped thinking/tool timeline, permission round trip, media rendering;
- queued follow-up, multiple workspaces/tasks, draft persistence;
- crash and renderer-reload recovery.
- full accepted 1.1.13 shell, sidebar/tree, conversation states, and composer parity.

Exit gate:

- cross-task/session isolation under concurrent and delayed events;
- long-conversation render and storage soak;
- no permanent thinking state after every simulated terminal path.

## Phase 3 — complete desktop workflow

Deliverables:

- project tree, context menus, archive/delete, search, account usage;
- safe Git workspace information and branch operations;
- automation/extensions only where the product contract has accepted requirements;
- optional, user-initiated browser synchronization.

Exit gate:

- all account/runtime data is official and correctly labeled;
- narrow/default/wide responsive visual matrix passes;
- all covered visual states match the 1.1.13 baseline with no unexplained diff;
- startup causes no browser, Keychain, or login prompt.

## Phase 4 — migration and polish

Deliverables:

- neutral export in Guild 1.1 and corresponding Guild 2 importer;
- optional migration preview, backup, rollback, and verification;
- visual token audit, accessibility, reduced motion, keyboard navigation;
- final visual parity sweep without altering established layout or interaction;
- external-display recovery and extended sleep/wake soak.

Exit gate:

- migration is opt-in, reversible, and does not inspect private old schemas;
- old and new apps can coexist without sharing mutable state;
- real lid-close recovery passes with an existing task and a fresh send.

## Phase 5 — release evidence

Deliverables:

- dependency inventory, SBOM, licenses/notices;
- source similarity, secret, trademark, and bundled-asset scans;
- reproducible signed build, notarization, and package hashes when publicly distributed;
- independent code, UI, runtime, security, and provenance reviews.

Exit gate:

- every P0 product contract has a passing packaged-app acceptance test;
- no P0/P1 review findings;
- source tag, package, installed app, and evidence report identify the same commit;
- stable 1.1 remains available for rollback until 2.0 migration is proven.
