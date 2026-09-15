import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestOf } from "@alcode/context";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { type HostCapability } from "./capability-broker.ts";
import {
  ExecutionWorldOperationBindingRegistryV1,
  type ExecutionWorldOperationBindingV1,
} from "./execution-world-binding.ts";
import {
  ExecutionWorldServiceV1,
  type ExecutionContainmentPolicyDescriptorV1,
  type ExecutionProviderDescriptorV1,
} from "./execution-world.ts";
import { HostRuntime } from "./host.ts";
import { DefaultHostPolicy } from "./policy.ts";
import {
  ProgramDispatchServiceV1,
  type ProgramRootOperationAuthorityV1,
} from "./program-dispatch.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

const provider: ExecutionProviderDescriptorV1 = {
  providerKind: "local-trusted",
  adapter: "a5-broker-race-test",
  adapterVersion: 1,
  semanticConfig: { transport: "host-process", hostileCodeIsolation: false },
};

const policy: ExecutionContainmentPolicyDescriptorV1 = {
  profile: "local-trusted-v1",
  semanticConfig: { filesystem: "workspace-root", network: "host" },
};

function readiness(label: string) {
  return { readinessEvidenceDigest: digestOf({ contract: "a5-broker-race-readiness", label }) };
}

async function replayAll(locked: LockedWorkspaceStore) {
  const events = [];
  for await (const event of locked.store.replay()) events.push(event);
  return events;
}

describeLocked("A5 CapabilityBroker captured execution-world admission", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-a5-broker-race-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects G0 if replacement to G1 occurs after Broker capture but before canonical routed admission", async () => {
    locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()),
      repositoryId: uuidv7(),
    });

    let executed = false;
    const capability: HostCapability = {
      name: "world_probe",
      executionScope: "workspace_world",
      workspaceAccessClass: "no_workspace_access",
      async execute(_args, context) {
        executed = true;
        return {
          result: { generation: context.executionWorld?.provenance.executionWorldGenerationId ?? null },
          outcome: "succeeded",
        };
      },
    };
    const host = new HostRuntime({
      store: locked,
      capabilities: [capability],
      policy: new DefaultHostPolicy({ knownTools: ["world_probe"] }),
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const workspaceId = String(locked.store.workspaceId);

    const worlds = new ExecutionWorldServiceV1(locked.store, host.admission);
    const g0 = await worlds.prepareActivation({
      activationRequestId: "broker-g0",
      workspaceId,
      sessionId: String(session.sessionId),
      providerDescriptor: provider,
      effectivePolicy: policy,
    });
    await worlds.observeActivation({
      executionWorldGenerationId: g0.executionWorldGenerationId,
      evidence: readiness("same-bytes"),
    });

    const bindings = new ExecutionWorldOperationBindingRegistryV1(worlds);
    const g0Binding: ExecutionWorldOperationBindingV1 = {
      provenance: g0,
      assertUsable: () => undefined,
    };
    bindings.register(g0Binding);
    host.capabilityBroker.setExecutionWorldBindingRegistry(bindings);

    const dispatch = new ProgramDispatchServiceV1({
      store: locked.store,
      admission: host.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: {
        observe: async () => ({
          status: "complete",
          base: {
            workspaceEffectGeneration: 0,
            observation: {
              kind: "workspace-observation-v1",
              providerKind: "test-observer",
              workspaceIdentity: workspaceId,
              coverageDigest: "coverage",
              stateDigest: "same-bytes",
            },
          },
        }),
      },
      agentGenerations: { isCurrent: () => true },
      recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
      executionWorld: worlds,
    });

    let replaced = false;
    const racingAuthority: ProgramRootOperationAuthorityV1 = {
      resolveCurrentOperation: (sessionId) => dispatch.resolveCurrentOperation(sessionId),
      settleProgramMutation: (input) => dispatch.settleProgramMutation(input),
      appendRootOperation: (input, drafts) => dispatch.appendRootOperation(input, drafts),
      appendRoutedRootOperation: async (input) => {
        if (!replaced) {
          replaced = true;
          const g1 = await worlds.prepareActivation({
            activationRequestId: "broker-g1",
            workspaceId,
            sessionId: String(session.sessionId),
            providerDescriptor: provider,
            effectivePolicy: policy,
          });
          await worlds.observeActivation({
            executionWorldGenerationId: g1.executionWorldGenerationId,
            evidence: readiness("same-bytes"),
          });
        }
        return dispatch.appendRoutedRootOperation(input);
      },
    };
    host.capabilityBroker.setProgramOperationAuthority(racingAuthority);

    const result = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tc-a5-race",
      toolName: "world_probe",
      args: {},
    });

    expect(result).toMatchObject({
      outcome: "stale",
      errorCode: "program_execution_stale",
    });
    expect(executed).toBe(false);

    const events = await replayAll(locked);
    expect(events.some((event) => event.type === "operation.requested")).toBe(false);
    expect((await worlds.currentOperationProvenance()).executionWorldGenerationId)
      .not.toBe(g0.executionWorldGenerationId);
  });
});
