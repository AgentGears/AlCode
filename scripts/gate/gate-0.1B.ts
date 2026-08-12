// Gate 0.1B — Phase 0.1B exit gate. See docs/phase-0-spec.md §0.1B.
//
// Composes gate:0.1A (transitively gate:0.0), then adds:
//   1. Deterministic pi import verification (manifest checksums).
//   2. agent-core + coding-agent typecheck/tests.
//   3. ai package typecheck/tests.
//   4. Six tool tests present.
//   5. Toolchain pin verification.
//   6. Live-provider smoke: skipped unless explicitly enabled.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GateCheck } from "./receipt.ts";
import { buildReceipt, formatReceipt } from "./receipt.ts";
import { run } from "./run.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALCODE_HOME = process.env.ALCODE_HOME ?? join(homedir(), ".alcode");

function commitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirty.length > 0 ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const sha = commitSha();
  const checks: GateCheck[] = [];

  // 0. Compose Phase 0.1A gate
  {
    const result = run("npx", ["tsx", "scripts/gate/gate-0.1A.ts"], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const statusMatch = result.stdout.match(/Gate 0\.1A:\s+(PASSED|FAILED)/);
    checks.push({
      id: "phase0.gate_composition",
      status: passed ? "passed" : "failed",
      evidence: statusMatch ? statusMatch[0] : (passed ? "gate:0.1A passed" : "gate:0.1A FAILED"),
    });
  }

  // 1. Deterministic pi import verification
  {
    const result = run("npx", ["tsx", "scripts/import-pi.ts", "verify"], {
      cwd: ROOT, throwOnError: false,
    });
    checks.push({
      id: "pi.import_verify",
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? result.stdout.trim() : result.stderr.slice(0, 200),
    });
  }

  // 2. agent-core + coding-agent + ai typecheck
  for (const pkg of ["agent-core", "coding-agent", "ai"]) {
    const result = run("npx", ["tsc", "--noEmit", "-p", `packages/${pkg}/tsconfig.json`], {
      cwd: ROOT, throwOnError: false,
    });
    checks.push({
      id: `${pkg}.typecheck`,
      status: result.exitCode === 0 ? "passed" : "failed",
      evidence: result.exitCode === 0 ? "tsc clean" : `${result.stdout}\n${result.stderr}`.trim().slice(0, 200),
    });
  }

  // 3. agent-core + coding-agent + ai tests
  for (const pkg of ["agent-core", "coding-agent", "ai"]) {
    const result = run("npx", ["vitest", "run", `packages/${pkg}/src`], {
      cwd: ROOT, throwOnError: false,
    });
    const passed = result.exitCode === 0;
    const summaryMatch = result.stdout.match(/Tests\s+(\d+ passed|\d+ failed)/);
    const failureOutput = `${result.stdout}\n${result.stderr}`.trim();
    checks.push({
      id: `${pkg}.tests`,
      status: passed ? "passed" : "failed",
      evidence: passed ? (summaryMatch ? summaryMatch[0] : "vitest pass") : failureOutput.slice(0, 4000),
    });
  }

  // 4. Six tool tests present
  {
    const tools = ["read", "write", "edit", "grep", "ls", "find"];
    const allPresent = tools.every((t) => existsSync(join(ROOT, `packages/coding-agent/src/tools/${t}.ts`)));
    const testPresent = existsSync(join(ROOT, "packages/coding-agent/src/tools.test.ts"));
    checks.push({
      id: "phase0.six_tools_present",
      status: allPresent && testPresent ? "passed" : "failed",
      evidence: allPresent && testPresent ? "6 tools + tests present" : "MISSING tools or tests",
    });
  }

  // 5. Toolchain pin verification
  {
    const pkgJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
    const tsPinned = typeof pkgJson.devDependencies?.typescript === "string" && !pkgJson.devDependencies.typescript.startsWith("^");
    const nodePinned = existsSync(join(ROOT, ".nvmrc"));
    const pnpmPinned = typeof pkgJson.packageManager === "string" && pkgJson.packageManager.startsWith("pnpm@");
    checks.push({
      id: "phase0.toolchain_pinned",
      status: tsPinned && nodePinned && pnpmPinned ? "passed" : "failed",
      evidence: tsPinned && nodePinned && pnpmPinned
        ? `typescript=${pkgJson.devDependencies.typescript}, node=.nvmrc, pnpm=${pkgJson.packageManager}`
        : "toolchain not fully pinned",
    });
  }

  // 6. Live-provider smoke test — actually executes when ALCODE_LIVE_SMOKE=1.
  //    Without the flag: skipped. With the flag + success: passed. With the flag + failure: failed.
  {
    const smokeEnabled = process.env.ALCODE_LIVE_SMOKE === "1";
    if (!smokeEnabled) {
      checks.push({
        id: "phase0.live_provider_smoke",
        status: "skipped",
        evidence: "opt-in (set ALCODE_LIVE_SMOKE=1 + ANTHROPIC_API_KEY to run)",
      });
    } else {
      // Execute a real Anthropic API request.
      const result = run("npx", ["tsx", "-e", `
        const { AnthropicProvider, resolveProviderConfig } = await import("${join(ROOT, "packages/ai/src/index.ts").replace(/\\/g, "/")}");
        const config = resolveProviderConfig("anthropic", "claude-sonnet-4-20250514");
        if (!config.apiKey) { console.error("No ANTHROPIC_API_KEY"); process.exit(1); }
        const provider = new AnthropicProvider(config);
        const stream = await provider.stream({
          systemPrompt: "You are a test assistant. Reply with exactly: OK",
          messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }],
          tools: [],
        });
        let text = "";
        let gotDone = false;
        for await (const event of stream) {
          if (event.type === "text_delta") text += event.text;
          if (event.type === "done") gotDone = true;
          if (event.type === "error") { console.error("Provider error:", event.message); process.exit(1); }
        }
        if (!gotDone) { console.error("No done event"); process.exit(1); }
        console.log("smoke: received response (" + text.length + " chars)");
        process.exit(0);
      `], { cwd: ROOT, throwOnError: false });

      checks.push({
        id: "phase0.live_provider_smoke",
        status: result.exitCode === 0 ? "passed" : "failed",
        evidence: result.exitCode === 0
          ? result.stdout.trim().slice(0, 200)
          : `FAILED: ${result.stderr.trim().slice(0, 300)}`,
      });
    }
  }

  // Build receipt
  const receipt = buildReceipt({
    gate: "0.1B",
    commitSha: sha,
    startedAt,
    inputs: [{ name: `node@${process.version}`, extra: `pnpm@${process.env.npm_config_user_agent ?? "?"}` }],
    checks,
  });

  console.log(formatReceipt(receipt));

  const receiptsDir = join(ALCODE_HOME, "gate-receipts");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(receiptsDir, { recursive: true });
  const safeSha = sha.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 16);
  const receiptPath = join(receiptsDir, `0.1B-${safeSha}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`\nreceipt: ${receiptPath}`);

  process.exit(receipt.status === "passed" ? 0 : 1);
}

main().catch((e) => {
  console.error("gate 0.1B crashed:", e);
  process.exit(2);
});
