# ALCODE Threat Model

Status: **implemented foundation through Phase 0.5**. Operationalizes ADR 0004,
ADR 0005, and the security/runtime-ownership sections of `docs/rules.md`.

## Assets

- **User source repositories** — capabilities read and may mutate these under
  Host authority.
- **Runtime state** (`~/.alcode/`) — canonical event log, projections, memories,
  reasoning state, artifacts, operation/session state, and receipts. Contains
  transcripts of user activity and tool output, which may include private data.
- **Host authority** — workspace lock, canonical admission, operation identity,
  capability execution, policy, recovery, durable work, and completion.
- **Provider credentials** — API keys/OAuth material used by provider adapters.
- **Model context** — what gets sent to the provider in each request.
- **Agent Protocol channel** — messages between the replaceable Agent process
  and Host control plane. Protocol input is a request/evidence surface, not an
  authority surface.

## Adversaries and threats

1. **Secret persistence.** A credential in a user message or tool result enters
   the append-only event log and cannot be removed by tombstone. Mitigation:
   redaction/admission before persistence (ADR 0004).
2. **Secret exfiltration to provider.** A secret in model context is sent to the
   provider. Mitigation: secret admission/redaction applies before durable
   state/context use; secrets are not intentionally included unless required.
3. **Stored injection.** A replayed memory or reasoning artifact carries a
   persistent malicious instruction. Mitigation: provenance on durable memory,
   explicit semantic boundaries, conservative verification, and no automatic
   promotion of retrieved content to trusted truth.
4. **Child-process escape.** An Agent/tool child outlives its owner and keeps
   acting. Mitigation: Host supervision, bounded/cancellable process handles,
   observed exit, and bounded event-sourced cognition work. Detached production
   workers are forbidden.
5. **Agent authority escalation.** A compromised or confused Agent attempts to
   write canonical state, seize the workspace, mint durable operation identity,
   or execute environmental capabilities directly. Mitigation: ADR 0005;
   Agent/extension code crosses the Agent Protocol, while Host policy,
   canonical admission, workspace ownership, and capability execution remain
   Host-owned. Boundary tests enforce no Agent storage/workspace authority.
6. **Unauthorized capability execution.** A model/Agent requests an unknown or
   denied mutation. Mitigation: Host policy runs before `operation.started` and
   before environmental execution; denied requests do not execute.
7. **Multi-writer corruption.** Two Hosts write the same workspace. Mitigation:
   process-held OS lock (ADR 0002).
8. **Path traversal.** A filesystem capability writes outside the authorized
   workspace. Mitigation: workspace/path validation in owned file capabilities.
9. **Networked filesystem lock failure.** OS locking is unreliable on an
   unsupported filesystem. Mitigation: fail closed (ADR 0002).
10. **SSRF via HTTP hooks.** A future user-facing hook sends requests to
    attacker-controlled/internal hosts. Mitigation: SSRF guards when 0.9 hooks
    are implemented.
11. **Foreign origin for a future local application server.** A malicious page
    reaches the loopback runtime. Mitigation: ephemeral token, origin checks,
    and loopback-only binding when that server exists.
12. **Extension trust bypass.** A future user-installed extension requests
    capabilities beyond its authorization. Mitigation: declared permissions,
    Host capability restrictions, install provenance, and disable/recovery
    mechanisms when dynamic extension loading is activated.

## Secret detection scope (enforceable, not absolute)

- **Environment-variable values** for configured secret-bearing env vars.
- **Configured credentials and provider keys.**
- **Common token formats:** AWS key IDs/secrets, GitHub PATs, GitLab tokens,
  JWTs, Slack `xoxb-`, Google API keys, private key headers (`-----BEGIN …`).
- **High-entropy strings** in known-sensitive structured fields (for example
  `Authorization`, `password`, `token`, `secret`).
- **Redaction markers** — `secretref:<digest>` references behave correctly
  under replay and projection.

## Incident handling (secret evades detection)

Per ADR 0004. The default response is the **physical security-redaction
exception** (Model A), not sidecar masking alone — sidecar redaction hides a
value from normal replay but does not erase bytes from the physical store.

1. **Revoke or rotate the compromised credential immediately.**
2. **Acquire exclusive workspace ownership** (OS lock).
3. **Record a `security.redaction_applied` audit event** with hashes/metadata,
   never the secret.
4. **Rewrite or compact the physical event store** to remove the value from the
   row and address WAL/temp files.
5. **Rebuild all projections and downstream artifacts.**
6. **Verify absence in place** — DB, WAL, artifacts, backups, receipts, and
   exported diagnostics under the applicable retention model.

For deployments requiring cryptographic erasure, Model B (per-payload
encryption + key destruction) is available only if deliberately adopted with
its required key-management model.

## Guarantees ALCODE does NOT make

- **Absolute secret exclusion.** No entropy/pattern detector can promise this.
  The enforceable guarantee is in ADR 0004.
- **A filesystem/process sandbox from cwd scoping alone.** Host capability
  mediation is an authority boundary; it is not by itself OS containment.
- **Confidentiality against a host administrator.** Local state is
  unencrypted-at-rest by default; an administrator with read access to the
  runtime state can inspect it.
- **Network security for integrations that do not yet exist.** MCP/HTTP-hook
  security is defined when those adapters are implemented; 0.9 remains future
  work.
