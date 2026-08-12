from pathlib import Path

MERGE = "c4d41028d964155e0f5bb808f49e57385fed80fb"
SOURCE_HEAD = "99ea7dc524e8a3be608c6ab8f4aaf0e631a3cb14"
GATE_RUN = "31642583639"
CI_RUN = "31642583653"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)


# Frozen plan -> closed as-built contract.
p = Path("docs/phase-0.8-plan.md")
text = p.read_text()
text = replace_once(
    text,
    "**Status:** **FROZEN IMPLEMENTATION CONTRACT — implementation not started**",
    "**Status:** **CLOSED**",
    "plan status",
)
text = replace_once(
    text,
    "**Frozen:** 2026-08-12 following the Phase 0.8 pattern normalization, decision memo, and four-scenario contract pressure test.",
    f"**Frozen:** 2026-08-12 following the Phase 0.8 pattern normalization, decision memo, and four-scenario contract pressure test. **Closed:** source PR #19 head `{SOURCE_HEAD}` passed `gate:0.8` in exact-head run `{GATE_RUN}` and the full CI workflow in `{CI_RUN}`, then squash-merged to `main` as `{MERGE}`.",
    "plan frozen line",
)
marker = "---\n\n## Completion definition\n"
as_built = f'''---

## As built / closure evidence

Phase 0.8 shipped the frozen contract without reopening the 0.0–0.7 foundation:

- `@alcode/application-protocol` owns the public, versioned semantic contract, runtime command validation, public cursor/event reducer, snapshot/recovery types, and a replaceable loopback local transport adapter;
- `@alcode/host-runtime` owns the Application service/controller, command idempotence, requested/admitted input routing, Host queue identity/order, expected-execution cancellation guards, public snapshot/replay projection, and Host-owned permission interactions;
- Capability approval remains Host policy: mutating capabilities can be escalated to a Host-owned pending interaction, while React only returns a typed decision;
- `@alcode/web` is a React 19 Experience Plane client using only the Application Protocol for authoritative state; it provides session selection, transcript, structured work/Capability cards, queue, permission surface, START_NOW/GUIDE/QUEUE controls, Stop, reconnect state, and honest uncertain-effect presentation;
- disconnect/unmount does not issue cancellation; cursor gaps cause resync/snapshot rather than guessed local state;
- the current Agent Protocol has no truthful mid-turn steering seam, so `GUIDE` is explicitly rejected as `guide_not_supported` rather than silently degrading to START_NOW or QUEUE;
- React TSX rendering tests were added to the root Vitest discovery and ownership-boundary tests prevent UI/Application Protocol packages from importing Host/storage/Agent authority.

**Closure:** PR #19 final source head `{SOURCE_HEAD}` passed the dedicated Phase 0.8 run `{GATE_RUN}` (`pnpm gate:0.8`) and full composed CI run `{CI_RUN}`. PR #19 squash-merged as `{MERGE}`.

'''
if "## As built / closure evidence" not in text:
    text = replace_once(text, marker, as_built + "## Completion definition\n", "plan completion")
text = replace_once(
    text,
    "Phase 0.8 is complete when `pnpm gate:0.8` passes AC-08-01 through AC-08-10. Attractive later surfaces do not delay closure.",
    "Phase 0.8 is complete: `pnpm gate:0.8` passed AC-08-01 through AC-08-10 at the exact PR head. Attractive later surfaces remain outside the closed phase.",
    "plan completion sentence",
)
p.write_text(text)

# Roadmap orientation.
p = Path("docs/roadmap.md")
text = p.read_text()
text = replace_once(
    text,
    "Status: **active; Phases 0.0 through 0.7 closed**. Phase 0.7 closed in merge\ncommit `eae55ae657b850ab77dbbb1ba0951fe41a1c3285`; exact-head PR CI run\n`31589327975` passed `gate:0.7` and all composed foundation gates. Phase 0.8 is\nthe next planned roadmap unit.",
    f"Status: **active; Phases 0.0 through 0.8 closed**. Phase 0.8 source PR #19 final head\n`{SOURCE_HEAD}` passed `gate:0.8` in exact-head run `{GATE_RUN}` and full CI run\n`{CI_RUN}`, then squash-merged as `{MERGE}`. Phase 0.9 is the next planned roadmap unit.",
    "roadmap status",
)
text = replace_once(
    text,
    "0.8   Application protocol + React UI          PLANNED\n0.9   External adapters                        PLANNED",
    "0.8   Application protocol + React UI          CLOSED\n0.9   External adapters                        PLANNED",
    "roadmap current position",
)
old = '''## Next planned roadmap unit

### 0.8 — Application Protocol + React experience — PLANNED

Define the application transport contract before the UI, then build the React
experience as a client of ordered Host events. This phase also owns the
product-level `START_NOW`, `GUIDE`, and `QUEUE` admission semantics rather than
smuggling them into the Agent Protocol/context compiler.

Phase 0.8 was not started by Phase 0.7 closure. Its implementation requires its
own explicit authorization and acceptance boundary.

### 0.9 — External adapters — PLANNED
'''
new = f'''### 0.8 — Application Protocol + React experience — CLOSED

Established the public Host-owned Application Protocol and a React Experience
Plane without moving canonical authority into the frontend. The completed
surface includes:

- versioned/validated public commands and typed Host decisions;
- explicit requested/admitted `START_NOW`, `GUIDE`, and `QUEUE` semantics;
- Host-owned queue identity/order, duplicate protection, and target-sensitive
  cancellation;
- authoritative public snapshots, ordered cursor events, replay, gap detection,
  and snapshot fallback;
- structured Host-owned permission interactions independent of admission mode;
- public operation/effect/reconciliation projection preserving uncertainty;
- a replaceable local loopback transport seam;
- a React 19 coding shell consuming only the Application Protocol;
- executable protocol, reconnect, permission, rendering, and ownership proofs.

The current Agent Protocol has no truthful mid-turn steering seam, so GUIDE is
explicitly rejected with `guide_not_supported` rather than silently changing
its semantics. Full graph/memory/context inspectors, voice, notifications,
automations, workflows, remote workspaces, and external adapters remain outside
this closed phase.

**Gate:** `gate:0.8`, composing `gate:0.7`. Frozen/completed contract:
[`phase-0.8-plan.md`](./phase-0.8-plan.md).

**Closure:** PR #19 final source head `{SOURCE_HEAD}` passed dedicated exact-head
run `{GATE_RUN}` and full CI run `{CI_RUN}`, then squash-merged as `{MERGE}`.

---

## Next planned roadmap unit

### 0.9 — External adapters — PLANNED
'''
text = replace_once(text, old, new, "roadmap 0.8 block")
text = replace_once(
    text,
    "Phase 0.7 closure does not authorize Phase 0.8 implementation and does not\npromote `graph-v1` to the product default.",
    "Phase 0.8 closure does not authorize Phase 0.9 implementation and does not\npromote `graph-v1` to the product default.",
    "roadmap closure boundary",
)
text = replace_once(
    text,
    "- [`docs/phase-0.7-plan.md`](./phase-0.7-plan.md): completed frozen 0.7\n  design/acceptance contract and closure evidence.",
    "- [`docs/phase-0.7-plan.md`](./phase-0.7-plan.md): completed frozen 0.7\n  design/acceptance contract and closure evidence.\n- [`docs/phase-0.8-plan.md`](./phase-0.8-plan.md): completed frozen 0.8\n  Application Protocol/React contract and closure evidence.",
    "roadmap document roles",
)
p.write_text(text)

# Executable phase specification.
p = Path("docs/phase-0-spec.md")
text = p.read_text()
text = replace_once(
    text,
    "Status: **active; Phases 0.0, 0.1A, 0.1B, 0.2, 0.3, 0.4, 0.5, 0.6, and 0.7 closed**.\nPhase 0.7 closed in merge commit\n`eae55ae657b850ab77dbbb1ba0951fe41a1c3285`; exact-head PR CI run\n`31589327975` completed with `pnpm gate:0.7` and all composed foundation gates\ngreen. Phase 0.8 is the next planned roadmap unit.",
    f"Status: **active; Phases 0.0, 0.1A, 0.1B, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, and 0.8 closed**.\nPhase 0.8 source PR #19 final head `{SOURCE_HEAD}` passed `pnpm gate:0.8` in\nexact-head run `{GATE_RUN}` and full CI run `{CI_RUN}`, then squash-merged as\n`{MERGE}`. Phase 0.9 is the next planned roadmap unit.",
    "phase spec status",
)
text = replace_once(
    text,
    "│   ├── agent-protocol/    ← Host ↔ Agent semantic protocol + local IPC\n│   ├── ai/                ← provider adapters (0.1B)",
    "│   ├── agent-protocol/    ← Host ↔ Agent semantic protocol + local IPC\n│   ├── application-protocol/ ← Host ↔ Experience Plane public semantics (0.8)\n│   ├── ai/                ← provider adapters (0.1B)",
    "phase spec application package",
)
text = replace_once(
    text,
    "│   └── workspace/         ← repository/workspace identity + ownership\n├── extensions/",
    "│   ├── web/               ← React Application Protocol client (0.8)\n│   └── workspace/         ← repository/workspace identity + ownership\n├── extensions/",
    "phase spec web package",
)
text = replace_once(
    text,
    "`packages/context` is implemented and closed under Phase 0.7.\n`packages/web` is planned for 0.8 and does not exist yet.",
    "`packages/context` is implemented and closed under Phase 0.7.\n`packages/application-protocol` and `packages/web` are implemented and closed under Phase 0.8.",
    "phase spec workspace note",
)
old_start = "## Phase 0.8 — Application Protocol + React GUI\n\n**Objective:** streaming React experience over a stable Host-owned application\ntransport."
start = text.find(old_start)
end_marker = "\n---\n\n## Phase 0.9 — External integrations"
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("phase spec 0.8 block not found")
closed = f'''## Phase 0.8 — Application Protocol + React GUI — CLOSED

**Objective:** establish a stable Host-owned public Application Protocol and a
usable React Experience Plane over the same durable Host runtime, with explicit
input admission, cancellation, permission interaction, and reconnect/resume.

**As built:**

- `@alcode/application-protocol` with protocol versioning, runtime command
  validation, typed command decisions, public snapshots/cursors/events, pure
  public reducer, and replaceable local loopback transport;
- Host Application service/controller with serialized command handling,
  duplicate/stale/noop distinctions, Host-owned queue identity/order, explicit
  requested/admitted `START_NOW|GUIDE|QUEUE`, and expected-execution cancel;
- authoritative public recovery through ordered cursor replay with gap/stale
  snapshot fallback;
- structured Host-owned pending permission interactions and typed responses;
- Capability policy escalation that keeps execution authority in the Host;
- React 19 client/shell with session selection, transcript, structured current
  work/tool cards, queue, permission surface, admission controls, Stop,
  reconnect state, and honest uncertain-effect presentation;
- static ownership guards preventing Application/UI packages from importing
  storage/Host/Agent implementation authority;
- React TSX rendering discovery and dedicated `gate:0.8` CI.

`GUIDE` is explicit even though the current Agent Protocol has no safe mid-turn
steering seam: attempts are rejected as `guide_not_supported` rather than
silently becoming QUEUE or START_NOW.

**Explicit exclusions retained:** public remote wire encoding; remote Agent or
workspace transports; full graph/memory/context/trace inspectors; notifications;
voice; scheduler/automation UI; workflow/task DAG; subagent/multi-agent product
protocol; dynamic extension marketplace; exact token-delta playback; provider
redesign; `graph-v1` default promotion; Phase 0.9 adapters.

**Exit gate:** `pnpm gate:0.8` composes `gate:0.7` and passes the frozen
AC-08-01 through AC-08-10 protocol, Host authority, admission, cancellation,
recovery, permission, rendering, and ownership proofs.

**Closure:** frozen/completed contract in `docs/phase-0.8-plan.md`. PR #19 final
source head `{SOURCE_HEAD}` passed exact-head Phase 0.8 run `{GATE_RUN}` and
full CI run `{CI_RUN}`, then squash-merged as `{MERGE}`.

**Status:** CLOSED.
'''
text = text[:start] + closed + text[end:]
text = replace_once(
    text,
    "0.8   Application Protocol + React GUI        PLANNED\n0.9   External integrations                   PLANNED",
    "0.8   Application Protocol + React GUI        CLOSED\n0.9   External integrations                   PLANNED",
    "phase spec summary",
)
p.write_text(text)
