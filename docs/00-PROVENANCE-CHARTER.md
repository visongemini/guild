# Guild 2 provenance charter

## Objective

Build a functionally complete Guild desktop application whose first-party source,
design system, tests, documentation, and original assets are independently created
for BDV. Third-party dependencies and the official Grok runtime remain external and
are never represented as BDV property.

## Why this is a new repository

A normal branch would inherit the earlier repository's source and history. Guild 2
starts from an empty repository so provenance can be demonstrated from its first
commit. The stable 1.1 line remains separate and usable.

## Threat model and design lineage

The old 1.1 repository is excluded as a precaution because its mixed human/agent
authorship, inherited framework history, and modification chain cannot support a
simple claim that every first-party line is BDV-original. This new repository is
intended to produce a traceable first-party implementation; it does not erase or
relicense the old line and is not evidence that the old line was unlawful.

The installed 1.1.13 appearance was refined through BDV-directed iteration. Its
lineage includes explicit reference to common desktop-client patterns and to Claude
Desktop for alignment and interaction quality. That fact must be recorded, not
hidden. Before a public 2.0 release, the visual inventory must classify each state as
conventional desktop behavior, BDV-directed original treatment, licensed asset, or
third-party-influenced treatment requiring legal/product disposition. No third-party
icon, artwork, copy, or distinctive brand identifier transfers.

D-006 remains the internal product baseline. If the lineage inventory cannot support
exact parity for a specific region, that region becomes an explicit, minimal product
exception approved by BDV; it is never silently redesigned or masked. The project
does not claim that visual parity itself creates new ownership.

## Separation model

There are three roles:

1. **Product specification:** translates user requirements and black-box behavior
   into observable contracts. It must not paste implementation details.
2. **Implementation:** receives only a content-addressed allow-listed snapshot in a separate,
   independently initialized repository and named allowed public references. It does not receive
   this governance repository or its reachable Git objects.
   It must run under a recorded filesystem policy that cannot access the earlier
   source tree, installed 1.1 bundle/private data, or dirty-side transcripts.
3. **Independent review:** tests provenance evidence, runtime correctness, and
   acceptance behavior without authoring the same implementation.

The original Codex operator has seen the earlier source and therefore is not, alone,
strong clean-room evidence. Production implementation should be assigned to fresh,
isolated implementation contexts that receive only this repository. Codex may own
the dirty-side product contract, integration decisions, verification, and final
adjudication. Only filtered requirements and decisions cross to implementers.

Every crossing document receives a filtration record confirming it contains observable
behavior, functional constraints, or conventional architecture only. A designated
dirty-side reviewer separately checks that prescribed structure is not a recreation
of distinctive old-source organization.

The clean snapshot is a file-level export, never a clone, fork, bundle, or worktree. Its first Git
commit contains only allow-listed filtered files with recorded SHA-256 values. Reviews, prompts,
raw/sanitized runtime evidence, governance commit objects, and earlier implementation history are
not reachable from that repository. The implementation sandbox denies this governance repository
after export as well as every older prohibited source/data location.

## Reference rules

Allowed:

- user-authored requirements and corrections;
- observing inputs, outputs, layout behavior, recovery, and performance of a released
  application as a black box;
- capturing reproducible screenshots, accessibility trees, component bounds, colors,
  typography, and interaction outcomes from the installed Guild 1.1.13 application
  under `docs/05-BLACK-BOX-CAPTURE-PROTOCOL.md`;
- official Electron, macOS, Windows, Git, SQLite, and Grok/ACP documentation;
- generally known interaction patterns and accessibility conventions.

Forbidden:

- copying or translating earlier source code;
- paraphrasing distinctive comments or reproducing internal names and organization;
- extracting an installed app to recover its implementation;
- giving implementation workers an old-repository diff or architecture dump;
- treating visual assets or another product's trade dress as source material.
- DevTools, remote-debugging ports, DOM/CSSOM queries, ASAR or bundle extraction,
  and reads of the old application's private data.

The accepted Guild 1.1.13 UI is a product requirement for 2.0, not an implementation
source. Recreating its visible result from black-box measurements is allowed. Copying old
renderer code, stylesheets, DOM structure, or unverified assets is not.

BDV icon and character assets may be transferred only after an asset-specific
provenance review records their category, original source outside the old repository
and installed bundle, rights, evidence, canonical file hash, and approval. Asset
transfer does not permit source-code transfer.

## Ownership statement

BDV will claim copyright only in independently created Guild 2 material. Dependency
licenses, runtime ownership, and trademarks remain separate. Open-sourcing BDV-owned
code under a permissive license does not transfer BDV's copyright.

## Evidence ledger

Every release candidate must preserve:

- the blank-repository creation record;
- specification and decision history preceding implementation;
- implementation-agent source-access attestations;
- mechanical isolation policies, complete clean-side input manifests, and transcripts;
- specification-filtration logs and dirty-side dissimilarity determinations;
- requirement-to-test and requirement-to-commit traceability;
- dependency license inventory and SBOM;
- similarity scan against prohibited baselines;
- black-box visual baseline manifest and packaged-app visual diffs;
- owned-asset provenance manifest and checksums;
- secret, credential, trademark, and bundled-asset scan;
- attributed review reports and packaged-app acceptance evidence.

Ledger artifacts live in `evidence/` or a named immutable release archive and are
hash-referenced from release tags. The human BDV owner countersigns the ledger index.
AI reports are attributed tool output, not signatures.

The Guild 1.1 neutral exporter is authored on the dirty side in the old codebase.
Only the neutral format specification—field meanings and semantics, never exporter
code, old schema DDL, or storage queries—may cross through the filtration channel.

## External reviews for this planning gate

- Codex: technical feasibility, state integrity, migration risk, and testability.
- Claude Fable: provenance separation, ownership claims, and evidence sufficiency.
- Grok 4.6: official runtime integration, capability coverage, and real-world agent UX.
