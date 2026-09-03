import {
  CanonicalAdmissionQueue,
  HostProgramWorkspaceCoordinatorV1,
  ProgramTerminalServiceV1,
} from "@alcode/host-runtime";

let sequence = 0;
const trace = (message: string): void => {
  process.stderr.write(`[a1-terminal-trace ${++sequence}] ${message}\n`);
};

const originalComplete = ProgramTerminalServiceV1.prototype.complete;
ProgramTerminalServiceV1.prototype.complete = async function tracedComplete(command) {
  trace(`terminal.complete request program=${command.programStateId} revision=${command.expectedProgramRevision}`);
  try {
    const result = await originalComplete.call(this, command);
    trace(`terminal.complete settled status=${result.status}`);
    return result;
  } catch (error) {
    trace(`terminal.complete rejected error=${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};

const originalRunExclusive = HostProgramWorkspaceCoordinatorV1.prototype.runExclusive;
HostProgramWorkspaceCoordinatorV1.prototype.runExclusive = function tracedRunExclusive<T>(work: () => Promise<T>): Promise<T> {
  const id = ++sequence;
  trace(`coordinator.${id} request`);
  const result = originalRunExclusive.call(this, async () => {
    trace(`coordinator.${id} entered`);
    try {
      const value = await work();
      trace(`coordinator.${id} work-settled`);
      return value;
    } catch (error) {
      trace(`coordinator.${id} work-rejected error=${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });
  void result.then(
    () => trace(`coordinator.${id} returned`),
    (error) => trace(`coordinator.${id} returned-rejection error=${error instanceof Error ? error.message : String(error)}`),
  );
  return result;
};

const originalEnqueue = CanonicalAdmissionQueue.prototype.enqueue;
CanonicalAdmissionQueue.prototype.enqueue = function tracedEnqueue<T>(work: () => Promise<T>): Promise<T> {
  const id = ++sequence;
  trace(`admission.${id} request`);
  const result = originalEnqueue.call(this, async () => {
    trace(`admission.${id} entered`);
    try {
      const value = await work();
      trace(`admission.${id} work-settled`);
      return value;
    } catch (error) {
      trace(`admission.${id} work-rejected error=${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });
  void result.then(
    () => trace(`admission.${id} returned`),
    (error) => trace(`admission.${id} returned-rejection error=${error instanceof Error ? error.message : String(error)}`),
  );
  return result;
};
