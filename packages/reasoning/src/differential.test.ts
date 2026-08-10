// Ouroboros differential golden corpus — executes TypeScript reasoning
// functions against checked-in JSON fixtures.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  reduceStream,
  reduceEvent,
  createReasoningGraph,
  createReductionIndex,
  deriveNodeId,
  getEdgesByKind,
  EdgeKind as EK,
  NodeKind as NK,
  type ReasoningNode,
} from "./index.ts";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

describe("differential: normal flow", () => {
  const fixture = loadFixture("normal-flow.json") as {
    cases: Array<{
      name: string;
      events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
      expected: { nodeCount: number; edgeCount: number; nodeKinds: string[] };
    }>;
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const graph = reduceStream("s", c.events as never);
      expect(graph.nodes.size).toBe(c.expected.nodeCount);
      expect(graph.edges.size).toBe(c.expected.edgeCount);
      const kinds = new Set<string>([...graph.nodes.values()].map((n) => n.kind));
      for (const k of c.expected.nodeKinds) expect(kinds.has(k)).toBe(true);
    });
  }
});

describe("differential: replay/duplicate", () => {
  const fixture = loadFixture("replay-duplicate.json") as {
    cases: Array<{
      name: string;
      events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
      sessionId: string;
      expected: { nodeCount: number; edgeCount: number };
    }>;
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const g1 = reduceStream(c.sessionId, c.events as never);
      const g2 = reduceStream(c.sessionId, c.events as never);
      expect(g1.nodes.size).toBe(c.expected.nodeCount);
      expect(g1.edges.size).toBe(c.expected.edgeCount);
      // Determinism: same stream → same graph
      expect(g2.nodes.size).toBe(g1.nodes.size);
      expect(g2.edges.size).toBe(g1.edges.size);
    });
  }
});

describe("differential: event-prefix reconstruction", () => {
  const fixture = loadFixture("event-prefix.json") as {
    cases: Array<{
      name: string;
      events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
      sessionId: string;
      expected: { nodeCount: number; edgeCount: number };
    }>;
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const graph = reduceStream(c.sessionId, c.events as never);
      expect(graph.nodes.size).toBe(c.expected.nodeCount);
      expect(graph.edges.size).toBe(c.expected.edgeCount);
    });
  }
});

describe("differential: falsifier path (satisfied≠refuted)", () => {
  const fixture = loadFixture("falsifier.json") as {
    cases: Array<{
      name: string;
      sessionId: string;
      setupEvents: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
      evalEvent: { sequence: number; type: string; payload: Record<string, unknown> };
      evidenceNode: { sequence: number; kind: string; label: string };
      expected: { contradictsEdgeCount: number; supportsEdgeCount: number };
    }>;
  };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const graph = reduceStream(c.sessionId, c.setupEvents as never);

      // Add evidence node manually
      const obsId = deriveNodeId(c.sessionId, c.evidenceNode.sequence, c.evidenceNode.kind);
      graph.nodes.set(obsId, {
        id: obsId, kind: c.evidenceNode.kind as unknown as NK, label: c.evidenceNode.label,
        data: {}, confidence: null, step: null,
      });

      // Apply the evaluation event
      reduceEvent(graph, c.sessionId, c.evalEvent.sequence, c.evalEvent.type,
        c.evalEvent.payload, createReductionIndex());

      expect(getEdgesByKind(graph, EK.CONTRADICTS).length).toBe(c.expected.contradictsEdgeCount);
      expect(getEdgesByKind(graph, EK.SUPPORTS).length).toBe(c.expected.supportsEdgeCount);
    });
  }
});
