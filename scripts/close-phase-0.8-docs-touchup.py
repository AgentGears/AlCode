from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor not found")
    return text.replace(old, new, 1)

p = Path("docs/roadmap.md")
text = p.read_text()
text = replace_once(
    text,
    "The governing ownership model is implemented through Phase 0.7:",
    "The governing ownership model is implemented through Phase 0.8:",
    "roadmap ownership intro",
)
text = replace_once(
    text,
    "## Ownership checkpoint — completed through 0.7",
    "## Ownership checkpoint — completed through 0.8",
    "roadmap ownership heading",
)
text = replace_once(
    text,
    "Phase 0.5 exercised those boundaries in production code and gates; Phase 0.6\nextended the same ownership model to durable transcript/context reconstruction;\nPhase 0.7 extended it to selective model observation. The Host owns source\nacquisition, context strategy, fallback, receipt admission, and delivery; the\nAgent consumes a disposable context decision and never owns graph traversal or\nmemory search.",
    "Phase 0.5 exercised those boundaries in production code and gates; Phase 0.6\nextended the same ownership model to durable transcript/context reconstruction;\nPhase 0.7 extended it to selective model observation; Phase 0.8 extended it to\nthe public Application Protocol and disposable React projections. The Host owns\nsource acquisition, context strategy, admission, capability policy, canonical\nstate, recovery, and completion; the Agent and Experience Plane remain clients\nof Host-owned decisions.",
    "roadmap ownership paragraph",
)
p.write_text(text)

p = Path("docs/phase-0-spec.md")
text = p.read_text()
text = replace_once(
    text,
    "- Phase 0.7 frozen/completed plan: `docs/phase-0.7-plan.md`\n- Non-goals:",
    "- Phase 0.7 frozen/completed plan: `docs/phase-0.7-plan.md`\n- Phase 0.8 frozen/completed plan: `docs/phase-0.8-plan.md`\n- Non-goals:",
    "phase spec reference list",
)
text = replace_once(
    text,
    "```text\ncoding-agent\n",
    "```text\nweb\n  └─ application-protocol\n\ncoding-agent\n",
    "phase spec web dependency",
)
text = replace_once(
    text,
    "host-runtime\n  ├─ agent-protocol\n",
    "host-runtime\n  ├─ agent-protocol\n  ├─ application-protocol\n",
    "phase spec host application dependency",
)
text = replace_once(
    text,
    "## Migration (post-0.7, when worth doing)",
    "## Migration (post-0.8, when worth doing)",
    "phase spec migration heading",
)
p.write_text(text)
