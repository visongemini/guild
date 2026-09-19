# Guild 1.1.x to Guild 2 migration interchange

## Purpose and trust boundary

This document defines the only supported migration crossing from Guild 1.1.x into the
independently implemented Guild 2. It specifies neutral meanings and wire bytes, not old
schema tables, queries, file locations, source identifiers, or exporter implementation.
The 1.1 exporter is authored and reviewed on the dirty side. The Guild 2 importer receives
only this specification and a package the user explicitly selected.

Migration is optional, user-initiated, previewed, atomic, repeatable, and reversible. Guild
2 never opens an old database, reads an old application bundle, starts the old app, imports
old code, or inspects old private storage to complete missing fields.

## Absolute privacy and discovery rules

There is no migration discovery at startup. Guild 2 must not search home directories,
Application Support, caches, browser storage, Keychain, Spotlight, process lists, mounted
volumes, backups, or common legacy paths for Guild 1.1 data. It offers an explicit
**Import Guild migration package…** action. Only after that action may it show a system file
picker and read the single package the user selects. Cancel means no read and no state change.

Neither side may read, export, infer, validate, copy, hash, or transmit old authentication
material. This prohibition includes Grok/xAI auth files, passwords, API keys, OAuth access
or refresh tokens, cookies, browser sessions, Keychain items, environment secrets, and
login caches. The neutral format has no field for them. Extensions cannot add one.

Version 1 also excludes Grok/runtime session identifiers and resumable process state. A
migrated task is historical local content with `continuationState: "history_only"`. Starting
a new continuation is a later explicit user action governed by the installed official Grok
runtime; Guild never silently binds imported history to a new or old runtime session.

User-authored messages and attachments may themselves contain sensitive text. They are user
content, not application authentication, and remain visible in the migration preview. The
exporter and importer do not upload packages or package contents for telemetry or analysis.

## Dirty-side exporter behavior

Guild 1.1 exports only after the user chooses **Export for Guild 2…**, selects the projects
or tasks to include, reviews record/media counts and exclusions, and chooses a destination.
Opening the export screen does not scan unrelated folders or authentication stores. The
exporter reads only the selected Guild-owned content through a dirty-side implementation,
takes one consistent read snapshot, normalizes it into this contract, and never changes the
old records. If selected content changes before the snapshot closes, the export either uses
the completed snapshot or fails; it never mixes versions silently.

The exporter applies the same closed schemas and resource limits as the importer, verifies
the completed package from its temporary path, then atomically renames it to the chosen
destination. It must not overwrite an existing destination without a second explicit user
decision. Cancellation or failure removes only its temporary output. The export result shows
the exact package path, counts, bytes, payload hash, unavailable attachments, and mandatory
exclusions in Chinese and English.

## Container and format version

The user-facing file is `<name>.guild-migration.zip`, a ZIP container with UTF-8 entry names.
Version 1 has exactly this layout:

```text
manifest.json
records.jsonl
blobs/sha256/<lowercase-64-hex-sha256>
```

Directories may be implicit. Entries are regular files only. Encryption, executable bits,
symlinks, hard links, device entries, alternate data streams, absolute paths, backslashes,
NULs, `.`/`..` segments, duplicate names, and Unicode- or case-folding name collisions are
forbidden. An unlisted entry is an error. The importer streams validation and must not
extract the archive with a general-purpose “extract all” operation.

`manifest.json` and each `records.jsonl` line are UTF-8 without a BOM. JSON follows RFC 8259,
uses no duplicate object member names, and is restricted to I-JSON-compatible values. Each
record is one RFC 8785 JCS canonical JSON object followed by one LF byte. Records are sorted
by the type order in this document and then by Unicode code-point order of `id`. Timestamps
are RFC 3339 UTC strings ending in `Z`. Integers outside JavaScript's safe-integer range are
decimal strings.

`formatVersion` is an integer major version. Guild 2.0 supports exactly `1`. An unsupported
major version fails before preview or mutation; it is never guessed or partly imported.
Backward-compatible additions occur only inside the namespaced `extensions` member described
below. Changing a core field, meaning, requiredness, record type, enum, ordering, or digest
rule requires a new major version.

## Manifest

The v1 manifest is a closed object with this shape:

```json
{
  "format": "com.bdv.guild.migration",
  "formatVersion": 1,
  "exportId": "019c7ba4-7d6a-7c2a-98c3-c312cd40e41a",
  "datasetId": "019c7ba4-f995-7188-b787-67184901ca56",
  "createdAt": "2026-08-26T12:34:56.000Z",
  "source": {
    "product": "Guild",
    "version": "1.1.13",
    "exporterVersion": "1"
  },
  "records": {
    "path": "records.jsonl",
    "count": 1234,
    "bytes": 567890,
    "sha256": "lowercase-64-hex"
  },
  "blobs": [
    {
      "sha256": "lowercase-64-hex",
      "bytes": 12345,
      "mediaType": "image/png"
    }
  ],
  "recordCounts": {
    "workspace": 1,
    "project": 1,
    "task": 2,
    "attachment": 3,
    "timeline": 42,
    "draft": 1
  },
  "exclusions": [
    "authentication",
    "credentials",
    "cookies",
    "browser-storage",
    "runtime-session-bindings",
    "runtime-process-state",
    "application-logs"
  ],
  "extensions": {},
  "integrity": {
    "algorithm": "sha256",
    "payloadSha256": "lowercase-64-hex"
  }
}
```

`exportId` identifies one generated package. Reusing it with different payload bytes is an
error. `datasetId` is an opaque UUID stable across exports from the same 1.1 installation;
it is not a machine identifier, username, path, credential, or hash of any of those values.
Every record `id` is opaque and stable within that dataset. How the dirty-side exporter
produces those identities is outside this crossing specification.

Every blob appears once in `blobs`, sorted by `sha256`, and has exactly one matching archive
entry. Duplicate content uses the same blob. `recordCounts` contains all six keys even when
zero and must equal the parsed records. The `exclusions` list is exact and mandatory.

To calculate `payloadSha256`:

1. Remove the `integrity` member and JCS-canonicalize the remaining manifest as
   `manifestCoreBytes`.
2. Hash the ASCII domain separator `GuildMigrationPayload/v1` followed by one NUL byte.
3. Append an unsigned 64-bit big-endian length and then the bytes for
   `manifestCoreBytes` and `records.jsonl`, in that order.
4. For each manifest blob in sorted order, append its 32 raw digest bytes and unsigned
   64-bit big-endian declared length.
5. Store the lowercase hexadecimal SHA-256 result in `integrity.payloadSha256`.

The importer separately streams and verifies the SHA-256 and length of `records.jsonl` and
every blob before calculating the payload digest. ZIP metadata and compression choices are
not hashed, so repacking identical neutral content does not change its identity. These hashes
detect corruption and support idempotency; they do not authenticate the exporter or make a
hostile package trustworthy.

## Record envelope and core records

Every line is a closed envelope:

```json
{
  "type": "task",
  "id": "opaque-stable-id",
  "revision": 1,
  "data": {},
  "extensions": {}
}
```

`id` is 1–128 Unicode scalar values with no control characters. `revision` is `1` for all
v1 records. References always target an `id` in the same package and expected record type.
The file is topologically ordered: `workspace`, `project`, `task`, `attachment`, `timeline`,
then `draft`. Within each type, IDs are unique and sorted. Cycles, dangling references, and
an ID reused across record types are errors.

Core `data` schemas are:

### `workspace`

```text
displayName: non-empty string
pathHint?: inert display-only string
```

`pathHint` is never opened, resolved, statted, watched, or trusted. During preview the user
may map the workspace through a folder picker. Only that newly selected folder receives a
normal Guild 2 workspace grant. Skipping a mapping imports the history with an unavailable
workspace; it does not trigger a filesystem search.

### `project`

```text
workspaceId: workspace reference
title: non-empty string
createdAt: RFC 3339 UTC
updatedAt: RFC 3339 UTC
archivedAt?: RFC 3339 UTC
pinned: boolean
```

### `task`

```text
projectId: project reference
title: non-empty string
createdAt: RFC 3339 UTC
updatedAt: RFC 3339 UTC
archivedAt?: RFC 3339 UTC
pinned: boolean
continuationState: exactly "history_only"
```

### `attachment`

```text
taskId: task reference
originalName: basename only, display text, not a path
mediaType: allowlisted IANA media type
bytes: non-negative safe integer
availability: "embedded" | "unavailable"
blobSha256?: required only when embedded
missingReason?: required only when unavailable
createdAt: RFC 3339 UTC
```

An embedded attachment must match its declared blob size and allowed media type after
content inspection. No record points to an external or old-app path. An unavailable
attachment remains an explicit historical placeholder; the importer never searches for it.
HTML, SVG, executable, package, script, and active-content media types are rejected in v1.

### `timeline`

```text
taskId: task reference
ordinal: non-negative safe integer, unique and increasing within task
createdAt: RFC 3339 UTC
kind: "user-message" | "assistant-message" | "thought" | "tool" | "permission" | "media"
payload: discriminator-specific closed object
```

Payloads are inert history:

- user/assistant message: `blocks`, an ordered non-empty array of `{type:"text", text}`,
  `{type:"code", text, language?}`, or `{type:"attachment", attachmentId}`;
- thought: `text` and optional non-negative `durationMs`;
- tool: `label`, optional bounded `inputSummary`/`outputSummary`, and terminal `status` of
  `completed | failed | cancelled | interrupted`;
- permission: `prompt`, optional `toolLabel`, and terminal `decision` of
  `allowed | denied | cancelled | expired`;
- media: `attachmentId` and optional `caption`.

There is no executable command, environment, raw protocol frame, pending permission,
`running` state, HTML block, runtime session ID, or tool authorization in the format. The
exporter converts any unfinished old timeline state to `interrupted` or `expired` before
writing. Imported tool and permission entries can be displayed but never replayed.

### `draft`

```text
taskId: task reference
updatedAt: RFC 3339 UTC
blocks: same inert block schema as a user message
```

There is at most one draft per task. A draft attachment must be embedded or explicitly
unavailable like any other attachment. Importing a draft does not send it.

## Unknown fields and extensions

Core objects are closed. An unknown core key, record type, revision, enum value, or payload
discriminator fails the whole package before mutation. The importer never silently drops a
record or guesses a field meaning.

The sole extension point is an `extensions` object on the manifest and record envelope.
Keys are reverse-DNS names owned by their producer, values are JCS-compatible JSON, and each
value is limited to 64 KiB and nesting depth 16. Names or values intended to carry auth,
credentials, cookies, runtime session bindings, executable code, paths to external data, or
pending capabilities are forbidden. Guild 2 ignores unknown extensions for product behavior,
lists their names and byte counts in preview, and preserves their canonical bytes in the
import ledger so a later migration export can retain them. A recognized extension has a
separate versioned schema. Malformed or forbidden extensions fail before mutation.

## Resource limits and hostile-package handling

The v1 importer enforces these hard ceilings before allocation or extraction:

- `manifest.json`: 1 MiB;
- `records.jsonl`: 1 GiB, 2,000,000 records, 4 MiB per line, nesting depth 32;
- one blob: 20 GiB; all uncompressed entries: 100 GiB;
- 200,000 blobs and a maximum declared-to-compressed ratio of 200:1;
- UTF-8 strings: 16 MiB unless a narrower field limit applies.

It checks declared sizes against ZIP central and local headers, rejects ZIP64 inconsistencies,
overlaps, trailing ambiguous archives, and decompression beyond any limit, and requires
enough free space for staging, the verified backup, database growth, and a safety margin.
Parsing, hashing, MIME inspection, and preview occur in bounded streaming workers. No archive
text is interpreted as HTML, Markdown-with-HTML, a command, SQL, URL, or local path.

## Import state machine

```text
idle -> selected -> validating -> preview_ready -> awaiting_confirmation
          |             |                |                 |
          +----------> failed <-----------+                 |
                                                          v
            cancelled <-------------------------------- staging
                                                          |
                                                          v
                                                   committing -> completed
                                                        |             |
                                                        v             v
                                                     failed       no_op_repeat
```

The importer performs these phases:

1. **Select:** read only the package returned by the user-initiated picker. Open it read-only
   and copy it to a new Guild 2 staging directory; never modify or delete the source file.
2. **Validate:** enforce container rules, limits, schemas, ordering, references, MIME policy,
   all entry hashes, and `payloadSha256`. This phase has no durable product-state writes.
3. **Preview:** show source/export version, counts, total bytes, unavailable attachments,
   unsupported extensions, workspace mapping status, exclusions, conflicts, and the exact
   changes. Previewing never starts Grok or touches hinted workspace paths.
4. **Confirm:** require a fresh explicit confirmation for that payload digest. A changed
   package invalidates confirmation.
5. **Backup:** checkpoint Guild 2 SQLite, create and verify a consistent backup plus a
   manifest of currently referenced blob hashes, and record the current schema version.
6. **Stage blobs:** stream verified blobs to temporary files on the final blob filesystem,
   `fsync`, then atomically rename them to content-addressed final names. An existing blob is
   reused only after size and hash verification and is never overwritten.
7. **Commit once:** in one SQLite transaction, allocate or reuse identity mappings, insert
   every row, tag inserted rows with the import ID, and write the completed import ledger.
   Any validation, constraint, cancellation, I/O, or database error rolls back the entire
   transaction. There is no partial project/task success mode in v1.
8. **Finalize:** `fsync` required parent directories, reopen/read the imported projection,
   verify counts and references, then report completion. Unreferenced staged blobs are safe
   to garbage-collect after a failed transaction because immutable existing blobs were not
   changed.

Putting verified immutable blobs in place before the sole database commit means that a crash
cannot leave committed rows pointing to an unplaced import blob. A crash before the database
commit leaves no visible imported records; startup recovery removes only unreferenced files
owned by that staging/import journal. A crash after commit finds a completed ledger and runs
the same verification rather than importing again.

## Idempotency and conflicts

The migration ledger has unique identities for `payloadSha256`, `exportId`, and
`(datasetId, recordType, sourceRecordId)`, plus each record's canonical SHA-256 and mapped
Guild 2 ID.

- A completed `payloadSha256` is a successful `no_op_repeat`; it creates no rows, blobs,
  backup, new IDs, or updated timestamps.
- An `exportId` already associated with different content is rejected as reused or tampered.
- A record identity already associated with the same canonical record hash is reused.
- The same record identity with a different hash is `MIGRATION_CONFLICT`; v1 aborts the full
  import and never overwrites the earlier import or unrelated Guild 2 data.
- Existing native Guild 2 IDs and names do not cause merging. Imported records receive
  generated Guild 2 IDs recorded in the mapping table; duplicate display names may coexist
  and are disclosed in preview.

This makes retry after a crash and repeated import of the same package safe. Importing a
changed later snapshot from the same old dataset is deliberately not an implicit update in
v1; it needs a future explicit merge contract rather than guessed last-write-wins behavior.

## Error, cancellation, backup, and rollback

Stable public error codes include:

```text
MIGRATION_FILE_UNREADABLE
MIGRATION_ARCHIVE_INVALID
MIGRATION_LIMIT_EXCEEDED
MIGRATION_VERSION_UNSUPPORTED
MIGRATION_SCHEMA_INVALID
MIGRATION_REFERENCE_INVALID
MIGRATION_INTEGRITY_FAILED
MIGRATION_MEDIA_REJECTED
MIGRATION_EXTENSION_FORBIDDEN
MIGRATION_CONFLICT
MIGRATION_DISK_SPACE
MIGRATION_BACKUP_FAILED
MIGRATION_STORAGE_FAILED
MIGRATION_CANCELLED
MIGRATION_VERIFY_FAILED
```

The Chinese and English UI reports the phase, code, whether Guild 2 changed, and a concrete
next action. It may show the user-selected package path, but not raw SQL, stack traces,
attachment content, hidden local paths, or auth-like values. Logs contain IDs, hashes,
counts, sizes, phase transitions, and redacted error classes only.

Cancellation during select, validation, preview, or staging removes only importer-owned
temporary files. Once the SQLite transaction begins, the UI reports “finishing safely”; it
does not interrupt between relational writes. A transaction error is automatically rolled
back. If final verification fails after commit, Guild marks the import unavailable, restores
the verified pre-import database backup through the storage recovery path, verifies it, and
retains diagnostic metadata without package content.

Every non-no-op confirmed import has a verified backup before mutation. The backup is under
Guild 2 storage only and contains no old auth. It is never silently deleted as part of the
import. **Undo import** uses the import ledger to preview and delete exactly rows introduced
by that import in one transaction, then garbage-collects blobs only when no remaining row
references them. If an imported record was edited or gained a new reference after import,
undo stops and requires a new current-state backup plus explicit destructive confirmation;
it never discards later work silently.

## Conformance and release gates

The dirty-side exporter and clean-side importer must share only versioned golden packages
and expected neutral records. Conformance tests cover:

- empty, minimum, multilingual, large, media/range, unavailable attachment, and maximum
  supported packages;
- deterministic JCS bytes, ordering, record/blob/payload hashes, and repacked ZIP identity;
- exact-repeat no-op, crash retry at every phase, reused `exportId`, same-record conflicts,
  name collisions, and cross-dataset IDs;
- truncated and duplicate entries, traversal and Unicode path variants, symlinks, ZIP bombs,
  corrupt lengths/hashes, MIME confusion, invalid UTF-8/JSON, duplicate keys, unknown core
  fields, forbidden extensions, dangling/cyclic references, and over-limit values;
- fault injection for disk full, read-only source, backup failure, SQLite failure, process
  death before/during/after commit, and final verification failure;
- a filesystem-access test policy that fails on any old-app/database/auth/browser/Keychain
  discovery attempt and proves the importer reads only the selected package plus Guild 2's
  own staging, database, backup, and blob locations;
- packaged-app preview, cancel, import, relaunch, history-only task display, explicit new
  continuation, and undo in Chinese and English.

Release evidence includes the schema fixtures and hashes, exporter/importer conformance
versions, filesystem-denial trace, crash matrix, successful atomicity/idempotency tests, and
a review confirming that no auth or runtime-session field exists in v1. Migration remains a
Phase 4 blocker until these checks pass in the packaged application.

## Interchange references

- JSON data interchange, RFC 8259: https://www.rfc-editor.org/rfc/rfc8259.html
- JSON Canonicalization Scheme, RFC 8785: https://www.rfc-editor.org/rfc/rfc8785.html
- Internet timestamps, RFC 3339: https://www.rfc-editor.org/info/rfc3339/
