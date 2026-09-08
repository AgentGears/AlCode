from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"{label} insertion point not found")
    return source.replace(old, new, 1)


broker = Path("packages/host-runtime/src/capability-broker.ts")
source = broker.read_text()
source = replace_once(
    source,
    '''      execution = await capability.execute(frozenArgs, context);
      const rawOutcome = execution.outcome ?? "succeeded";
      outcome = programVerificationOperationOutcome(request, execution, rawOutcome);''',
    '''      execution = await capability.execute(frozenArgs, context);
      console.error(`[p02-post pid=${process.pid}] capability-returned operation=${String(operationId)} tool=${request.toolName} raw=${String(execution.outcome ?? "succeeded")}`);
      const rawOutcome = execution.outcome ?? "succeeded";
      outcome = programVerificationOperationOutcome(request, execution, rawOutcome);
      console.error(`[p02-post pid=${process.pid}] outcome-normalized operation=${String(operationId)} outcome=${String(outcome)}`);''',
    "capability return",
)
source = replace_once(
    source,
    '''    const resultData = verificationResultData(execution, outcome);
    const verification = await this.cognition.evaluateVerification(request.sessionId as string, verificationPlan.match, resultData);''',
    '''    const resultData = verificationResultData(execution, outcome);
    console.error(`[p02-post pid=${process.pid}] cognition-start operation=${String(operationId)}`);
    const verification = await this.cognition.evaluateVerification(request.sessionId as string, verificationPlan.match, resultData);
    console.error(`[p02-post pid=${process.pid}] cognition-done operation=${String(operationId)} matched=${String(verification !== null)}`);''',
    "cognition evaluation",
)
source = replace_once(
    source,
    '''    if (program !== null && workspaceAccessClass === "may_write" && this.programOperationAuthority !== undefined) {
      await this.programOperationAuthority.settleProgramMutation({''',
    '''    if (program !== null && workspaceAccessClass === "may_write" && this.programOperationAuthority !== undefined) {
      console.error(`[p02-post pid=${process.pid}] settlement-start operation=${String(operationId)}`);
      await this.programOperationAuthority.settleProgramMutation({''',
    "settlement start",
)
source = replace_once(
    source,
    '''        buildTerminalDrafts: terminalDraftsForHead,
      });
    } else {''',
    '''        buildTerminalDrafts: terminalDraftsForHead,
      });
      console.error(`[p02-post pid=${process.pid}] settlement-done operation=${String(operationId)}`);
    } else {''',
    "settlement done",
)
source = replace_once(
    source,
    '''    this.catchUpBarriers();
    return this.finish(request, { operationId, outcome, result: execution.result });''',
    '''    console.error(`[p02-post pid=${process.pid}] final-catchup-start operation=${String(operationId)}`);
    this.catchUpBarriers();
    console.error(`[p02-post pid=${process.pid}] final-catchup-done operation=${String(operationId)}`);
    return this.finish(request, { operationId, outcome, result: execution.result });''',
    "final catchup",
)
broker.write_text(source)


dispatch = Path("packages/host-runtime/src/program-dispatch.ts")
source = dispatch.read_text()
method_marker = "  async settleProgramMutation(\n"
method_index = source.find(method_marker)
if method_index < 0:
    raise SystemExit("settleProgramMutation method not found")
prefix = source[:method_index]
method = source[method_index:]
method = replace_once(
    method,
    '''    return this.options.workspaceCoordinator.runExclusive(async () => {
      const postObservation = input.quiescenceProven
        ? await this.options.observations.observe()
        : null;''',
    '''    console.error(`[p02-settle pid=${process.pid}] coordinator-wait operation=${operationId}`);
    return this.options.workspaceCoordinator.runExclusive(async () => {
      console.error(`[p02-settle pid=${process.pid}] coordinator-enter operation=${operationId}`);
      console.error(`[p02-settle pid=${process.pid}] observation-start operation=${operationId} quiescence=${String(input.quiescenceProven)}`);
      const postObservation = input.quiescenceProven
        ? await this.options.observations.observe()
        : null;
      console.error(`[p02-settle pid=${process.pid}] observation-done operation=${operationId} status=${String(postObservation?.status ?? "skipped")}`);''',
    "settlement coordinator observation",
)
method = replace_once(
    method,
    '''      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);''',
    '''      console.error(`[p02-settle pid=${process.pid}] admission-wait operation=${operationId}`);
      return this.options.admission.enqueue(async () => {
        console.error(`[p02-settle pid=${process.pid}] admission-enter operation=${operationId}`);
        const events = await replayAll(this.options.store);
        console.error(`[p02-settle pid=${process.pid}] replay-done operation=${operationId} events=${events.length}`);
        const state = requireProgramState(events, programStateId);''',
    "settlement admission",
)
method = replace_once(
    method,
    '''        const head = await this.options.store.headSequence();
        const terminalDrafts = [...input.buildTerminalDrafts(head)];''',
    '''        console.error(`[p02-settle pid=${process.pid}] head-start operation=${operationId}`);
        const head = await this.options.store.headSequence();
        console.error(`[p02-settle pid=${process.pid}] head-done operation=${operationId} sequence=${head}`);
        console.error(`[p02-settle pid=${process.pid}] drafts-start operation=${operationId}`);
        const terminalDrafts = [...input.buildTerminalDrafts(head)];
        console.error(`[p02-settle pid=${process.pid}] drafts-done operation=${operationId} count=${terminalDrafts.length}`);''',
    "settlement drafts",
)
method = replace_once(
    method,
    '''        const persisted = await this.options.store.append(settlementDrafts);
        for (let i = 0; i < persisted.length; i++) {''',
    '''        console.error(`[p02-settle pid=${process.pid}] append-start operation=${operationId} count=${settlementDrafts.length}`);
        const persisted = await this.options.store.append(settlementDrafts);
        console.error(`[p02-settle pid=${process.pid}] append-done operation=${operationId} count=${persisted.length}`);
        for (let i = 0; i < persisted.length; i++) {''',
    "settlement append",
)
dispatch.write_text(prefix + method)


adaptive = Path("packages/host-runtime/src/program-adaptive-operation-v2.ts")
source = adaptive.read_text()
method_marker = "  async settleProgramMutation(\n"
method_index = source.find(method_marker)
if method_index < 0:
    raise SystemExit("adaptive settleProgramMutation method not found")
prefix = source[:method_index]
method = source[method_index:]
method = replace_once(
    method,
    '''    try {
      await this.options.currentState.current(input.program.programStateId);
    } catch (error) {''',
    '''    console.error(`[p02-adaptive-settle pid=${process.pid}] current-start operation=${String(input.operationId)}`);
    try {
      await this.options.currentState.current(input.program.programStateId);
      console.error(`[p02-adaptive-settle pid=${process.pid}] current-done operation=${String(input.operationId)}`);
    } catch (error) {''',
    "adaptive current",
)
method = replace_once(
    method,
    '''    return this.options.workspaceCoordinator.runExclusive(async () => {
      const postObservation = input.quiescenceProven ? await this.options.observations.observe() : null;''',
    '''    console.error(`[p02-adaptive-settle pid=${process.pid}] coordinator-wait operation=${String(input.operationId)}`);
    return this.options.workspaceCoordinator.runExclusive(async () => {
      console.error(`[p02-adaptive-settle pid=${process.pid}] coordinator-enter operation=${String(input.operationId)}`);
      console.error(`[p02-adaptive-settle pid=${process.pid}] observation-start operation=${String(input.operationId)} quiescence=${String(input.quiescenceProven)}`);
      const postObservation = input.quiescenceProven ? await this.options.observations.observe() : null;
      console.error(`[p02-adaptive-settle pid=${process.pid}] observation-done operation=${String(input.operationId)} status=${String(postObservation?.status ?? "skipped")}`);''',
    "adaptive coordinator",
)
method = replace_once(
    method,
    '''      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);''',
    '''      console.error(`[p02-adaptive-settle pid=${process.pid}] admission-wait operation=${String(input.operationId)}`);
      return this.options.admission.enqueue(async () => {
        console.error(`[p02-adaptive-settle pid=${process.pid}] admission-enter operation=${String(input.operationId)}`);
        const events = await replayAll(this.options.store);
        console.error(`[p02-adaptive-settle pid=${process.pid}] replay-done operation=${String(input.operationId)} events=${events.length}`);''',
    "adaptive admission",
)
method = replace_once(
    method,
    '''        const current = await this.options.currentState.current(input.program.programStateId);
        const raw = requireAdaptiveRawProgramStateV2(events, input.program.programStateId);''',
    '''        console.error(`[p02-adaptive-settle pid=${process.pid}] current2-start operation=${String(input.operationId)}`);
        const current = await this.options.currentState.current(input.program.programStateId);
        console.error(`[p02-adaptive-settle pid=${process.pid}] current2-done operation=${String(input.operationId)}`);
        const raw = requireAdaptiveRawProgramStateV2(events, input.program.programStateId);''',
    "adaptive current inside admission",
)
method = replace_once(
    method,
    '''        const head = await this.options.store.headSequence();
        const terminalDrafts = [...input.buildTerminalDrafts(head)];''',
    '''        console.error(`[p02-adaptive-settle pid=${process.pid}] head-start operation=${String(input.operationId)}`);
        const head = await this.options.store.headSequence();
        console.error(`[p02-adaptive-settle pid=${process.pid}] head-done operation=${String(input.operationId)} sequence=${head}`);
        console.error(`[p02-adaptive-settle pid=${process.pid}] drafts-start operation=${String(input.operationId)}`);
        const terminalDrafts = [...input.buildTerminalDrafts(head)];
        console.error(`[p02-adaptive-settle pid=${process.pid}] drafts-done operation=${String(input.operationId)} count=${terminalDrafts.length}`);''',
    "adaptive drafts",
)
method = replace_once(
    method,
    '''        const persisted = await this.options.store.append(settlementDrafts);
        for (let index = 0; index < persisted.length; index++) {''',
    '''        console.error(`[p02-adaptive-settle pid=${process.pid}] append-start operation=${String(input.operationId)} count=${settlementDrafts.length}`);
        const persisted = await this.options.store.append(settlementDrafts);
        console.error(`[p02-adaptive-settle pid=${process.pid}] append-done operation=${String(input.operationId)} count=${persisted.length}`);
        for (let index = 0; index < persisted.length; index++) {''',
    "adaptive append",
)
adaptive.write_text(prefix + method)
