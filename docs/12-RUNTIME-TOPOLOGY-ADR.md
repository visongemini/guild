# D-008 — One official Grok process per active task

Status: Accepted for the first production slice
Date: 2026-08-26

## Decision

Guild starts one local official `grok agent ... stdio` process for each active task. A task
has at most one live adapter epoch. Idle processes may be torn down; a later activation uses
advertised `session/resume`, or guarded `session/load`, against the durable session binding.

## Evidence

Both compared topologies completed concurrent prompts. In the shared-process test, a late
`session_info_update` for an earlier session interleaved while two other sessions were active.
Every update carried its correct session ID, so routing remained possible. Two independent
processes each observed exactly one session and had no authentication lock failure.

## Reasoning

Isolation is more valuable than the modest memory saving of multiplexing for Guild 2's first
stable release:

- cancellation escalation can terminate the exact Run-owned process;
- process death cannot interrupt unrelated active tasks;
- permission request ownership is narrower;
- stale events are rejected using both session identity and adapter epoch;
- sleep/wake liveness can be diagnosed per task.

## Required controls

- Persist `adapterEpoch` before accepting events from a newly spawned process.
- Admit an event only when task, run where applicable, session, process epoch, and ingest mode
  match the authoritative binding.
- A process may emit late state after a prompt response; terminal Run state is absorbing.
- `session/resume` reconnects a task/session binding but never revives an interrupted Run.
- `session/load` history is staged as replay until its response barrier and reconciled without
  creating Runs or duplicating local messages.
- Idle teardown, process-count limits, and memory cost require soak evidence before raising the
  number of concurrently active tasks.

## Revisit conditions

Reconsider multiplexing only if packaged soak shows unacceptable measured resource cost and a
session/epoch/permission isolation suite proves equal reliability. Convenience alone is not a
reason to reopen this decision.
