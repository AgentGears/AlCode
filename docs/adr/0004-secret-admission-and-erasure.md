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

## Decision — masking vs erasure (honesty about the sidecar)

An earlier draft described sidecar redaction as "effective erasure." It is
not. Sidecar redaction substitutes a `secretref:` marker when *replay* yields
events to projections, but **anyone reading the SQLite row directly can still
recover the raw secret**, and the value persists in WAL, backups, and any
already-derived artifact. Calling this "erasure" overstates the guarantee.

Two remediation models are available; ALCODE adopts the first as the default
incident response and offers the second as a stronger option.

### Model A — Physical security-redaction exception (default)

When a persisted secret is discovered, the append-only rule is *intentionally
overridden* for this one class of incident. Logical history and auditability
are preserved by recording what was removed; physical storage is rewritten.

1. **Revoke or rotate the compromised credential immediately.** This is the
   primary control; storage remediation is secondary.
2. **Acquire exclusive workspace ownership** (the OS lock, ADR 0002).
3. **Record a `security.redaction_applied` audit event** containing hashes and
   metadata (event id, json pointer, detector version, redactor version) —
   never the secret itself. This event is the audit trail.
4. **Rewrite or compact the physical event store** to remove the value from
   the affected event payload (replacing it with `secretref:<digest>` in the
   row itself, not only in a sidecar). WAL checkpoints and temporary files are
   addressed by the rewrite.
5. **Rebuild all projections and downstream artifacts** from the rewritten
   store so derived state converges to "no secret present."
6. **Verify the raw value is absent** from the database, WAL, artifacts,
   backups, receipts, and diagnostics. The gate is absence-in-place, not just
   absence-on-replay.

This admits that security erasure can override physical append-only storage.
The audit event preserves the *fact* of removal without preserving the value.

### Model B — Per-payload encryption with key destruction (optional, stronger)

Encrypt every event payload at append time with sufficiently granular keys;
make key destruction the erasure mechanism. Destroying the key for a tainted
event renders its payload cryptographically unrecoverable without rewriting
the row. Encrypting only large artifacts does **not** solve secrets
accidentally persisted in ordinary event rows, so this option requires
per-payload (or per-event-type) encryption, not just artifact encryption.

Model B is more expensive (key management, per-event crypto) and is therefore
optional. If a deployment's threat model demands cryptographic erasure,
adopt Model B from the start; otherwise Model A is the default.

## Consequences

- The system does not claim physical erasure it cannot perform. Sidecar
  redaction is documented as *masking on replay*, useful for projections and
  context construction but insufficient for security erasure.
- A discovered secret triggers Model A by default: a recorded audit event, a
  physical store rewrite, projection rebuild, and an absence-in-place check.
- Model B is available for deployments requiring cryptographic erasure.
- Detection remains best-effort; the residual risk (a secret evades detection
  and is only later discovered) is handled by the incident models above, not
  promised away.
