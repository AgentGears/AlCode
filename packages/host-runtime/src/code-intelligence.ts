import {
  resolveTypeScriptLanguageServerCli,
  TypeScriptLanguageServerProvider,
  type CodeIntelligenceService,
  type CodeQuery,
} from "@alcode/code-intelligence";
import type { HostCapability } from "./capability-broker.ts";
import type { ExternalProcessSupervisor } from "./external-process.ts";

export function createCodeIntelligenceCapability(service: CodeIntelligenceService): HostCapability {
  return {
    name: "code_intelligence",
    description: "Read semantic code observations with revision, completeness, and provider provenance.",
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        type: { enum: ["symbol_search", "definition", "references", "diagnostics"] },
        query: { type: "string" },
        path: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
        limit: { type: "number" },
        includeDeclaration: { type: "boolean" }
      },
      required: ["type"]
    },
    async execute(args, context) {
      const result = await service.query(args as CodeQuery, context.signal ? { signal: context.signal } : {});
      return { result, outcome: "succeeded", stdout: JSON.stringify(result) };
    },
  };
}

export function createOwnedTypeScriptLanguageServerProvider(input: {
  root: string;
  processSupervisor: ExternalProcessSupervisor;
}): TypeScriptLanguageServerProvider {
  const cli = resolveTypeScriptLanguageServerCli();
  return new TypeScriptLanguageServerProvider({
    root: input.root,
    serverVersion: "5.3.0",
    processFactory: () => {
      const owned = input.processSupervisor.start({
        command: process.execPath,
        args: [cli, "--stdio"],
        cwd: input.root,
      });
      return {
        pid: owned.pid,
        stdin: owned.child.stdin,
        stdout: owned.child.stdout,
        stderr: owned.child.stderr,
        stop: (graceMs) => owned.stop(graceMs),
      };
    },
  });
}
