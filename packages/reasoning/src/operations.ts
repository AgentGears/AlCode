// Transition intent — the pre-persistence output of semantic operations.
//
// A semantic operation validates inputs against the current graph state and
// returns a ReasoningTransitionIntent. It does NOT create the canonical node
// ID or edge ID — only after Host admission assigns the persisted event
// sequence can the reducer derive deterministic IDs.
//
// For open_investigation, which atomically emits an objective event followed
// by a hypothesis event referring to the objective, the batch intent uses
// a symbolic reference. The Host resolves the symbolic reference to the
// actual sequence-derived ID during admission.

export interface ReasoningTransitionIntent<
  TType extends string = string,
  TPayload = Record<string, unknown>,
> {
  type: TType;
  payload: TPayload;
}

/** A batch of transition intents emitted atomically (e.g. open_investigation). */
export interface ReasoningBatchIntent {
  intents: ReasoningTransitionIntent[];
  /** Symbolic references that the Host resolves during admission. */
  symbolicRefs?: Array<{
    /** The intent index that defines the ID. */
    defines: number;
    /** The intent index + payload path that references it. */
    references: Array<{ intentIndex: number; path: string }>;
  }>;
}
