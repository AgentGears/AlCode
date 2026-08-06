# ALCODE Threat Model

Status: **Phase 0 foundation**. Operationalizes ADR 0004 and the security
section of `docs/rules.md`.

## Assets

- **User source repositories** — the agent reads and may mutate these via tools.
- **Runtime state** (`~/.alcode/`) — event log, projections, memories,
  artifacts, projection receipts. Contains transcripts of user activity and
  tool output, which frequently include credentials and private data.
- **Provider credentials** — API keys for OpenAI, Anthropic, etc.
- **Model context** — what gets sent to the provider in each request.

## Adversaries and threats

1. **Secret persistence.** A credential in a user message or tool result
   enters the append-only event log and cannot be removed by tombstone.
   Mitigation: redaction before persistence (ADR 0004).
2. **Secret exfiltration to provider.** A secret in model context is sent to
   the provider. Mitigation: redaction runs before context construction too;
   secrets never enter model context unless explicitly needed.
3. **Stored-injection.** A replayed memory or reasoning artifact carries a
   persistent malicious instruction. Mitigation: provenance on every memory
   (`sourceEventIds`); untrusted sources do not auto-inject into context.
4. **Detached worker escape.** A child process outlives the runtime and
   continues mutating state. Mitigation: supervised scheduler (rules.md §4).
5. **Multi-writer corruption.** Two runtimes write the same workspace.
   Mitigation: OS lock (ADR 0002).
6. **Path traversal.** A tool writes outside the workspace. Mitigation:
   workspace path validation in every file tool.
7. **Networked filesystem lock failure.** OS lock is unreliable on NFS/FAT.
   Mitigation: fail closed (ADR 0002).
8. **SSRF via HTTP hooks.** A user-facing hook sends requests to attacker
   hosts. Mitigation: SSRF guards (deferred to 0.9 hooks work).
9. **Foreign origin for the local runtime server.** A malicious page reaches
   the loopback runtime. Mitigation: ephemeral token, foreign-origin rejection.
10. **Extension trust bypass.** An extension reads credentials or mutates
    state it shouldn't. Mitigation: declared permissions, capability
    restrictions, install provenance.

## Secret detection scope (enforceable, not absolute)

- **Environment-variable values** for configured env vars.
- **Configured credentials and provider keys.**
- **Common token formats:** AWS key IDs/secrets, GitHub PATs, GitLab tokens,
  JWTs, Slack `xoxb-`, Google API keys, private key headers (`-----BEGIN …`).
- **High-entropy strings** in known-sensitive tool fields (e.g. `Authorization`
  headers, `password`, `token`, `secret` keys in structured tool output).
- **Redaction markers** — `secretref:<digest>` references behave correctly
  under replay and projection.

## Incident handling (secret evades detection)

Per ADR 0004. The default response is the **physical security-redaction
exception** (Model A), not sidecar masking alone — sidecar redaction masks
the value from projections but anyone reading the SQLite row directly can
still recover it, so it is not erasure.

1. **Revoke or rotate the compromised credential immediately** (primary control).
2. **Acquire exclusive workspace ownership** (OS lock).
3. **Record a `security.redaction_applied` audit event** with hashes/metadata,
   never the secret.
4. **Rewrite or compact the physical event store** to remove the value from
   the row (in place, not only in a sidecar); address WAL and temp files.
5. **Rebuild all projections and downstream artifacts.**
6. **Verify absence in place** — DB, WAL, artifacts, backups, receipts,
   diagnostics.

For deployments requiring cryptographic erasure, Model B (per-payload
encryption + key destruction) is available; it must be adopted from the start
and requires per-event-type key management.

## Guarantees ALCODE does NOT make

- **Absolute secret exclusion.** No entropy/pattern detector can promise this.
  The enforceable guarantee is in ADR 0004.
- **Confidentiality against a host administrator.** Local state is
  unencrypted-at-rest by default; an attacker with read access to `~/.alcode/`
  and the artifact keys can read it. Encrypted artifacts narrow this but do
  not eliminate it.
- **Network security when MCP/HTTP hooks are enabled.** SSRF and remote-hook
  protections are best-effort.
