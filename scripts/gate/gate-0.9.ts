import { execFileSync } from "node:child_process";
import { buildReceipt, formatReceipt, type GateCheck } from "./receipt.ts";

const startedAt = new Date().toISOString();
function command(...args: string[]): void { execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, { stdio: "inherit", env: process.env }); }
function check(id: string, run: () => void, evidence: string): GateCheck {
  try { run(); return { id, status: "passed", evidence }; }
  catch (error) { return { id, status: "failed", evidence: error instanceof Error ? error.message : String(error) }; }
}
const vitest = (...paths: string[]) => command("exec", "vitest", "run", ...paths);
const checks: GateCheck[] = [];
checks.push(check("0.9.compose.0.8", () => command("gate:0.8"), "gate:0.8 passed"));
checks.push(check("0.9.plugins.agent-plugins", () => vitest("packages/plugins/src/plugins.test.ts"), "Agent Plugins parsing/failure isolation"));
checks.push(check("0.9.plugins.digest-profile", () => vitest("packages/plugins/src/plugins.test.ts"), "digest/staging hostile fixtures"));
checks.push(check("0.9.plugins.immutable-generation", () => vitest("packages/host-runtime/src/plugin-service.test.ts"), "Host immutable generation lifecycle"));
checks.push(check("0.9.plugins.process-trust", () => vitest("packages/host-runtime/src/plugin-service.test.ts", "packages/host-runtime/src/external-process.test.ts"), "exact-generation process trust and observed teardown"));
checks.push(check("0.9.plugins.data-identity", () => vitest("packages/host-runtime/src/plugin-service.test.ts"), "opaque PLUGIN_DATA ownership"));
checks.push(check("0.9.capabilities.dynamic-catalog", () => vitest("packages/host-runtime/src/dynamic-capabilities.test.ts", "packages/agent-core/src/agent-core.test.ts", "packages/agent-protocol/src/protocol.test.ts"), "Host dynamic capability registry"));
checks.push(check("0.9.inference.capability-aba", () => vitest("packages/host-runtime/src/dynamic-capabilities.test.ts"), "non-reusable generation binding"));
checks.push(check("0.9.mcp.transport-generation", () => vitest("packages/mcp/src/mcp.test.ts"), "official-SDK client adapter"));
checks.push(check("0.9.mcp.definition-bounds", () => vitest("packages/mcp/src/mcp.test.ts"), "definition/schema/catalog bounds"));
checks.push(check("0.9.mcp.result-bounds", () => vitest("packages/mcp/src/mcp.test.ts", "packages/host-runtime/src/artifact-store.test.ts"), "bounded result/reference semantics"));
checks.push(check("0.9.mcp.ssrf-env", () => vitest("packages/host-runtime/src/safe-network.test.ts", "packages/host-runtime/src/external-process.test.ts"), "SSRF/DNS/redirect and environment isolation"));
checks.push(check("0.9.hooks.policy-ssrf", () => vitest("packages/hooks/src/hooks.test.ts", "packages/host-runtime/src/hook-manager.test.ts", "packages/host-runtime/src/safe-network.test.ts"), "monotonic hooks and network mediation"));
checks.push(check("0.9.hooks.audit-isolation", () => vitest("packages/events/src/semantic-class.test.ts"), "hook audit_meta isolation"));
checks.push(check("0.9.acp.v1", () => vitest("packages/acp/src"), "stable ACP v1 adapter"));
checks.push(check("0.9.code-intelligence.contract", () => vitest("packages/code-intelligence/src/code-intelligence.test.ts"), "semantic provider-independent contract"));
checks.push(check("0.9.code-intelligence.provider-sync", () => vitest("packages/code-intelligence/src/code-intelligence.test.ts", "packages/host-runtime/src/code-intelligence.test.ts"), "provider synchronization fence"));
checks.push(check("0.9.code-intelligence.rebaseline", () => vitest("packages/code-intelligence/src/code-intelligence.test.ts"), "tracker uncertainty recovery"));
checks.push(check("0.9.web.plugins", () => vitest("packages/web/src"), "Host-projected plugin management surface"));
checks.push(check("0.9.ownership", () => { command("build"); }, "TypeScript project-reference ownership/build boundary"));
const commitSha = process.env.GITHUB_SHA ?? "unknown";
const receipt = buildReceipt({ gate: "0.9", commitSha, startedAt, inputs: [{ name: "Agent Plugins 1.0.0" }, { name: "MCP SDK @modelcontextprotocol/client@2.0.0" }, { name: "ACP SDK @agentclientprotocol/sdk@1.3.0" }, { name: "typescript-language-server@5.3.0" }], checks });
console.log(formatReceipt(receipt));
console.log(JSON.stringify(receipt, null, 2));
if (receipt.status !== "passed") process.exitCode = 1;
