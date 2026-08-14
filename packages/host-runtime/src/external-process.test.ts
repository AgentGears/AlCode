import { describe, expect, it } from "vitest";
import { ExternalProcessSupervisor, scrubExternalProcessEnvironment } from "./external-process.ts";

async function stdoutOf(process: ReturnType<ExternalProcessSupervisor["start"]>): Promise<string> {
  let text = "";
  process.child.stdout.setEncoding("utf8");
  process.child.stdout.on("data", (chunk: string) => { text += chunk; });
  await process.waitForExit();
  return text.trim();
}

describe("ExternalProcessSupervisor", () => {
  it("scrubs ambient secrets while retaining a small runtime environment and explicit values", () => {
    const env = scrubExternalProcessEnvironment(
      { PATH: "/bin", HOME: "/home/test", OPENAI_API_KEY: "secret", ALCODE_INTERNAL_SECRET: "secret2" },
      { EXPLICIT_COMPONENT_VALUE: "ok", PLUGIN_ROOT: "wrong" },
      { PLUGIN_ROOT: "/managed/root" },
    );
    expect(env.PATH).toBe("/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ALCODE_INTERNAL_SECRET).toBeUndefined();
    expect(env.EXPLICIT_COMPONENT_VALUE).toBe("ok");
    expect(env.PLUGIN_ROOT).toBe("/managed/root");
  });

  it("spawns a child with scrubbed environment and observes its exit", async () => {
    const supervisor = new ExternalProcessSupervisor({
      ambientEnv: { ...process.env, OPENAI_API_KEY: "must-not-leak", ALCODE_INTERNAL_SECRET: "must-not-leak" },
    });
    const child = supervisor.start({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({openai:process.env.OPENAI_API_KEY,internal:process.env.ALCODE_INTERNAL_SECRET,explicit:process.env.EXPLICIT_COMPONENT_VALUE,root:process.env.PLUGIN_ROOT}))"],
      env: { EXPLICIT_COMPONENT_VALUE: "ok" },
      reservedEnv: { PLUGIN_ROOT: "/managed/plugin" },
    });
    const parsed = JSON.parse(await stdoutOf(child)) as Record<string, unknown>;
    expect(parsed.openai).toBeUndefined();
    expect(parsed.internal).toBeUndefined();
    expect(parsed.explicit).toBe("ok");
    expect(parsed.root).toBe("/managed/plugin");
    expect(supervisor.activeCount).toBe(0);
  });

  it("bounds process count and reaches observed exit on forced stop", async () => {
    const supervisor = new ExternalProcessSupervisor({ maxProcesses: 1 });
    const child = supervisor.start({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] });
    expect(() => supervisor.start({ command: process.execPath, args: ["-e", "0"] })).toThrow(/limit/);
    const exit = await child.stop(25);
    expect(exit.code !== null || exit.signal !== null).toBe(true);
    expect(supervisor.activeCount).toBe(0);
  });
});
