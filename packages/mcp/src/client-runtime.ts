import {
  Client,
  StreamableHTTPClientTransport,
  type FetchLike,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { buildMcpToolCatalog } from "./tool-catalog.ts";
import type {
  McpCallResult,
  McpToolDescriptor,
  McpToolLimits,
  McpToolProvenance,
} from "./types.ts";

export interface McpClientRuntimeOptions {
  provenance: McpToolProvenance;
  toolLimits?: Partial<McpToolLimits>;
  requestTimeoutMs?: number;
  onCatalogChanged?: (tools: readonly McpToolDescriptor[]) => void | Promise<void>;
}

export interface StreamableHttpMcpOptions extends McpClientRuntimeOptions {
  url: URL;
  fetch: FetchLike;
  headers?: Record<string, string>;
}

export class McpClientRuntime {
  private readonly client: Client;
  private readonly requestTimeoutMs: number;
  private currentTools = new Map<string, McpToolDescriptor>();
  private connected = false;

  private constructor(
    private readonly transport: Transport,
    private readonly options: McpClientRuntimeOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.client = new Client(
      { name: "alcode", version: "0.9.0" },
      {
        listMaxPages: 32,
        listChanged: {
          tools: {
            debounceMs: 25,
            onChanged: (error, tools) => {
              if (error) return;
              try {
                const next = buildMcpToolCatalog(tools, this.options.provenance, this.options.toolLimits);
                this.currentTools = new Map(next.tools.map((tool) => [tool.modelName, tool]));
                void this.options.onCatalogChanged?.(next.tools);
              } catch {
                // Keep last-good catalog; Host diagnostics are emitted by explicit refresh/replacement handling.
              }
            },
          },
        },
      },
    );
  }

  static forTransport(transport: Transport, options: McpClientRuntimeOptions): McpClientRuntime {
    return new McpClientRuntime(transport, options);
  }

  static forStreamableHttp(options: StreamableHttpMcpOptions): McpClientRuntime {
    const transport = new StreamableHTTPClientTransport(options.url, {
      fetch: options.fetch,
      ...(options.headers !== undefined ? { requestInit: { headers: options.headers } } : {}),
      reconnectionOptions: {
        initialReconnectionDelay: 500,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 10,
      },
      onInsufficientScope: "throw",
    });
    return new McpClientRuntime(transport, options);
  }

  async connect(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    if (this.connected) throw new Error("MCP client runtime is already connected");
    await this.client.connect(this.transport, { signal, timeout: this.requestTimeoutMs });
    this.connected = true;
    return this.refreshTools(signal);
  }

  async refreshTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    if (!this.connected) throw new Error("MCP client runtime is not connected");
    const result = await this.client.listTools(undefined, { cacheMode: "refresh", signal, timeout: this.requestTimeoutMs });
    const next = buildMcpToolCatalog(result.tools, this.options.provenance, this.options.toolLimits);
    this.currentTools = new Map(next.tools.map((tool) => [tool.modelName, tool]));
    return next.tools;
  }

  listCurrentTools(): readonly McpToolDescriptor[] {
    return [...this.currentTools.values()].map((tool) => structuredClone(tool));
  }

  async callTool(modelName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (!this.connected) throw new Error("MCP client runtime is not connected");
    const tool = this.currentTools.get(modelName);
    if (!tool) throw new Error(`MCP tool is not in the current generation: ${modelName}`);
    const result = await this.client.callTool(
      { name: tool.rawName, arguments: structuredClone(args) },
      { signal, timeout: this.requestTimeoutMs, toolDefinition: tool.sdkDefinition as Tool },
    );
    return {
      isError: result.isError === true,
      content: structuredClone(result.content) as unknown[],
      ...(result.structuredContent !== undefined ? { structuredContent: structuredClone(result.structuredContent) } : {}),
    };
  }

  async close(): Promise<void> {
    try { await this.client.close(); }
    finally { this.connected = false; this.currentTools.clear(); }
  }
}
