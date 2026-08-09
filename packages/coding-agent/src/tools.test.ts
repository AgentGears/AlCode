// Tests for the six owned coding tools and the LocalWorkspace capabilities.
// Each tool is tested in a disposable workspace against the real local
// filesystem (no mock). Cross-platform: runs on Windows, Linux, and macOS.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalWorkspace, type Workspace } from "./capabilities/index.ts";
import { createReadTool } from "./tools/read.ts";
import { createWriteTool } from "./tools/write.ts";
import { createEditTool } from "./tools/edit.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLsTool } from "./tools/ls.ts";
import { createFindTool } from "./tools/find.ts";

describe("six owned coding tools (disposable workspace)", () => {
  let dir: string;
  let ws: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-tools-"));
    ws = createLocalWorkspace({
      workspaceId: "test-ws-id",
      repositoryId: "test-repo-id",
      root: dir,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // read
  // -------------------------------------------------------------------------

  describe("read tool", () => {
    it("reads a file with line numbers", async () => {
      writeFileSync(join(dir, "test.txt"), "line1\nline2\nline3");
      const tool = createReadTool(ws.filesystem);
      const result = await tool.execute({ path: "test.txt" }, {});

      expect(result.details.notFound).toBe(false);
      expect(result.content[0]!.text).toContain("line1");
      expect(result.content[0]!.text).toContain("line2");
      expect(result.content[0]!.text).toContain("line3");
      // Line numbers are present.
      expect(result.content[0]!.text).toMatch(/^\s*1\t/m);
    });

    it("returns notFound for missing file", async () => {
      const tool = createReadTool(ws.filesystem);
      const result = await tool.execute({ path: "nope.txt" }, {});
      expect(result.details.notFound).toBe(true);
      expect(result.content[0]!.text).toContain("not found");
    });

    it("respects offset and limit", async () => {
      writeFileSync(join(dir, "lines.txt"), "l1\nl2\nl3\nl4\nl5");
      const tool = createReadTool(ws.filesystem);
      const result = await tool.execute({ path: "lines.txt", offset: 2, limit: 2 }, {});
      expect(result.content[0]!.text).toContain("l2");
      expect(result.content[0]!.text).toContain("l3");
      expect(result.content[0]!.text).not.toContain("l1");
      expect(result.content[0]!.text).not.toContain("l4");
    });

    it("is classified read-only", () => {
      const tool = createReadTool(ws.filesystem);
      expect(tool.isReadOnly).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // write
  // -------------------------------------------------------------------------

  describe("write tool", () => {
    it("writes content to a new file", async () => {
      const tool = createWriteTool(ws.filesystem);
      const result = await tool.execute({ path: "new.txt", content: "hello world" }, {});
      expect(result.details.bytesWritten).toBe(11);
      expect(readFileSync(join(dir, "new.txt"), "utf-8")).toBe("hello world");
    });

    it("overwrites an existing file", async () => {
      writeFileSync(join(dir, "existing.txt"), "old");
      const tool = createWriteTool(ws.filesystem);
      await tool.execute({ path: "existing.txt", content: "new" }, {});
      expect(readFileSync(join(dir, "existing.txt"), "utf-8")).toBe("new");
    });

    it("creates parent directories", async () => {
      const tool = createWriteTool(ws.filesystem);
      await tool.execute({ path: "sub/dir/file.txt", content: "nested" }, {});
      expect(readFileSync(join(dir, "sub/dir/file.txt"), "utf-8")).toBe("nested");
    });
  });

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------

  describe("edit tool", () => {
    it("replaces the first occurrence by default", async () => {
      writeFileSync(join(dir, "edit.txt"), "foo bar foo bar");
      const tool = createEditTool(ws.filesystem);
      const result = await tool.execute({
        path: "edit.txt",
        oldString: "foo",
        newString: "baz",
      }, {});
      expect(result.details.replacements).toBe(1);
      expect(readFileSync(join(dir, "edit.txt"), "utf-8")).toBe("baz bar foo bar");
    });

    it("replaces all occurrences with replaceAll", async () => {
      writeFileSync(join(dir, "all.txt"), "foo bar foo bar");
      const tool = createEditTool(ws.filesystem);
      const result = await tool.execute({
        path: "all.txt",
        oldString: "foo",
        newString: "baz",
        replaceAll: true,
      }, {});
      expect(result.details.replacements).toBe(2);
      expect(readFileSync(join(dir, "all.txt"), "utf-8")).toBe("baz bar baz bar");
    });

    it("returns 0 replacements when oldString not found", async () => {
      writeFileSync(join(dir, "nomatch.txt"), "hello");
      const tool = createEditTool(ws.filesystem);
      const result = await tool.execute({
        path: "nomatch.txt",
        oldString: "xyz",
        newString: "abc",
      }, {});
      expect(result.details.replacements).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // grep
  // -------------------------------------------------------------------------

  describe("grep tool", () => {
    it("finds matching lines", async () => {
      writeFileSync(join(dir, "a.ts"), "const x = 1;\nconst y = 2;");
      writeFileSync(join(dir, "b.ts"), "const z = 3;");
      const tool = createGrepTool(ws.filesystem);
      const result = await tool.execute({ pattern: "const" }, {});
      expect(result.details.matchCount).toBe(3);
      expect(result.content[0]!.text).toContain("a.ts");
      expect(result.content[0]!.text).toContain("b.ts");
    });

    it("returns 0 matches for no results", async () => {
      writeFileSync(join(dir, "x.txt"), "nothing here");
      const tool = createGrepTool(ws.filesystem);
      const result = await tool.execute({ pattern: "zzznomatch" }, {});
      expect(result.details.matchCount).toBe(0);
    });

    it("is classified read-only", () => {
      const tool = createGrepTool(ws.filesystem);
      expect(tool.isReadOnly).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // ls
  // -------------------------------------------------------------------------

  describe("ls tool", () => {
    it("lists directory contents", async () => {
      writeFileSync(join(dir, "file1.txt"), "a");
      writeFileSync(join(dir, "file2.ts"), "b");
      mkdirSync(join(dir, "subdir"));
      const tool = createLsTool(ws.filesystem);
      const result = await tool.execute({ path: "." }, {});
      expect(result.details.entryCount).toBe(3);
      expect(result.content[0]!.text).toContain("file1.txt");
      expect(result.content[0]!.text).toContain("file2.ts");
      expect(result.content[0]!.text).toContain("subdir");
      expect(result.content[0]!.text).toContain("[DIR]");
    });

    it("hides dotfiles by default", async () => {
      writeFileSync(join(dir, ".hidden"), "secret");
      writeFileSync(join(dir, "visible.txt"), "ok");
      const tool = createLsTool(ws.filesystem);
      const result = await tool.execute({ path: "." }, {});
      expect(result.details.entryCount).toBe(1);
      expect(result.content[0]!.text).toContain("visible.txt");
    });

    it("includes dotfiles when asked", async () => {
      writeFileSync(join(dir, ".hidden"), "secret");
      writeFileSync(join(dir, "visible.txt"), "ok");
      const tool = createLsTool(ws.filesystem);
      const result = await tool.execute({ path: ".", includeHidden: true }, {});
      expect(result.details.entryCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // find
  // -------------------------------------------------------------------------

  describe("find tool", () => {
    it("finds files by pattern", async () => {
      writeFileSync(join(dir, "a.ts"), "x");
      writeFileSync(join(dir, "b.ts"), "y");
      writeFileSync(join(dir, "c.txt"), "z");
      const tool = createFindTool(ws.filesystem);
      const result = await tool.execute({ path: ".", pattern: "*.ts" }, {});
      expect(result.details.matchCount).toBe(2);
      expect(result.content[0]!.text).toContain("a.ts");
      expect(result.content[0]!.text).toContain("b.ts");
    });

    it("returns 0 for no matches", async () => {
      writeFileSync(join(dir, "a.txt"), "x");
      const tool = createFindTool(ws.filesystem);
      const result = await tool.execute({ path: ".", pattern: "*.nomatch" }, {});
      expect(result.details.matchCount).toBe(0);
    });

    it("is classified read-only", () => {
      const tool = createFindTool(ws.filesystem);
      expect(tool.isReadOnly).toBe(true);
    });
  });
});
