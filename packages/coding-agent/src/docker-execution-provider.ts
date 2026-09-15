import { spawn, type ChildProcess } from "node:child_process";
import { digestOf } from "@alcode/context";
import type {
  ExecutionWorldOperationBindingV1,
} from "@alcode/host-runtime";
import type {
  ExecutionContainmentPolicyDescriptorV1,
  ExecutionProviderDescriptorV1,
  ExecutionWorldActivationEvidenceV1,
  ExecutionWorldClosureEvidenceV1,
  ExecutionWorldIdentityV1,
} from "@alcode/host-runtime/execution-world";
import type {
  FilesystemCapability,
  TerminalCapability,
  TerminalExecuteResult,
  Workspace,
} from "./capabilities/types.ts";
import {
  CODING_WORKSPACE_EXECUTION_SERVICE_V1,
  CODING_WORKSPACE_OBSERVATION_SERVICE_V1,
  type CodingWorkspaceObservationServiceV1,
  type ExecutionWorldPathStateV1,
} from "./execution-provider.ts";

export const DOCKER_ISOLATED_EXECUTION_IMAGE_V1 = "node:22.17.0-bookworm-slim";
export const DOCKER_ISOLATED_WORKSPACE_ROOT_V1 = "/workspace";

const DOCKER_CONTROL_TIMEOUT_MS = 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const BRIDGE_RESULT_BYTES = 2 * 1024 * 1024;
const DIGEST_MAX_ENTRIES = 20_000;
const DIGEST_MAX_BYTES = 64 * 1024 * 1024;
const LABEL_GENERATION = "alcode.execution-world-generation";
const LABEL_WORKSPACE = "alcode.workspace-id";
const LABEL_PROVIDER_DIGEST = "alcode.provider-descriptor-digest";
const LABEL_POLICY_DIGEST = "alcode.effective-policy-digest";

export const DOCKER_ISOLATED_EXECUTION_PROVIDER_V1: ExecutionProviderDescriptorV1 = {
  providerKind: "isolated-v1",
  adapter: "alcode-docker-execution-world",
  adapterVersion: 1,
  semanticConfig: {
    platform: "linux",
    engine: "docker-cli",
    image: DOCKER_ISOLATED_EXECUTION_IMAGE_V1,
    workspaceMount: DOCKER_ISOLATED_WORKSPACE_ROOT_V1,
    filesystem: "container-bridge",
    process: "docker-exec-with-post-command-restart",
    hostileCodeIsolation: true,
  },
};

export const DOCKER_ISOLATED_EXECUTION_POLICY_V1: ExecutionContainmentPolicyDescriptorV1 = {
  profile: "isolated-v1",
  semanticConfig: {
    workspaceMount: "rw-explicit-only",
    hostFilesystemOutsideMounts: "denied",
    user: "host-nonroot-uid-gid",
    capabilities: "drop-all",
    noNewPrivileges: true,
    rootFilesystem: "read-only",
    tmpfsBytes: 64 * 1024 * 1024,
    cpuCount: 1,
    memoryBytes: 512 * 1024 * 1024,
    pidsLimit: 64,
    wallTimeMs: DEFAULT_COMMAND_TIMEOUT_MS,
    stdoutBytes: MAX_OUTPUT_BYTES,
    stderrBytes: MAX_OUTPUT_BYTES,
    network: "none",
    ambientEnvironment: "scrubbed-explicit-only",
    secretProjection: "none",
    teardown: "force-remove-plus-positive-absence",
    processContainment: "container-restart-after-terminal-operation",
  },
};

export class DockerExecutionProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerExecutionProviderError";
  }
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct child kill.
    }
  }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

function appendBounded(current: Buffer, chunk: Buffer, maximum: number): { value: Buffer; truncated: boolean } {
  if (current.length >= maximum) return { value: current, truncated: chunk.length > 0 };
  const remaining = maximum - current.length;
  if (chunk.length <= remaining) return { value: Buffer.concat([current, chunk]), truncated: false };
  return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), truncated: true };
}

function runProcess(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number } = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DOCKER_CONTROL_TIMEOUT_MS;
  const maximum = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    const abort = () => {
      if (settled) return;
      cancelled = true;
      killProcessTree(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk, maximum);
      stdout = appended.value;
      truncated ||= appended.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const appended = appendBounded(stderr, chunk, maximum);
      stderr = appended.value;
      truncated ||= appended.truncated;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
        cancelled,
        truncated,
      });
    });
  });
}

async function docker(
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number; allowFailure?: boolean } = {},
): Promise<ProcessResult> {
  let result: ProcessResult;
  try {
    result = await runProcess("docker", args, options);
  } catch (error) {
    throw new DockerExecutionProviderError(
      `Docker CLI is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!options.allowFailure && (result.exitCode !== 0 || result.timedOut || result.cancelled)) {
    const reason = result.timedOut
      ? "timed out"
      : result.cancelled
        ? "was cancelled"
        : `exited ${String(result.exitCode)}`;
    throw new DockerExecutionProviderError(
      `docker ${args[0] ?? "command"} ${reason}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

function requireSupportedHost(): { uid: number; gid: number } {
  if (process.platform !== "linux") {
    throw new DockerExecutionProviderError("isolated-v1 Docker execution is supported only on Linux");
  }
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new DockerExecutionProviderError("isolated-v1 requires numeric Linux uid/gid support");
  }
  const uid = process.getuid();
  const gid = process.getgid();
  if (uid <= 0) {
    throw new DockerExecutionProviderError("isolated-v1 refuses Host root execution; a non-root uid is required");
  }
  return { uid, gid };
}

function validateRoot(root: string): void {
  if (!root.startsWith("/") || root.includes("\0") || root.includes(",")) {
    throw new DockerExecutionProviderError(
      "isolated-v1 Workspace root must be an absolute Linux path without NUL or comma",
    );
  }
}

function exactProviderSemantics(identity: ExecutionWorldIdentityV1): void {
  if (identity.providerKind !== DOCKER_ISOLATED_EXECUTION_PROVIDER_V1.providerKind
      || identity.providerDescriptorDigest !== digestOf(DOCKER_ISOLATED_EXECUTION_PROVIDER_V1)
      || identity.effectivePolicyDigest !== digestOf(DOCKER_ISOLATED_EXECUTION_POLICY_V1)) {
    throw new DockerExecutionProviderError("Docker execution-world identity does not match isolated-v1 provider/policy semantics");
  }
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

const FILESYSTEM_BRIDGE = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = '/workspace';
const op = process.argv[1];
const input = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8') || '{}');
const maxEntries = ${DIGEST_MAX_ENTRIES};
const maxDigestBytes = ${DIGEST_MAX_BYTES};
function target(value, allowRoot = false) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) throw new Error('path must be non-empty and Workspace-relative');
  const absolute = path.resolve(root, value);
  const rel = path.relative(root, absolute);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel) || (!allowRoot && rel === '')) throw new Error('path escapes Workspace root');
  return { absolute, rel: rel === '' ? '.' : rel.split(path.sep).join('/') };
}
function glob(pattern) {
  const source = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + source + '$');
}
async function list(value) {
  const t = target(value, true);
  const entries = await fs.readdir(t.absolute, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!input.includeHidden && entry.name.startsWith('.')) continue;
    const absolute = path.join(t.absolute, entry.name);
    const stat = await fs.lstat(absolute);
    out.push({ name: entry.name, path: path.relative(root, absolute).split(path.sep).join('/'), isDirectory: entry.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() });
  }
  out.sort((a,b) => a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name));
  return out;
}
async function walkFiles(start, includeHidden, callback, depth = 0) {
  if (depth > 32) throw new Error('filesystem traversal depth bound exceeded');
  const entries = await fs.readdir(start, { withFileTypes: true });
  entries.sort((a,b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!includeHidden && entry.name.startsWith('.')) continue;
    const absolute = path.join(start, entry.name);
    if (entry.isDirectory()) await walkFiles(absolute, includeHidden, callback, depth + 1);
    else await callback(absolute, entry);
  }
}
async function digest() {
  const hash = crypto.createHash('sha256');
  let entries = 0, bytes = 0;
  async function walk(dir, prefix) {
    const children = await fs.readdir(dir, { withFileTypes: true });
    children.sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      if (prefix === '' && entry.name === '.git') continue;
      entries += 1;
      if (entries > maxEntries) throw new Error('workspace observation entry bound exceeded');
      const absolute = path.join(dir, entry.name);
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) hash.update('L\0' + relative + '\0' + await fs.readlink(absolute) + '\0');
      else if (stat.isDirectory()) { hash.update('D\0' + relative + '\0'); await walk(absolute, relative); }
      else if (stat.isFile()) {
        const content = await fs.readFile(absolute);
        bytes += content.byteLength;
        if (bytes > maxDigestBytes) throw new Error('workspace observation byte bound exceeded');
        hash.update('F\0' + relative + '\0' + content.byteLength + '\0'); hash.update(content);
      } else hash.update('O\0' + relative + '\0' + stat.mode + '\0');
    }
  }
  await walk(root, '');
  return hash.digest('hex');
}
(async () => {
  let result;
  if (op === 'read') {
    const t = target(input.path); const max = Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0 ? input.maxBytes : 1000000;
    try { const content = await fs.readFile(t.absolute); result = { content: content.subarray(0,max).toString('utf8') + (content.length > max ? '\n[output truncated]' : ''), truncated: content.length > max, byteCount: content.length }; }
    catch (e) { if (e && e.code === 'ENOENT') result = { content:'', truncated:false, byteCount:0, notFound:true }; else throw e; }
  } else if (op === 'write') {
    const t = target(input.path); if (input.createDirs) await fs.mkdir(path.dirname(t.absolute), { recursive:true }); await fs.writeFile(t.absolute, String(input.content), 'utf8'); result = { bytesWritten: Buffer.byteLength(String(input.content),'utf8') };
  } else if (op === 'edit') {
    const t = target(input.path); const content = await fs.readFile(t.absolute,'utf8'); const oldValue = String(input.oldString); const newValue = String(input.newString);
    if (input.replaceAll) { const count = content.split(oldValue).length - 1; if (count > 0) await fs.writeFile(t.absolute, content.split(oldValue).join(newValue),'utf8'); result = { replacements:count }; }
    else { const index = content.indexOf(oldValue); if (index < 0) result = { replacements:0 }; else { await fs.writeFile(t.absolute, content.slice(0,index)+newValue+content.slice(index+oldValue.length),'utf8'); result = { replacements:1 }; } }
  } else if (op === 'list') result = await list(input.path);
  else if (op === 'grep') {
    const t = target(input.path || '.', true); const maximum = Number.isSafeInteger(input.maxResults) && input.maxResults > 0 ? input.maxResults : 100; const results=[];
    const flags = input.ignoreCase ? 'i' : ''; const source = input.isRegex ? String(input.pattern) : String(input.pattern).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); const matcher = new RegExp(source,flags); const include = input.include ? glob(input.include) : null;
    await walkFiles(t.absolute,false,async (absolute,entry) => { if (results.length >= maximum || (include && !include.test(entry.name))) return; try { const text=await fs.readFile(absolute,'utf8'); const lines=text.split('\n'); for(let i=0;i<lines.length && results.length<maximum;i++){ if(matcher.test(lines[i])) results.push({ path:path.relative(root,absolute).split(path.sep).join('/'), line:i+1, column:1, text:lines[i] }); } } catch {} }); result=results;
  } else if (op === 'find') {
    const t=target(input.path,true); const matcher=glob(input.pattern); const maximum=Number.isSafeInteger(input.maxResults)&&input.maxResults>0?input.maxResults:Number.MAX_SAFE_INTEGER; const results=[];
    await walkFiles(t.absolute,Boolean(input.includeHidden),async (absolute,entry)=>{ if(results.length<maximum && matcher.test(entry.name)) results.push(path.relative(root,absolute).split(path.sep).join('/')); }); result=results.sort();
  } else if (op === 'pathstate') {
    const t=target(input.path); try { const stat=await fs.lstat(t.absolute); result=stat.isSymbolicLink()?'symlink':stat.isFile()?'file':stat.isDirectory()?'directory':null; if(result===null) throw new Error('unsupported path state'); } catch(e){ if(e&&e.code==='ENOENT') result='absent'; else throw e; }
  } else if (op === 'digest') result=await digest();
  else throw new Error('unknown bridge operation');
  process.stdout.write(JSON.stringify({ ok:true, result }));
})().catch(error => { process.stdout.write(JSON.stringify({ ok:false, error: error instanceof Error ? error.message : String(error) })); process.exitCode=1; });
`;

function parseBridge<T>(result: ProcessResult, operation: string): T {
  let payload: { ok?: boolean; result?: T; error?: string };
  try {
    payload = JSON.parse(result.stdout) as { ok?: boolean; result?: T; error?: string };
  } catch {
    throw new DockerExecutionProviderError(
      `isolated-v1 ${operation} returned invalid bridge output: ${result.stdout.slice(0, 512)}`,
    );
  }
  if (result.exitCode !== 0 || payload.ok !== true) {
    throw new DockerExecutionProviderError(
      `isolated-v1 ${operation} failed: ${payload.error ?? result.stderr.trim() ?? "unknown error"}`,
    );
  }
  return payload.result as T;
}

interface DockerInspect {
  Id?: string;
  Config?: {
    Env?: string[];
    Labels?: Record<string, string>;
  };
  HostConfig?: {
    NetworkMode?: string;
    CapDrop?: string[];
    ReadonlyRootfs?: boolean;
    NanoCpus?: number;
    Memory?: number;
    PidsLimit?: number;
    SecurityOpt?: string[];
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
  State?: { Running?: boolean };
}

async function inspect(containerId: string): Promise<DockerInspect> {
  const result = await docker(["inspect", containerId], { maxOutputBytes: BRIDGE_RESULT_BYTES });
  const parsed = JSON.parse(result.stdout) as DockerInspect[];
  if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0] === undefined) {
    throw new DockerExecutionProviderError("Docker inspect did not return exactly one execution-world container");
  }
  return parsed[0];
}

function validateInspect(
  value: DockerInspect,
  identity: ExecutionWorldIdentityV1,
  hostRoot: string,
): string {
  const id = String(value.Id ?? "");
  if (!id) throw new DockerExecutionProviderError("Docker execution world lacks provider-native container identity");
  const labels = value.Config?.Labels ?? {};
  if (labels[LABEL_GENERATION] !== identity.executionWorldGenerationId
      || labels[LABEL_WORKSPACE] !== identity.workspaceId
      || labels[LABEL_PROVIDER_DIGEST] !== identity.providerDescriptorDigest
      || labels[LABEL_POLICY_DIGEST] !== identity.effectivePolicyDigest) {
    throw new DockerExecutionProviderError("Docker execution-world labels do not match Host generation identity");
  }
  const host = value.HostConfig;
  if (host?.NetworkMode !== "none"
      || host.ReadonlyRootfs !== true
      || !host.CapDrop?.includes("ALL")
      || !(host.SecurityOpt ?? []).some((entry) => entry.includes("no-new-privileges"))
      || !Number.isFinite(host.NanoCpus) || Number(host.NanoCpus) <= 0
      || !Number.isFinite(host.Memory) || Number(host.Memory) <= 0
      || !Number.isFinite(host.PidsLimit) || Number(host.PidsLimit) <= 0) {
    throw new DockerExecutionProviderError("Docker execution world does not enforce the required isolated-v1 controls");
  }
  const workspaceMounts = (value.Mounts ?? []).filter((mount) => mount.Destination === DOCKER_ISOLATED_WORKSPACE_ROOT_V1);
  if (workspaceMounts.length !== 1
      || workspaceMounts[0]?.Type !== "bind"
      || workspaceMounts[0]?.Source !== hostRoot
      || workspaceMounts[0]?.RW !== true) {
    throw new DockerExecutionProviderError("Docker execution world does not expose exactly the declared Workspace bind mount");
  }
  if (value.State?.Running !== true) {
    throw new DockerExecutionProviderError("Docker execution-world container is not running");
  }
  return id;
}

async function readiness(containerId: string, identity: ExecutionWorldIdentityV1): Promise<string> {
  const result = await docker([
    "exec", "--workdir", DOCKER_ISOLATED_WORKSPACE_ROOT_V1, containerId,
    "node", "-e", "process.stdout.write(process.env.ALCODE_EXECUTION_WORLD_GENERATION || '')",
  ]);
  if (result.stdout !== identity.executionWorldGenerationId) {
    throw new DockerExecutionProviderError("Docker generation-bound readiness marker round-trip failed");
  }
  return digestOf({
    contract: "docker-isolated-v1-readiness",
    executionWorldGenerationId: identity.executionWorldGenerationId,
    providerNativeInstanceId: containerId,
    providerDescriptorDigest: identity.providerDescriptorDigest,
    effectivePolicyDigest: identity.effectivePolicyDigest,
  });
}

async function ensureImage(): Promise<void> {
  const present = await docker(["image", "inspect", DOCKER_ISOLATED_EXECUTION_IMAGE_V1], { allowFailure: true });
  if (present.exitCode === 0) return;
  await docker(["pull", DOCKER_ISOLATED_EXECUTION_IMAGE_V1], { timeoutMs: 5 * 60_000 });
}

async function positiveAbsence(containerId: string): Promise<boolean> {
  const result = await docker(["inspect", containerId], { allowFailure: true });
  if (result.exitCode === 0) return false;
  const evidence = `${result.stdout}\n${result.stderr}`;
  if (/No such (object|container)/i.test(evidence)) return true;
  throw new DockerExecutionProviderError(
    `Docker could not prove execution-world absence: ${evidence.trim()}`,
  );
}

export interface DockerExecutionWorldInputV1 {
  identity: ExecutionWorldIdentityV1;
  repositoryId: string;
  root: string;
}

export interface DockerExecutionWorldV1 {
  readonly identity: ExecutionWorldIdentityV1;
  readonly workspace: Workspace;
  readonly providerNativeInstanceId: string;
  activationEvidence(): ExecutionWorldActivationEvidenceV1;
  operationBinding(): ExecutionWorldOperationBindingV1;
  close(): Promise<ExecutionWorldClosureEvidenceV1>;
  isOpen(): boolean;
}

export async function createDockerExecutionWorldV1(
  input: DockerExecutionWorldInputV1,
): Promise<DockerExecutionWorldV1> {
  const { uid, gid } = requireSupportedHost();
  validateRoot(input.root);
  exactProviderSemantics(input.identity);
  await docker(["version", "--format", "{{.Server.Version}}"]);
  await ensureImage();

  const create = await docker([
    "create",
    "--label", `${LABEL_GENERATION}=${input.identity.executionWorldGenerationId}`,
    "--label", `${LABEL_WORKSPACE}=${input.identity.workspaceId}`,
    "--label", `${LABEL_PROVIDER_DIGEST}=${input.identity.providerDescriptorDigest}`,
    "--label", `${LABEL_POLICY_DIGEST}=${input.identity.effectivePolicyDigest}`,
    "--mount", `type=bind,source=${input.root},target=${DOCKER_ISOLATED_WORKSPACE_ROOT_V1}`,
    "--workdir", DOCKER_ISOLATED_WORKSPACE_ROOT_V1,
    "--user", `${uid}:${gid}`,
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864",
    "--cpus", "1.0",
    "--memory", "512m",
    "--pids-limit", "64",
    "--env", "HOME=/tmp",
    "--env", `ALCODE_EXECUTION_WORLD_GENERATION=${input.identity.executionWorldGenerationId}`,
    DOCKER_ISOLATED_EXECUTION_IMAGE_V1,
    "sh", "-c", "while :; do sleep 3600; done",
  ]);
  const containerId = create.stdout.trim();
  if (!containerId) throw new DockerExecutionProviderError("Docker create returned no container identity");

  let open = true;
  let tail: Promise<void> = Promise.resolve();
  let activationDigest = "";
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
  const requireOpen = (): void => {
    if (!open) {
      throw new DockerExecutionProviderError(
        `Execution-world generation is closed: ${input.identity.executionWorldGenerationId}`,
      );
    }
  };
  const bridge = async <T>(operation: string, args: unknown): Promise<T> => exclusive(async () => {
    requireOpen();
    const result = await docker([
      "exec", "--workdir", DOCKER_ISOLATED_WORKSPACE_ROOT_V1, containerId,
      "node", "-e", FILESYSTEM_BRIDGE, operation, base64Json(args),
    ], { maxOutputBytes: BRIDGE_RESULT_BYTES });
    requireOpen();
    return parseBridge<T>(result, operation);
  });

  try {
    await docker(["start", containerId]);
    const inspected = await inspect(containerId);
    const exactId = validateInspect(inspected, input.identity, input.root);
    if (exactId !== containerId) {
      throw new DockerExecutionProviderError("Docker create/inspect provider-native identities disagree");
    }
    activationDigest = await readiness(containerId, input.identity);
  } catch (error) {
    await docker(["rm", "-f", containerId], { allowFailure: true }).catch(() => undefined);
    throw error;
  }

  const filesystem: FilesystemCapability = {
    read: (request) => bridge("read", request),
    write: (request) => bridge("write", request),
    edit: (request) => bridge("edit", request),
    list: (request) => bridge("list", request),
    grep: (request) => bridge("grep", request),
    find: (request) => bridge("find", request),
  };

  const terminal: TerminalCapability = {
    execute: (request, signal) => exclusive(async (): Promise<TerminalExecuteResult> => {
      requireOpen();
      const timeoutMs = request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      const execution = await docker([
        "exec", "--workdir", DOCKER_ISOLATED_WORKSPACE_ROOT_V1, containerId,
        "sh", "-c", request.command,
      ], {
        timeoutMs,
        signal,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        allowFailure: true,
      });

      // A returned shell is not enough to prove descendant quiescence. Restart
      // the exact same container instance after every terminal operation so no
      // process from that Operation can survive into the next Host action.
      try {
        requireOpen();
        await docker(["restart", "--time", "0", containerId], { timeoutMs: DOCKER_CONTROL_TIMEOUT_MS });
        const inspected = await inspect(containerId);
        validateInspect(inspected, input.identity, input.root);
        await readiness(containerId, input.identity);
      } catch (error) {
        open = false;
        throw new DockerExecutionProviderError(
          `isolated-v1 could not prove process containment after terminal execution: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return {
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        timedOut: execution.timedOut,
        cancelled: execution.cancelled,
        truncated: execution.truncated,
      };
    }),
  };

  const observations: CodingWorkspaceObservationServiceV1 = {
    observeStateDigest: () => bridge<string>("digest", {}),
    observePathState: (path) => bridge<ExecutionWorldPathStateV1>("pathstate", { path }),
  };
  const workspace: Workspace = {
    identity: {
      workspaceId: input.identity.workspaceId,
      repositoryId: input.repositoryId,
      root: DOCKER_ISOLATED_WORKSPACE_ROOT_V1,
    },
    filesystem,
    terminal,
  };
  const binding: ExecutionWorldOperationBindingV1 = {
    provenance: structuredClone(input.identity),
    assertUsable: () => {
      requireOpen();
    },
    getService(serviceId) {
      if (serviceId === CODING_WORKSPACE_EXECUTION_SERVICE_V1) return workspace;
      if (serviceId === CODING_WORKSPACE_OBSERVATION_SERVICE_V1) return observations;
      return undefined;
    },
  };

  return {
    identity: structuredClone(input.identity),
    workspace,
    providerNativeInstanceId: containerId,
    activationEvidence: () => ({
      readinessEvidenceDigest: activationDigest,
      providerNativeInstanceId: containerId,
    }),
    operationBinding: () => binding,
    isOpen: () => open,
    close: async () => {
      if (!open) {
        if (!await positiveAbsence(containerId)) {
          throw new DockerExecutionProviderError("Closed isolated-v1 binding still has a provider container");
        }
      } else {
        open = false;
        await exclusive(async () => {
          const removal = await docker(["rm", "-f", containerId], { allowFailure: true });
          if (removal.exitCode !== 0 && !/No such (object|container)/i.test(`${removal.stdout}\n${removal.stderr}`)) {
            throw new DockerExecutionProviderError(`Docker teardown failed: ${removal.stderr.trim()}`);
          }
        });
        if (!await positiveAbsence(containerId)) {
          throw new DockerExecutionProviderError("Docker teardown did not prove exact container absence");
        }
      }
      return {
        closureEvidenceDigest: digestOf({
          contract: "docker-isolated-v1-closure",
          executionWorldGenerationId: input.identity.executionWorldGenerationId,
          providerNativeInstanceId: containerId,
          bindingUnavailable: true,
        }),
        providerNativeInstanceId: containerId,
        bindingUnavailable: true,
      };
    },
  };
}
