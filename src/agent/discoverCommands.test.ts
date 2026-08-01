import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { detectPackageManager, discoverCommands } from "./discoverCommands.ts";

/**
 * Which commands the agent may run.
 *
 * `execute_command` is the sharpest tool the agent owns, and the list it draws
 * from is discovered rather than declared. So the interesting cases are all
 * about what is *not* offered.
 */

function project(pkg: unknown): { readFile: (p: string) => Promise<string | null> } {
  return { readFile: async (p) => (p === "package.json" ? JSON.stringify(pkg) : null) };
}

describe("what gets offered", () => {
  test("the verification scripts a project actually has", async () => {
    const commands = await discoverCommands(
      project({ scripts: { test: "node --test", typecheck: "tsc --noEmit", build: "tsc -p ." } }),
    );
    assert.deepEqual(commands.map((c) => c.gate).sort(), ["build", "test", "typecheck"]);
    assert.deepEqual(commands[0]?.args, ["run", "test"]);
  });

  test("common aliases are recognised", async () => {
    const commands = await discoverCommands(project({ scripts: { "type-check": "tsc", eslint: "eslint ." } }));
    assert.deepEqual(commands.map((c) => c.gate).sort(), ["lint", "typecheck"]);
  });

  test("one command per gate, even when a project has several names for it", async () => {
    const commands = await discoverCommands(project({ scripts: { test: "a", tests: "b", "test:unit": "c" } }));
    assert.equal(commands.filter((c) => c.gate === "test").length, 1);
  });

  test("`run` is explicit, so the argument list matches a script and not a subcommand", async () => {
    const commands = await discoverCommands(project({ scripts: { test: "node --test" } }));
    assert.deepEqual(commands[0]?.args, ["run", "test"]);
  });

  test("every command carries a timeout", async () => {
    const commands = await discoverCommands(project({ scripts: { test: "x" } }));
    assert.ok((commands[0]?.timeoutMs ?? 0) > 0);
  });
});

describe("what never gets offered", () => {
  test("scripts whose names are not about verification", async () => {
    // "check it works" and "publish to production" are not the same request,
    // and the agent cannot tell which one a user meant.
    const commands = await discoverCommands(
      project({ scripts: { deploy: "./deploy.sh", start: "node .", release: "np", publish: "npm publish" } }),
    );
    assert.deepEqual(commands, []);
  });

  test("a verification script that publishes is refused despite its name", async () => {
    const commands = await discoverCommands(
      project({ scripts: { build: "tsc && npm publish", test: "node --test" } }),
    );
    assert.deepEqual(commands.map((c) => c.gate), ["test"]);
  });

  for (const body of [
    "rm -rf dist && tsc",
    "kubectl apply -f k8s",
    "terraform apply",
    "docker push acme/app",
    "gh release create",
    "git push --tags",
    "npm version patch",
  ]) {
    test(`a script that runs \`${body.split(" ")[0]}\` is refused`, async () => {
      const commands = await discoverCommands(project({ scripts: { build: body } }));
      assert.deepEqual(commands, []);
    });
  }
});

describe("projects that answer nothing useful", () => {
  test("no package.json means no command tool at all", async () => {
    // An offered tool that never works costs a turn every time the model tries.
    assert.deepEqual(await discoverCommands({ readFile: async () => null }), []);
  });

  test("malformed JSON is not a crash", async () => {
    assert.deepEqual(await discoverCommands({ readFile: async () => "{ not json" }), []);
  });

  test("a package.json with no scripts", async () => {
    assert.deepEqual(await discoverCommands(project({ name: "x" })), []);
  });

  test("scripts that is not an object", async () => {
    assert.deepEqual(await discoverCommands(project({ scripts: "test" })), []);
    assert.deepEqual(await discoverCommands(project({ scripts: null })), []);
  });

  test("a script whose value is not a string is skipped", async () => {
    assert.deepEqual(await discoverCommands(project({ scripts: { test: 42, lint: "eslint" } })).then((c) => c.map((x) => x.gate)), ["lint"]);
  });

  test("a reader that throws is treated as no project", async () => {
    const commands = await discoverCommands({
      readFile: async () => {
        throw new Error("permission denied");
      },
    });
    assert.deepEqual(commands, []);
  });
});

describe("package manager", () => {
  test("comes from the lockfile, not from a guess", async () => {
    assert.equal(await detectPackageManager(async (p) => p === "pnpm-lock.yaml"), "pnpm");
    assert.equal(await detectPackageManager(async (p) => p === "yarn.lock"), "yarn");
    assert.equal(await detectPackageManager(async () => false), "npm");
  });

  test("pnpm wins when a project has more than one lockfile", async () => {
    assert.equal(await detectPackageManager(async () => true), "pnpm");
  });

  test("the detected manager is what the command invokes", async () => {
    const commands = await discoverCommands({ ...project({ scripts: { test: "x" } }), packageManager: "yarn" });
    assert.equal(commands[0]?.cmd, "yarn");
  });
});
