#!/usr/bin/env python3
"""Ouroboros golden corpus exporter.
Run from the Ouroboros checkout (C:/Next-Era/Ouroboros/) to regenerate
packages/reasoning/fixtures/ouroboros-golden.json.

Usage:
  cd C:/Next-Era/Ouroboros
  python3 C:/AlCode/packages/reasoning/scripts/export-golden.py > C:/AlCode/packages/reasoning/fixtures/ouroboros-golden.json
"""
import json, sys, hashlib
sys.path.insert(0, ".")

from ouroboros.graph import ReasoningGraph
from ouroboros.reducer import reduce_event
from ouroboros.artifacts import Node, NodeKind, Edge, EdgeKind


def reduce_stream(session_id, events):
    g = ReasoningGraph()
    for ev in events:
        reduce_event(g, session_id, ev["sequence"], ev["type"], ev["payload"])
    return g


def graph_json(g):
    return {
        "nodes": sorted(
            [{"id": n.id, "kind": n.kind.value, "label": n.label} for n in g.nodes.values()],
            key=lambda x: x["id"],
        ),
        "edges": sorted(
            [{"source": e.source, "target": e.target, "kind": e.kind.value} for e in g.edges],
            key=lambda x: (x["source"], x["target"], x["kind"]),
        ),
    }


# Family 1: Normal flow
events1 = [
    {"sequence": 1, "type": "objective", "payload": {"statement": "fix the bug"}},
    {"sequence": 2, "type": "hypothesis", "payload": {"claim": "null pointer on line 42", "falsifier": "no crash after fix", "objective_id": "event:s:1:objective"}},
]
g1 = reduce_stream("s", events1)
r1 = graph_json(g1)

# Family 2: Replay
g2a = reduce_stream("s", events1)
g2b = reduce_stream("s", events1)

# Family 3: Event prefix
g3a = reduce_stream("s", [events1[0]])
g3b = reduce_stream("s", events1[:2])

# Family 4: Falsifier satisfied
g4 = reduce_stream("fals", [
    {"sequence": 1, "type": "objective", "payload": {"statement": "obj"}},
    {"sequence": 2, "type": "hypothesis", "payload": {"claim": "hyp", "falsifier": "it fails", "objective_id": "event:fals:1:objective"}},
])
obs = Node(kind=NodeKind.OBSERVATION, label="obs")
g4.nodes[obs.id] = obs
reduce_event(g4, "fals", 4, "falsifier_evaluation", {
    "state": "satisfied", "falsifier_id": "event:fals:2:falsifier",
    "evidence_node_ids": [obs.id], "explanation": "test passed but should have failed",
    "evaluator_version": "0.13.0", "evaluated_sequence": 4,
})
contradicts4 = [e for e in g4.edges if e.kind == EdgeKind.CONTRADICTS]
supports4 = [e for e in g4.edges if e.kind == EdgeKind.SUPPORTS]

# Falsifier refuted
g5 = reduce_stream("fals2", [
    {"sequence": 1, "type": "objective", "payload": {"statement": "obj"}},
    {"sequence": 2, "type": "hypothesis", "payload": {"claim": "hyp", "falsifier": "it fails", "objective_id": "event:fals2:1:objective"}},
])
obs2 = Node(kind=NodeKind.OBSERVATION, label="obs")
g5.nodes[obs2.id] = obs2
reduce_event(g5, "fals2", 4, "falsifier_evaluation", {
    "state": "refuted", "falsifier_id": "event:fals2:2:falsifier",
    "evidence_node_ids": [obs2.id], "explanation": "test failed to reproduce",
    "evaluator_version": "0.13.0", "evaluated_sequence": 4,
})
contradicts5 = [e for e in g5.edges if e.kind == EdgeKind.CONTRADICTS]
supports5 = [e for e in g5.edges if e.kind == EdgeKind.SUPPORTS]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()


oracle_files = [
    "ouroboros/reducer.py", "ouroboros/diagnostics.py", "ouroboros/critic.py",
    "ouroboros/branching.py", "ouroboros/verification.py", "ouroboros/graph.py",
    "ouroboros/artifacts.py", "ouroboros/cognitive.py",
]

# Compute archive SHA-256 over the concatenated file hashes (deterministic, reproducible)
import hashlib as _hl
_archive_hash = _hl.sha256()
for f in sorted(oracle_files):
    _archive_hash.update(sha256_file(f).encode("utf-8"))
    _archive_hash.update(b"\n")
archive_sha = _archive_hash.hexdigest()

output = {
    "oracle": {
        "source": "C:/Next-Era/Ouroboros/ouroboros/",
        "archiveSha256": archive_sha,
        "sourceFileHashes": {f.split("/")[-1]: sha256_file(f) for f in oracle_files},
    },
    "families": {
        "normal_flow": r1,
        "replay_a": graph_json(g2a),
        "replay_b": graph_json(g2b),
        "replay_equal": graph_json(g2a) == graph_json(g2b),
        "prefix1": graph_json(g3a),
        "prefix2": graph_json(g3b),
        "falsifier_satisfied": {"contradicts_count": len(contradicts4), "supports_count": len(supports4)},
        "falsifier_refuted": {"contradicts_count": len(contradicts5), "supports_count": len(supports5)},
    },
}
print(json.dumps(output, indent=2))
