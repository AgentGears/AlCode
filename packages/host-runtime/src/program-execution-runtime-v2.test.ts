import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./program-execution-runtime-v2.ts", import.meta.url), "utf8");
const v1Source = readFileSync(new URL("./program-execution-runtime.ts", import.meta.url), "utf8");

describe("A1 adaptive Program runtime V2 authority composition", () => {
  it("wraps the exact production V1 authority graph instead of creating a parallel bare Host", () => {
    expect(source).toContain("fixedTopology: ProgramExecutionRuntimeV1");
    expect(source).toContain("this.fixedTopology = options.fixedTopology;");
    expect(source).toContain("this.host = this.fixedTopology.host;");
    expect(source).not.toContain("new HostRuntime(");
    expect(v1Source).toContain("this.host.setProgramOperationAuthority(this.dispatch);");
    expect(source).toContain("this.host.capabilityBroker.execute(prepared)");
  });

  it("does not translate semantic ProgramRevision provenance into the operational CAS lease", () => {
    expect(source).not.toMatch(/issuedUnderProgramRevisionId[^\n]{0,120}expectedProgramRevision/);
    expect(source).not.toMatch(/expectedProgramRevision[^\n]{0,120}issuedUnderProgramRevisionId/);
  });

  it("keeps route selection and Agent attachment inside one classification lock", () => {
    expect(source).toContain("routing: ProgramAdaptiveSessionRoutingAuthorityV1;");
    expect(source).toContain("this.routing = options.routing;");
    expect(source).not.toContain("isAdaptiveProgramSession");
    const attach = source.indexOf("async attachAgent(");
    const classification = source.indexOf(
      "return this.routing.withClassification(sessionId, async (classification) => {",
      attach,
    );
    const fixed = source.indexOf(
      "return this.fixedTopology.attachAgent(connection, session, systemPrompt, resumeReason);",
      classification,
    );
    const interception = source.indexOf("this.hostConnectionWithoutAdaptiveAuthorityMessages(connection)", classification);
    expect(attach).toBeGreaterThan(-1);
    expect(classification).toBeGreaterThan(attach);
    expect(fixed).toBeGreaterThan(classification);
    expect(interception).toBeGreaterThan(classification);
  });

  it("preserves V1 attempt execution routing for non-adaptive Program sessions", () => {
    expect(source).toContain("return this.fixedTopology.requestCurrentAttemptExecution(connection, session);");
    expect(v1Source).toContain("this.planning.handleAgentMessage");
    expect(v1Source).toContain("this.progress.handleAgentMessage");
    expect(v1Source).toContain("this.handleProgramAgentIdle(connection, session)");
  });

  it("keeps explicit execution routing inside the same durable classification cut", () => {
    const method = source.indexOf("async requestCurrentAttemptExecution(");
    const classification = source.indexOf(
      "return this.routing.withClassification(sessionId, async (classification) => {",
      method,
    );
    const fixed = source.indexOf("return this.fixedTopology.requestCurrentAttemptExecution(connection, session);", classification);
    const currentness = source.indexOf(
      "if (!this.agent.isCurrentConnection(sessionId, connection.generationId))",
      classification,
    );
    const scheduling = source.indexOf("const scheduled = await this.control.ensureCurrentAttempt(sessionId);", classification);
    expect(classification).toBeGreaterThan(method);
    expect(fixed).toBeGreaterThan(classification);
    expect(currentness).toBeGreaterThan(classification);
    expect(scheduling).toBeGreaterThan(currentness);
  });

  it("withholds ordinary Host capability and idle routing only after adaptive ownership is established", () => {
    expect(source).toContain("Adaptive Program capability requests require ProgramAttemptAuthorityV2");
    expect(source).toContain("A displaced generation may still drain a buffered idle");
  });

  it("rejects displaced idle before it can schedule or complete adaptive work", () => {
    const idle = source.indexOf('message.type === "agent.idle" && message.sessionId === sessionId');
    const currentness = source.indexOf(
      "if (!this.agent.isCurrentConnection(sessionId, connection.generationId)) return;",
      idle,
    );
    const control = source.indexOf("const decision = await this.control.handleAgentIdle(sessionId);", idle);
    expect(idle).toBeGreaterThan(-1);
    expect(currentness).toBeGreaterThan(idle);
    expect(control).toBeGreaterThan(currentness);
  });

  it("rejects displaced explicit execution requests before semantic successor admission", () => {
    const method = source.indexOf("async requestCurrentAttemptExecution(");
    const currentness = source.indexOf(
      "if (!this.agent.isCurrentConnection(sessionId, connection.generationId))",
      method,
    );
    const scheduling = source.indexOf("const scheduled = await this.control.ensureCurrentAttempt(sessionId);", method);
    expect(method).toBeGreaterThan(-1);
    expect(currentness).toBeGreaterThan(method);
    expect(scheduling).toBeGreaterThan(currentness);
    expect(source).toContain("Adaptive Program execution connection is not current");
  });

  it("routes adaptive first/successor eligibility and idle Completion through Host semantic control", () => {
    expect(source).toContain("control: ProgramAdaptiveExecutionControlV2");
    expect(source).toContain("this.control = options.control;");
    expect(source).toContain("const scheduled = await this.control.ensureCurrentAttempt(sessionId);");
    expect(source).toContain("const decision = await this.control.handleAgentIdle(sessionId);");
    expect(source).toContain('decision.reason === "successor_dispatched"');
    expect(source).toContain("await this.agent.requestCurrentAttemptExecution(sessionId, connection.generationId);");
    expect(source).toContain("await this.host.sessions.stop(session.sessionId, decision.terminal);");
    expect(source).not.toContain("adaptive Completion is intentionally not implemented");
  });

  it("fails the disposable generation closed when a canonical successor directive cannot be delivered", () => {
    expect(source).toContain("A successor is already canonical.");
    expect(source).toContain("if (this.agent.isCurrentConnection(sessionId, connection.generationId))");
    expect(source).toContain("connection.terminate();");
    expect(source).toContain("normal replacement/recovery can replay the Attempt");
  });

  it("terminates the disposable Agent even when terminal shutdown notification fails", () => {
    expect(source).toContain("Terminal Program/session truth is already durable.");
    expect(source).toContain("finally {\n              connection.terminate();\n            }");
  });

  it("cleans adaptive generation state on displacement, explicit detach, and process exit", () => {
    expect(source).toContain("const displacedGenerationId = this.agent.attach(");
    expect(source).toContain("this.clearContextCacheForGeneration(displacedGenerationId)");
    expect(source).toContain("const detachAdaptiveGeneration = (): void =>");
    expect(source).toContain("this.agent.detach(connection.generationId)");
    expect(source).toContain("void connection.waitForExit().then(");
    expect(source).toContain("detachAdaptiveGeneration();");
  });

  it("contains adaptive callback failures and terminates failed refreshes with a Host cancel", () => {
    expect(source).toContain("fail the disposable Agent");
    expect(source).toContain('reason: "Adaptive context refresh failed"');
    expect(source).toContain('errorCode: "adaptive_runtime_failure"');
    expect(source).toContain("progressFailure(message)");
  });
});
