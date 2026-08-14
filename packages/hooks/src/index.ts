export type HookPolicyDecision = "continue" | "ask" | "deny";

export interface HookPolicySignal {
  decision: HookPolicyDecision;
  reason?: string;
}

export interface HookPolicyAggregate {
  decision: HookPolicyDecision;
  reasons: string[];
}

const RANK: Record<HookPolicyDecision, number> = { continue: 0, ask: 1, deny: 2 };

export function combineHookPolicySignals(signals: readonly HookPolicySignal[]): HookPolicyAggregate {
  let decision: HookPolicyDecision = "continue";
  const reasons: string[] = [];
  for (const signal of signals) {
    if (RANK[signal.decision] > RANK[decision]) decision = signal.decision;
    if (signal.reason) reasons.push(signal.reason);
  }
  return { decision, reasons };
}

export type HostHookEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "input.admitted"; sessionId: string }
  | { type: "capability.before_execute"; sessionId: string; toolName: string; isReadOnly: boolean; argumentKeys: string[] }
  | { type: "capability.settled"; sessionId: string; toolName: string; outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "denied" | "stale" }
  | { type: "operation.stop_requested"; sessionId: string; operationId?: string };

export function isPolicyHookEvent(event: HostHookEvent): event is Extract<HostHookEvent, { type: "capability.before_execute" }> {
  return event.type === "capability.before_execute";
}
