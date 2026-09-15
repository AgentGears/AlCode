import { execFile } from "node:child_process";
import { digestOf } from "@alcode/context";
import {
  ExecutionWorldServiceV1,
  type ExecutionWorldClosureEvidenceV1,
  type ExecutionWorldProjectionV1,
} from "@alcode/host-runtime/execution-world";
import {
  DOCKER_ISOLATED_EXECUTION_PROVIDER_V1,
  DOCKER_ISOLATED_WORKSPACE_ROOT_V1,
  DockerExecutionProviderError,
} from "./docker-execution-provider.ts";

const LABEL_GENERATION = "alcode.execution-world-generation";
const LABEL_WORKSPACE = "alcode.workspace-id";
const LABEL_PROVIDER_DIGEST = "alcode.provider-descriptor-digest";
const LABEL_POLICY_DIGEST = "alcode.effective-policy-digest";

interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function docker(args: readonly string[]): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    execFile("docker", [...args], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      const code = typeof error.code === "number" ? error.code : -1;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new DockerExecutionProviderError("Docker CLI is unavailable during execution-world recovery"));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? error.message, exitCode: code });
    });
  });
}

function positiveAbsence(result: DockerCommandResult): boolean {
  return result.exitCode !== 0 && /No such (object|container)/i.test(`${result.stdout}\n${result.stderr}`);
}

interface RecoveryInspect {
  Id?: string;
  Config?: { Labels?: Record<string, string> };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
}

async function matchingContainers(generationId: string): Promise<string[]> {
  const listed = await docker([
    "ps", "-a",
    "--filter", `label=${LABEL_GENERATION}=${generationId}`,
    "--format", "{{.ID}}",
  ]);
  if (listed.exitCode !== 0) {
    throw new DockerExecutionProviderError(`Docker discovery failed: ${listed.stderr.trim()}`);
  }
  return listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

async function inspectContainer(containerId: string): Promise<RecoveryInspect> {
  const result = await docker(["inspect", containerId]);
  if (result.exitCode !== 0) {
    throw new DockerExecutionProviderError(`Docker discovery inspect failed: ${result.stderr.trim()}`);
  }
  let decoded: RecoveryInspect[];
  try {
    decoded = JSON.parse(result.stdout) as RecoveryInspect[];
  } catch {
    throw new DockerExecutionProviderError("Docker discovery inspect returned malformed JSON");
  }
  if (!Array.isArray(decoded) || decoded.length !== 1 || decoded[0] === undefined) {
    throw new DockerExecutionProviderError("Docker discovery inspect did not return exactly one container");
  }
  return decoded[0];
}

function requireExactDiscovery(
  generation: ExecutionWorldProjectionV1,
  inspect: RecoveryInspect,
  root: string,
): string {
  const containerId = String(inspect.Id ?? "");
  if (!containerId) throw new DockerExecutionProviderError("Recovered Docker container lacks exact provider identity");
  const expectedNativeId = generation.activationEvidence?.providerNativeInstanceId;
  if (expectedNativeId !== undefined && containerId !== expectedNativeId) {
    throw new DockerExecutionProviderError(
      "Recovered Docker container does not match the durable provider-native instance identity",
    );
  }
  const labels = inspect.Config?.Labels ?? {};
  const identity = generation.identity;
  if (labels[LABEL_GENERATION] !== identity.executionWorldGenerationId
      || labels[LABEL_WORKSPACE] !== identity.workspaceId
      || labels[LABEL_PROVIDER_DIGEST] !== identity.providerDescriptorDigest
      || labels[LABEL_POLICY_DIGEST] !== identity.effectivePolicyDigest) {
    throw new DockerExecutionProviderError("Recovered Docker container labels disagree with durable generation identity");
  }
  const workspaceMounts = (inspect.Mounts ?? [])
    .filter((mount) => mount.Destination === DOCKER_ISOLATED_WORKSPACE_ROOT_V1);
  if (workspaceMounts.length !== 1
      || workspaceMounts[0]?.Type !== "bind"
      || workspaceMounts[0]?.Source !== root
      || workspaceMounts[0]?.RW !== true) {
    throw new DockerExecutionProviderError("Recovered Docker container Workspace mount disagrees with current Workspace identity");
  }
  return containerId;
}

async function reconcilePhysicalAbsence(
  generation: ExecutionWorldProjectionV1,
  root: string,
): Promise<ExecutionWorldClosureEvidenceV1> {
  const matches = await matchingContainers(generation.identity.executionWorldGenerationId);
  if (matches.length > 1) {
    throw new DockerExecutionProviderError(
      `Docker discovery found ${matches.length} physical instances for one execution-world generation`,
    );
  }

  let nativeId = generation.activationEvidence?.providerNativeInstanceId;
  if (matches.length === 1) {
    const inspected = await inspectContainer(matches[0]!);
    nativeId = requireExactDiscovery(generation, inspected, root);
    const removed = await docker(["rm", "-f", nativeId]);
    if (removed.exitCode !== 0 && !positiveAbsence(removed)) {
      throw new DockerExecutionProviderError(`Docker recovery teardown failed: ${removed.stderr.trim()}`);
    }
  }

  if (nativeId !== undefined) {
    const absent = await docker(["inspect", nativeId]);
    if (!positiveAbsence(absent)) {
      throw new DockerExecutionProviderError(
        absent.exitCode === 0
          ? "Docker recovery could not prove provider container absence"
          : `Docker recovery absence check failed: ${absent.stderr.trim()}`,
      );
    }
  } else {
    // A complete `docker ps -a` label query with no matches is positive absence
    // for a prepared generation that never recorded provider-native identity.
    const repeated = await matchingContainers(generation.identity.executionWorldGenerationId);
    if (repeated.length !== 0) {
      throw new DockerExecutionProviderError("Docker recovery discovery changed while proving prepared-world absence");
    }
  }

  return {
    closureEvidenceDigest: digestOf({
      contract: "docker-isolated-v1-restart-closure",
      executionWorldGenerationId: generation.identity.executionWorldGenerationId,
      providerNativeInstanceId: nativeId ?? null,
      completeDiscoveryAbsence: true,
    }),
    bindingUnavailable: true,
    ...(nativeId !== undefined ? { providerNativeInstanceId: nativeId } : {}),
  };
}

/**
 * Fresh-generation-by-default restart policy for isolated-v1. We do not revive
 * a historical executable binding after Host restart. Instead complete Docker
 * discovery is used to deterministically tear down the old exact generation,
 * record positive closure, and leave a later activation to mint a successor.
 */
export async function recoverDockerExecutionWorldsAfterHostRestartV1(
  worlds: ExecutionWorldServiceV1,
  root: string,
): Promise<void> {
  const projection = await worlds.rebuild();
  for (const generation of projection.generations.values()) {
    if (generation.identity.providerKind !== DOCKER_ISOLATED_EXECUTION_PROVIDER_V1.providerKind
        || generation.state === "closed") {
      continue;
    }
    try {
      let current = generation;
      if (current.state === "active") {
        current = await worlds.requestRetirement(current.identity.executionWorldGenerationId);
      } else if (current.state === "prepared") {
        current = await worlds.markLost({
          executionWorldGenerationId: current.identity.executionWorldGenerationId,
          reasonCode: "isolated_restart_prepared_reconciliation",
        });
      }
      const evidence = await reconcilePhysicalAbsence(current, root);
      if (current.state !== "retiring" && current.state !== "lost_or_unknown") {
        current = await worlds.markLost({
          executionWorldGenerationId: current.identity.executionWorldGenerationId,
          reasonCode: "isolated_restart_reconciliation",
        });
      }
      await worlds.observeClosure({
        executionWorldGenerationId: current.identity.executionWorldGenerationId,
        evidence,
      });
    } catch (error) {
      await worlds.markLost({
        executionWorldGenerationId: generation.identity.executionWorldGenerationId,
        reasonCode: "isolated_restart_discovery_uncertain",
      }).catch(() => undefined);
      throw error;
    }
  }
}
