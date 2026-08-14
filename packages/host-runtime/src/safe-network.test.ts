import { describe, expect, it } from "vitest";
import { createSafeFetch, type HostDnsResolver, type HostHttpDriver, type HostHttpDriverRequest } from "./safe-network.ts";

class FakeResolver implements HostDnsResolver {
  constructor(private readonly answers: Record<string, readonly { address: string; family: 4 | 6 }[]>) {}
  async resolve(hostname: string) { return this.answers[hostname] ?? []; }
}

class FakeDriver implements HostHttpDriver {
  readonly requests: HostHttpDriverRequest[] = [];
  constructor(private readonly respond: (request: HostHttpDriverRequest) => Response = () => new Response("ok", { status: 200 })) {}
  async request(request: HostHttpDriverRequest): Promise<Response> { this.requests.push(request); return this.respond(request); }
}

describe("Host integration network policy", () => {
  it("allows explicit loopback HTTP but rejects remote plain HTTP and private/link-local/metadata addresses", async () => {
    const driver = new FakeDriver();
    const fetch = createSafeFetch({
      resolver: new FakeResolver({
        "localhost": [{ address: "127.0.0.1", family: 4 }],
        "public.test": [{ address: "93.184.216.34", family: 4 }],
        "private.test": [{ address: "10.0.0.2", family: 4 }],
        "metadata.test": [{ address: "169.254.169.254", family: 4 }],
        "private6.test": [{ address: "fd00::1", family: 6 }],
      }),
      driver,
    });
    expect((await fetch("http://localhost/mcp")).status).toBe(200);
    await expect(fetch("http://public.test/mcp")).rejects.toThrow(/must use https/);
    await expect(fetch("https://private.test/mcp")).rejects.toThrow(/forbidden/);
    await expect(fetch("https://metadata.test/latest/meta-data")).rejects.toThrow(/forbidden/);
    await expect(fetch("https://private6.test/mcp")).rejects.toThrow(/forbidden/);
  });

  it("pins the validated DNS address and rejects public-to-private redirect rebinding", async () => {
    const resolver = new FakeResolver({
      "public.test": [{ address: "93.184.216.34", family: 4 }],
      "private.test": [{ address: "192.168.1.2", family: 4 }],
    });
    const driver = new FakeDriver((request) => request.url.hostname === "public.test"
      ? new Response(null, { status: 302, headers: { location: "https://private.test/mcp" } })
      : new Response("unexpected", { status: 200 }));
    const fetch = createSafeFetch({ resolver, driver });
    await expect(fetch("https://public.test/mcp")).rejects.toThrow(/forbidden/);
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]?.connectAddress).toBe("93.184.216.34");
  });

  it("strips configured and credential headers on cross-origin redirects before a validated public request", async () => {
    const resolver = new FakeResolver({
      "a.test": [{ address: "93.184.216.34", family: 4 }],
      "b.test": [{ address: "93.184.216.35", family: 4 }],
    });
    const driver = new FakeDriver((request) => request.url.hostname === "a.test"
      ? new Response(null, { status: 307, headers: { location: "https://b.test/mcp" } })
      : new Response("ok", { status: 200 }));
    const fetch = createSafeFetch({ resolver, driver, sensitiveHeaderNames: ["x-plugin-secret"] });
    await fetch("https://a.test/mcp", { headers: { authorization: "Bearer secret", "x-plugin-secret": "configured", "x-safe": "keep" } });
    expect(driver.requests).toHaveLength(2);
    expect(driver.requests[1]?.headers.get("authorization")).toBeNull();
    expect(driver.requests[1]?.headers.get("x-plugin-secret")).toBeNull();
    expect(driver.requests[1]?.headers.get("x-safe")).toBe("keep");
  });

  it("rejects mixed public/private DNS answers instead of letting address order bypass policy", async () => {
    const driver = new FakeDriver();
    const fetch = createSafeFetch({
      resolver: new FakeResolver({ "mixed.test": [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] }),
      driver,
      allowLoopback: false,
    });
    await expect(fetch("https://mixed.test/mcp")).rejects.toThrow(/forbidden/);
    expect(driver.requests).toHaveLength(0);
  });
});
