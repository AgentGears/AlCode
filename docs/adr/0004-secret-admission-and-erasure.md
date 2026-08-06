# ADR 0004 — Secret Admission and Erasure

Status: **accepted** (Phase 0.0).
Resolves P0 finding: immutable history and secret removal are in tension.

## Context

The hard rules say secrets must not enter memory, logs, projection receipts,
or repository files. But user messages and tool results are common locations
for credentials and private data, and those are intended to become immutable
events. Once a raw secret hits an append-only log, tombstones do not actually
remove it.

## Decision — redaction before persistence

Redaction occurs **before event persistence**, not at projection time.

Pipeline:
1. **Environment-variable filtering.** Values of configured env vars are
   known secret sources; replaced with `secretref:<key>` before append.
2. **Pattern and entropy-based detection.** Common token formats (AWS key
   IDs, GitHub PATs, JWTs, `xoxb-` Slack tokens, etc.), high-entropy strings
   in known-sensitive tool fields, and structured patterns.
3. **Redacted payloads.** Detected secrets replaced with `secretref:<digest>`;
   the original value is never persisted in event rows, artifacts, receipts,
   or diagnostics.
4. **Encrypted artifacts.** Large tool output that must be retained but
   cannot be fully scanned is written to an encrypted artifact; key
   destruction is the erasure mechanism.
5. **Tests.** Tests prove known secret sources (env vars, configured
   credentials, provider keys, common token formats, structured tool fields)
   are caught before persistence, and that redaction markers behave correctly.

## Decision — the enforceable guarantee

> Known secret sources and detected secret patterns are redacted or rejected
> before persistence; raw secret values must never be intentionally persisted.

This is **not** absolute exclusion — no entropy or pattern detector can
promise that. The guarantee is scoped to what detection can enforce.

## Decision — incident handling for a secret that evades detection

If a secret evades detection and is persisted:

1. **Taint the event.** Mark the event row tainted in a sidecar table.
2. **Purge downstream artifacts.** Any artifact, projection receipt, memory
   record, or diagnostic derived from the tainted event is purged.
3. **Quarantine the event value.** The log is append-only, so the secret
   value is overwritten with a redaction marker in a sidecar (`event_redactions`
   table mapping `eventId` + `jsonPointer` → `secretref:<digest>`), not
   row-deleted. Replay applies redactions from the sidecar before yielding
   events to projections.
4. **Document the incident.** An incident record captures what evaded
   detection, how it was discovered, and the detector improvement.

## Consequences

- The append-only log's immutability is preserved (no row deletion) while
  still enabling effective erasure via sidecar redaction.
- Detection is treated as best-effort, with explicit incident handling for
  the residual risk.
- Projections that consume events always see the redacted form once a
  redaction exists, so downstream state converges to "no secret present."
