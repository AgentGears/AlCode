import { useState, type FormEvent } from "react";
import type { PublicPlugin } from "@alcode/application-protocol";
import type { ApplicationClient } from "./client.ts";

export interface PluginsPanelProps { client: ApplicationClient; plugins: readonly PublicPlugin[]; }

export function PluginsPanel({ client, plugins }: PluginsPanelProps) {
  const [sourceRoot, setSourceRoot] = useState("");
  const [scope, setScope] = useState<"user" | "workspace">("user");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function action(key: string, run: () => Promise<unknown>) { setBusy(key); setError(null); try { await run(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } }
  function register(event: FormEvent) { event.preventDefault(); const root = sourceRoot.trim(); if (!root) return; void action("register", async () => { const result = await client.pluginRegister(root, scope); if (result.decision === "failed") throw new Error(result.reasonCode ?? "Plugin registration failed"); setSourceRoot(""); }); }
  return <section aria-label="Plugins">
    <h2>Plugins</h2>
    <form onSubmit={register}>
      <input aria-label="Plugin directory" value={sourceRoot} onChange={(e) => setSourceRoot(e.target.value)} placeholder="Local plugin directory" />
      <select aria-label="Plugin scope" value={scope} onChange={(e) => setScope(e.target.value as "user" | "workspace")}><option value="user">User</option><option value="workspace">Workspace</option></select>
      <button disabled={busy !== null || !sourceRoot.trim()}>Register</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    <ul>{plugins.map((plugin) => <li key={plugin.registrationId}>
      <strong>{plugin.name}</strong> <span>{plugin.scope}</span> <span>{plugin.status}</span>
      <div>Digest: <code>{plugin.packageDigest.slice(0, 12)}</code></div>
      <div>MCP {plugin.components.mcpServers.length} · Skills {plugin.components.skills.length} (metadata only) · Hooks {plugin.components.hooks.length}</div>
      {plugin.diagnostics.map((d, i) => <div key={`${d.code}-${i}`}>{d.severity}: {d.message}</div>)}
      <button disabled={busy !== null} onClick={() => void action(`refresh:${plugin.registrationId}`, () => client.pluginRefresh(plugin.registrationId))}>Refresh</button>
      {plugin.status === "enabled"
        ? <button disabled={busy !== null} onClick={() => void action(`disable:${plugin.registrationId}`, () => client.pluginDisable(plugin.registrationId))}>Disable</button>
        : <button disabled={busy !== null || plugin.status === "invalid"} onClick={() => void action(`enable:${plugin.registrationId}`, () => client.pluginEnable(plugin.registrationId))}>Enable</button>}
      <button disabled={busy !== null} onClick={() => void action(`remove:${plugin.registrationId}`, () => client.pluginUnregister(plugin.registrationId))}>Unregister</button>
    </li>)}</ul>
  </section>;
}
