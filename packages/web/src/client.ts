import {
  APPLICATION_PROTOCOL_VERSION,
  ApplicationSequenceGapError,
  reduceApplicationEvent,
  reduceApplicationEvents,
  type ApplicationCommand,
  type ApplicationEvent,
  type ApplicationRecoveryResult,
  type ApplicationServicePort,
  type ApplicationSnapshot,
  type CommandDecision,
  type PermissionDecision,
  type RequestedDisposition,
} from "@alcode/application-protocol";

export type ApplicationConnectionState = "disconnected" | "connecting" | "connected" | "resyncing";

export interface ApplicationClientState {
  connection: ApplicationConnectionState;
  snapshot: ApplicationSnapshot | null;
  error: string | null;
}

type Listener = () => void;

function commandId(): string {
  return globalThis.crypto.randomUUID();
}

export class ApplicationClient {
  private readonly listeners = new Set<Listener>();
  private unsubscribeTransport: (() => void) | null = null;
  private sessionId: string | null = null;
  private state: ApplicationClientState = {
    connection: "disconnected",
    snapshot: null,
    error: null,
  };
  private resyncPromise: Promise<void> | null = null;

  constructor(
    private readonly port: ApplicationServicePort,
    readonly clientId: string = commandId(),
  ) {}

  getState = (): ApplicationClientState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async connect(sessionId: string): Promise<void> {
    this.disconnect();
    this.sessionId = sessionId;
    this.setState({ connection: "connecting", snapshot: null, error: null });

    try {
      const initial = await this.port.recover(sessionId);
      this.applyRecovery(initial);
      const cursor = this.requireSnapshot().cursor;
      this.unsubscribeTransport = this.port.subscribe(sessionId, cursor, (event) => this.receive(event));

      // Close the small recover→subscribe race. If the subscription already
      // delivered a newer event, stale recovery is ignored and a later event
      // will still carry the expected fromCursor.
      const afterSubscribe = await this.port.recover(sessionId, this.requireSnapshot().cursor);
      this.applyRecoveryIfCurrent(afterSubscribe);
      this.setState({ ...this.state, connection: "connected", error: null });
    } catch (error) {
      this.setState({
        connection: "disconnected",
        snapshot: this.state.snapshot,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  disconnect(): void {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = null;
    this.sessionId = null;
    if (this.state.connection !== "disconnected") {
      this.setState({ ...this.state, connection: "disconnected" });
    }
  }

  async submit(text: string, requestedDisposition: RequestedDisposition): Promise<CommandDecision> {
    return this.execute({
      ...this.base(),
      type: "input.submit",
      text,
      requestedDisposition,
    });
  }

  async cancel(expectedExecutionId: string): Promise<CommandDecision> {
    return this.execute({
      ...this.base(),
      type: "execution.cancel",
      expectedExecutionId,
    });
  }

  async promote(queueItemId: string): Promise<CommandDecision> {
    return this.execute({
      ...this.base(),
      type: "queue.promote",
      queueItemId,
    });
  }

  async respondPermission(interactionId: string, decision: PermissionDecision): Promise<CommandDecision> {
    return this.execute({
      ...this.base(),
      type: "permission.respond",
      interactionId,
      decision,
    });
  }

  async execute(command: ApplicationCommand): Promise<CommandDecision> {
    const decision = await this.port.execute(command);
    // A command decision may advance Host state before a transport event is
    // observed. Recover to the decision cursor rather than inventing local
    // optimistic canonical state.
    if (this.sessionId && this.state.snapshot && decision.cursor > this.state.snapshot.cursor) {
      await this.resync();
    }
    return decision;
  }

  private base() {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("Application client is not connected");
    return {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: commandId(),
      clientId: this.clientId,
      sessionId,
      issuedAt: new Date().toISOString(),
    } as const;
  }

  private receive(event: ApplicationEvent): void {
    const snapshot = this.state.snapshot;
    if (!snapshot || event.sessionId !== snapshot.sessionId) return;
    try {
      const next = reduceApplicationEvent(snapshot, event);
      this.setState({ connection: "connected", snapshot: next, error: null });
    } catch (error) {
      if (error instanceof ApplicationSequenceGapError) {
        void this.resync();
        return;
      }
      this.setState({
        ...this.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resync(): Promise<void> {
    if (this.resyncPromise) return this.resyncPromise;
    const sessionId = this.sessionId;
    const snapshot = this.state.snapshot;
    if (!sessionId || !snapshot) return Promise.resolve();

    this.setState({ ...this.state, connection: "resyncing" });
    this.resyncPromise = this.port.recover(sessionId, snapshot.cursor)
      .then((result) => {
        this.applyRecoveryIfCurrent(result);
        this.setState({ ...this.state, connection: "connected", error: null });
      })
      .catch((error) => {
        this.setState({
          ...this.state,
          connection: "disconnected",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.resyncPromise = null;
      });
    return this.resyncPromise;
  }

  private applyRecovery(result: ApplicationRecoveryResult): void {
    if (result.mode === "snapshot") {
      this.setState({ ...this.state, snapshot: result.snapshot, error: null });
      return;
    }
    const current = this.state.snapshot;
    if (!current) throw new Error("Cannot apply resume events without a snapshot");
    if (current.cursor !== result.fromCursor) {
      throw new Error(`Recovery cursor mismatch: ${current.cursor} !== ${result.fromCursor}`);
    }
    this.setState({ ...this.state, snapshot: reduceApplicationEvents(current, result.events), error: null });
  }

  private applyRecoveryIfCurrent(result: ApplicationRecoveryResult): void {
    const current = this.state.snapshot;
    if (result.mode === "snapshot") {
      if (!current || result.snapshot.cursor >= current.cursor) this.applyRecovery(result);
      return;
    }
    if (current?.cursor === result.fromCursor) this.applyRecovery(result);
  }

  private requireSnapshot(): ApplicationSnapshot {
    const snapshot = this.state.snapshot;
    if (!snapshot) throw new Error("Application client has no snapshot");
    return snapshot;
  }

  private setState(next: ApplicationClientState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}
