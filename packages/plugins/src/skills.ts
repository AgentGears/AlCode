import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { PluginDiagnostic, SkillDescriptor } from "./types.ts";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { throw new Error("invalid quoted YAML scalar"); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function parseFrontmatter(text: string): Record<string, string> {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) throw new Error("SKILL.md must begin with YAML frontmatter");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed");
  const lines = normalized.slice(4, end).split("\n");
  const values: Record<string, string> = {};
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // nested metadata is intentionally opaque to Phase 0.9 discovery.
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`invalid YAML frontmatter line: ${line}`);
    const key = line.slice(0, colon).trim();
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unsupported Agent Skill frontmatter field: ${key}`);
    let raw = line.slice(colon + 1).trim();
    if ((raw === "|" || raw === ">") && key !== "metadata") {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1]!)) {
        index += 1;
        parts.push(lines[index]!.trim());
      }
      raw = raw === ">" ? parts.join(" ") : parts.join("\n");
    }
    if (key !== "metadata") values[key] = parseScalar(raw);
  }
  return values;
}

export async function discoverSkills(root: string, diagnostics: PluginDiagnostic[]): Promise<SkillDescriptor[]> {
  const skillsRoot = path.join(root, "skills");
  let stat;
  try { stat = await lstat(skillsRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    diagnostics.push({ code: "skills.invalid_location", severity: "error", message: "skills must be a real directory", path: "skills" });
    return [];
  }

  const result: SkillDescriptor[] = [];
  const children = await readdir(skillsRoot, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    const skillPath = path.join(skillsRoot, child.name, "SKILL.md");
    try {
      const skillStat = await lstat(skillPath);
      if (!skillStat.isFile() || skillStat.isSymbolicLink()) throw new Error("SKILL.md must be a regular file");
      const values = parseFrontmatter(await readFile(skillPath, "utf8"));
      const name = values.name ?? "";
      const description = values.description ?? "";
      if (!name || !SKILL_NAME.test(name) || name.length > 64 || name !== child.name) throw new Error("skill name is invalid or does not match its directory");
      if (!description || description.length > 1024) throw new Error("skill description must be 1-1024 characters");
      if ((values.compatibility?.length ?? 0) > 500) throw new Error("skill compatibility exceeds 500 characters");
      result.push({
        name,
        description,
        relativePath: `skills/${child.name}`,
        ...(values.compatibility ? { compatibility: values.compatibility } : {}),
        ...(values.license ? { license: values.license } : {}),
        ...(values["allowed-tools"] ? { allowedTools: values["allowed-tools"] } : {}),
      });
    } catch (error) {
      diagnostics.push({
        code: "skill.invalid",
        severity: "warning",
        message: error instanceof Error ? error.message : String(error),
        path: `skills/${child.name}/SKILL.md`,
        component: child.name,
      });
    }
  }
  return result;
}
