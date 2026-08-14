import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export interface ResolvedHostAddress {
  address: string;
  family: 4 | 6;
}

export interface HostDnsResolver {
  resolve(hostname: string): Promise<readonly ResolvedHostAddress[]>;
}

export interface HostHttpDriverRequest {
  url: URL;
  connectAddress: string;
  method: string;
  headers: Headers;
  body?: Uint8Array;
  signal?: AbortSignal;
}

export interface HostHttpDriver {
  request(request: HostHttpDriverRequest): Promise<Response>;
}

export interface SafeFetchOptions {
  resolver?: HostDnsResolver;
  driver?: HostHttpDriver;
  allowLoopback?: boolean;
  allowLoopbackHttp?: boolean;
  maxRedirects?: number;
  maxRequestBodyBytes?: number;
  sensitiveHeaderNames?: readonly string[];
}

const DEFAULT_MAX_REQUEST_BODY = 4 * 1024 * 1024;

export class DefaultHostDnsResolver implements HostDnsResolver {
  async resolve(hostname: string): Promise<readonly ResolvedHostAddress[]> {
    const literal = stripIpv6Brackets(hostname);
    const family = isIP(literal);
    if (family === 4 || family === 6) return [{ address: literal, family }];
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function classifyIpv4(address: string): "loopback" | "public" | "forbidden" {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return "forbidden";
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 127) return "loopback";
  if (
    a === 0 || a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  ) return "forbidden";
  return "public";
}

function parseIpv6(address: string): number[] | undefined {
  const withoutZone = address.split("%", 1)[0]!.toLowerCase();
  let source = withoutZone;
  let ipv4Tail: number[] | undefined;
  const lastColon = source.lastIndexOf(":");
  const tail = source.slice(lastColon + 1);
  if (tail.includes(".")) {
    const classification = isIP(tail);
    if (classification !== 4) return undefined;
    const bytes = tail.split(".").map(Number);
    ipv4Tail = [(bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!];
    source = `${source.slice(0, lastColon)}:${ipv4Tail[0].toString(16)}:${ipv4Tail[1].toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const raw = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (raw.length !== 8) return undefined;
  const values = raw.map((part) => Number.parseInt(part, 16));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) return undefined;
  return values;
}

function classifyIpv6(address: string): "loopback" | "public" | "forbidden" {
  const words = parseIpv6(address);
  if (!words) return "forbidden";
  const allZeroPrefix = words.slice(0, 7).every((word) => word === 0);
  if (allZeroPrefix && words[7] === 1) return "loopback";
  if (words.every((word) => word === 0)) return "forbidden";
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const v4 = `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;
    return classifyIpv4(v4);
  }
  const first = words[0]!;
  if ((first & 0xfe00) === 0xfc00) return "forbidden"; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return "forbidden"; // fe80::/10
  if ((first & 0xff00) === 0xff00) return "forbidden"; // multicast
  return (first & 0xe000) === 0x2000 ? "public" : "forbidden"; // global unicast 2000::/3
}

export function classifyNetworkAddress(address: string): "loopback" | "public" | "forbidden" {
  const normalized = stripIpv6Brackets(address);
  const family = isIP(normalized);
  if (family === 4) return classifyIpv4(normalized);
  if (family === 6) return classifyIpv6(normalized);
  return "forbidden";
}

async function requestBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`outbound request body exceeds ${maxBytes} bytes`);
  return bytes;
}

export class NodePinnedHttpDriver implements HostHttpDriver {
  request(request: HostHttpDriverRequest): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const isHttps = request.url.protocol === "https:";
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => { headers[key] = value; });
      if (headers.host === undefined) headers.host = request.url.host;
      const start = isHttps ? https.request : http.request;
      const req = start({
        protocol: request.url.protocol,
        hostname: request.connectAddress,
        port: request.url.port || undefined,
        path: `${request.url.pathname}${request.url.search}`,
        method: request.method,
        headers,
        ...(isHttps ? { servername: stripIpv6Brackets(request.url.hostname), rejectUnauthorized: true } : {}),
      }, (response) => {
        const responseHeaders = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
        }
        const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve(new Response(body, { status: response.statusCode ?? 500, statusText: response.statusMessage, headers: responseHeaders }));
      });
      req.once("error", reject);
      const onAbort = () => req.destroy(request.signal?.reason instanceof Error ? request.signal.reason : new Error("outbound request aborted"));
      request.signal?.addEventListener("abort", onAbort, { once: true });
      req.once("close", () => request.signal?.removeEventListener("abort", onAbort));
      if (request.body !== undefined) req.end(request.body);
      else req.end();
    });
  }
}

export function createSafeFetch(options: SafeFetchOptions = {}): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const resolver = options.resolver ?? new DefaultHostDnsResolver();
  const driver = options.driver ?? new NodePinnedHttpDriver();
  const allowLoopback = options.allowLoopback ?? true;
  const allowLoopbackHttp = options.allowLoopbackHttp ?? true;
  const maxRedirects = options.maxRedirects ?? 5;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY;
  const sensitive = new Set(["authorization", "proxy-authorization", "cookie", ...(options.sensitiveHeaderNames ?? []).map((name) => name.toLowerCase())]);

  return async (input, init) => {
    const initial = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    const initialBody = await requestBodyBytes(initial.clone(), maxRequestBodyBytes);
    let url = new URL(initial.url);
    let method = initial.method;
    let headers = new Headers(initial.headers);
    let body = initialBody;

    for (let redirectCount = 0; ; redirectCount++) {
      if (url.username || url.password || url.hash) throw new Error("outbound integration URL must not contain userinfo or fragment");
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("outbound integration URL must use http or https");
      const addresses = await resolver.resolve(stripIpv6Brackets(url.hostname));
      if (addresses.length === 0) throw new Error(`outbound integration hostname did not resolve: ${url.hostname}`);
      const classifications = addresses.map((entry) => ({ entry, classification: classifyNetworkAddress(entry.address) }));
      if (classifications.some(({ classification }) => classification === "forbidden" || (classification === "loopback" && !allowLoopback))) {
        throw new Error(`outbound integration target resolves to a forbidden address: ${url.hostname}`);
      }
      const allLoopback = classifications.every(({ classification }) => classification === "loopback");
      if (url.protocol === "http:" && !(allowLoopbackHttp && allLoopback)) {
        throw new Error("non-loopback outbound integration HTTP endpoint must use https");
      }
      const chosen = classifications[0]!.entry.address;
      const response = await driver.request({
        url,
        connectAddress: chosen,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(initial.signal ? { signal: initial.signal } : {}),
      });
      const location = response.headers.get("location");
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null) return response;
      if (redirectCount >= maxRedirects) throw new Error(`outbound integration redirect limit exceeded (${maxRedirects})`);
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        for (const name of sensitive) headers.delete(name);
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      url = next;
    }
  };
}
