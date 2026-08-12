# ALCODE Threat Model

Status: **implemented foundation through Phase 0.7**. Operationalizes ADR 0004,
ADR 0005, and the security/runtime/context-ownership sections of
`docs/rules.md`.

## Assets

- **User source repositories** — capabilities read and may mutate these under
  Host authority.
- **Runtime state** (`~/.alcode/`) — canonical event log, projections, memories,
  reasoning state, artifacts, operation/session state, transcript state, and
  context receipts. Contains transcripts of user activity and tool output,
  which may include private data.
- **Host authority** — workspace lock, canonical admission, operation identity,
  capability execution, policy, recovery, durable work, context strategy,
  context receipt admission, and completion.
- **Provider credentials** — API keys/OAuth material used by provider adapters.
- **Model context** — what gets sent to the provider in each request, including
  Host-authorized `verbatim-v1` or opt-in `graph-v1` observation.
- **Agent Protocol channel** — messages between the replaceable Agent process
  and Host control plane. Protocol input is a request/evidence surface, not an
  authority surface.

## Adversaries and threats

1. **Secret persistence.** A credential in a user message or tool result enters
   the append-only event log and cannot be removed by tombstone. Mitigation:
   redaction/admission before persistence (ADR 0004).
2. **Secret exfiltration to provider.** A secret in model context is sent to the
   provider. Mitigation: secret admission/redaction applies before durable
   state/context use; workspace observation and context receipts are bounded and
   must not introduce/persist raw secrets; secrets are not intentionally
   included unless required.
3. **Stored injection / control-authority confusion.** A replayed memory,
   reasoning artifact, objective, evidence record, or workspace-derived string
   carries persistent malicious or instruction-like text. Mitigation: Phase 0.7
   trust classes and structured canonical rendering enforce
   `canonical source text ≠ host_control`; source-derived text remains data under
   Host-authored framing, and gate evidence covers stored-injection containment.
4. **Stale or unauthorized provider context.** The Agent attempts a provider
   request without a fresh Host decision, or reuses a turn-start context after
   tool/cognition/workspace state changes. Mitigation: a graph-capable Agent
   awaits `context.update` immediately before every provider stream; no Host
   context response means no provider request.
5. **Context receipt contamination.** A canonical context-decision receipt is
   later treated as reasoning evidence, memory provenance fallback, or a new
   task-world observation. Mitigation: `context.projection_compiled` is
   `audit_meta`; generic source/provenance scans explicitly exclude it from
   cognition/context facts.
6. **Child-process escape.** An Agent/tool child outlives its owner and keeps
   acting. Mitigation: Host supervision, bounded/cancellable process handles,
   observed exit, and bounded event-sourced cognition work. Detached production
   workers are forbidden.
7. **Agent authority escalation.** A compromised or confused Agent attempts to
   write canonical state, seize the workspace, mint durable operation identity,
   execute environmental capabilities directly, select context, search memory,
   or traverse reasoning state. Mitigation: ADR 0005 and Phase 0.7 ownership
   boundaries; Agent/extension code crosses the Agent Protocol while Host policy,
   canonical admission, workspace ownership, capability execution, context
   selection, fallback, and receipt persistence remain Host-owned.
8. **Unauthorized capability execution.** A model/Agent requests an unknown or
   denied mutation. Mitigation: Host policy runs before `operation.started` and
   before environmental execution; denied requests do not execute.
9. **Multi-writer corruption.** Two Hosts write the same workspace. Mitigation:
   process-held OS lock (ADR 0002).
10. **Path traversal.** A filesystem capability writes outside the authorized
    workspace. Mitigation: workspace/path validation in owned file capabilities.
11. **Networked filesystem lock failure.** OS locking is unreliable on an
    unsupported filesystem. Mitigation: fail closed (ADR 0002).
12. **SSRF via HTTP hooks.** A future user-facing hook sends requests to
    attacker-controlled/internal hosts. Mitigation: SSRF guards when 0.9 hooks
    are implemented.
13. **Foreign origin for a future local application server.** A malicious page
    reaches the loopback runtime. Mitigation: ephemeral token, origin checks,
    and loopback-only binding when that server exists.
14. **Extension trust bypass.** A future user-installed extension requests
    capabilities beyond its authorization. Mitigation: declared permissions,
    Host capability restrictions, install provenance, and disable/recovery
    mechanisms when dynamic extension loading is activated.

## Selective-context security invariants

Phase 0.7 closes these additional security properties:

- `host_control` is reserved for Host-authored renderer/control semantics;
  canonical user/model/tool/memory/reasoning/workspace text cannot acquire it by
  persistence alone.
- Workspace context is a bounded read-only observation with explicit provenance;
  it does not grant the context compiler mutation or arbitrary file-reading
  authority.
- Required graph facts are never silently dropped to satisfy a budget. If the
  deterministic post-render bound cannot be met safely, graph compilation falls
  back to `verbatim-v1`.
- `chars4-v1` is diagnostic/comparative only; it is not represented as a
  provider-independent safety bound.
- Context receipt payloads store digests of raw base system prompt/tool
  definitions rather than making those raw values canonical.
- Graph selection is read-only over memory/reasoning state and does not
  reinforce memory or mutate cognition merely because an item is visible to the
  model.
- `verbatim-v1` remains the product default after Phase 0.7 closure; successful
  graph evaluation does not self-promote policy.

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
- **Provider-independent exact context-window safety from `graph-v1`.** Phase
  0.7 enforces a serialized-character graph bound and records approximate token
  cost; provider-exact tokenization/window enforcement remains deferred.
- **Universal superiority or default readiness of graph context.** The closed
  evaluation proves a non-vacuous selective-observation value case, not that
  graph beats verbatim on every task.
- **Confidentiality against a host administrator.** Local state is
  unencrypted-at-rest by default; an administrator with read access to the
  runtime state can inspect it.
- **Network security for integrations that do not yet exist.** MCP/HTTP-hook
  security is defined when those adapters are implemented; 0.9 remains future
  work.
