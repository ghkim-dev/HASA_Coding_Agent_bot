import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, SandboxViolation, isForbiddenFile } from "./sandbox.ts";

let root: string;
let outside: string;
let sandbox: Sandbox;

beforeEach(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "arena-sbx-")));
  root = join(base, "worktree");
  outside = join(base, "outside");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "src", "app.ts"), "export const a = 1;\n", "utf8");
  await writeFile(join(root, ".env"), "HASA_API_KEY=super-secret-value\n", "utf8");
  await writeFile(join(outside, "secrets.txt"), "do not read me\n", "utf8");
  sandbox = new Sandbox({ root });
});

afterEach(async () => {
  await rm(join(root, ".."), { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

describe("path confinement", () => {
  test("allows a normal relative path", async () => {
    assert.equal(await sandbox.readFile("src/app.ts"), "export const a = 1;\n");
  });

  test("rejects an absolute path", async () => {
    await assert.rejects(
      sandbox.readFile(join(outside, "secrets.txt")),
      (e: unknown) => e instanceof SandboxViolation && e.kind === "absolute",
    );
  });

  test("rejects '..' traversal", async () => {
    await assert.rejects(
      sandbox.readFile("../outside/secrets.txt"),
      (e: unknown) => e instanceof SandboxViolation && e.kind === "traversal",
    );
  });

  test("rejects a symlink that escapes the worktree", async () => {
    // The case string-level checks miss: every character of the requested path
    // is innocent, and the file it names is not.
    try {
      await symlink(join(outside, "secrets.txt"), join(root, "src", "link.txt"), "file");
    } catch {
      return; // symlink creation needs privileges on some Windows setups
    }
    await assert.rejects(
      sandbox.readFile("src/link.txt"),
      (e: unknown) => e instanceof SandboxViolation && e.kind === "escape",
    );
  });

  test("rejects a symlinked directory that escapes the worktree", async () => {
    try {
      await symlink(outside, join(root, "escape"), "dir");
    } catch {
      return;
    }
    await assert.rejects(
      sandbox.readFile("escape/secrets.txt"),
      (e: unknown) => e instanceof SandboxViolation && e.kind === "escape",
    );
  });

  test("rejects a write whose parent directory escapes", async () => {
    try {
      await symlink(outside, join(root, "escape2"), "dir");
    } catch {
      return;
    }
    await assert.rejects(sandbox.writeFile("escape2/planted.txt", "x"), SandboxViolation);
  });
});

describe("forbidden files", () => {
  test(".env is unreadable even though it sits inside the worktree", async () => {
    await assert.rejects(
      sandbox.readFile(".env"),
      (e: unknown) => e instanceof SandboxViolation && e.kind === "forbidden",
    );
  });

  test("the classifier covers keys, credentials and nested paths", () => {
    for (const path of [
      ".env",
      ".env.production",
      "config/.env",
      "certs/server.pem",
      "keys/private.key",
      ".ssh/id_rsa",
      ".npmrc",
      "credentials.json",
      ".git/config",
      ".arena/capability-matrix.json",
    ]) {
      assert.equal(isForbiddenFile(path), true, `${path} should be forbidden`);
    }
  });

  test("ordinary source files are not caught by the classifier", () => {
    for (const path of ["src/app.ts", "README.md", "docs/architecture.md", "package.json"]) {
      assert.equal(isForbiddenFile(path), false, `${path} should be allowed`);
    }
  });

  test("the .git directory cannot be written through", async () => {
    await assert.rejects(sandbox.writeFile(".git/config", "[remote]"), SandboxViolation);
  });
});

describe("write scope", () => {
  test("writes outside the declared scope are refused", async () => {
    const scoped = new Sandbox({ root, writeScope: ["src"] });
    await assert.rejects(
      scoped.writeFile("docs/notes.md", "hello"),
      (e: unknown) => e instanceof SandboxViolation && e.kind === "escape",
    );
  });

  test("writes inside the declared scope succeed", async () => {
    const scoped = new Sandbox({ root, writeScope: ["src"] });
    await scoped.writeFile("src/added.ts", "export const b = 2;\n");
    assert.equal(await scoped.readFile("src/added.ts"), "export const b = 2;\n");
  });

  test("reads stay worktree-wide so the agent can orient itself", async () => {
    const scoped = new Sandbox({ root, writeScope: ["src"] });
    await writeFile(join(root, "README.md"), "# readme\n", "utf8");
    assert.equal(await scoped.readFile("README.md"), "# readme\n");
  });
});

describe("misc", () => {
  test("an oversized file is refused rather than loaded", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(2048), "utf8");
    await assert.rejects(sandbox.readFile("big.txt", 1024), SandboxViolation);
  });

  test("an empty path is rejected", async () => {
    await assert.rejects(sandbox.readFile(""), SandboxViolation);
  });

  test("exists() reports false for a forbidden path instead of throwing", async () => {
    assert.equal(await sandbox.exists(".env"), false);
    assert.equal(await sandbox.exists("src/app.ts"), true);
  });
});
