import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateCodeRunRequestSchema,
  type ArenaEvent,
  type CreateCodeRunRequest,
  type RunResult,
} from "../protocol/index.ts";
import { HasaClient } from "../hasa-client/client.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { clearSecrets } from "../hasa-client/redact.ts";
import { startMockHasa, type MockHasaServer } from "../testing/mock-hasa.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { EventHub } from "./events.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { CodeRunManager, CodeRunPrecondition } from "./codeRunManager.ts";
import { GitRepo } from "./git.ts";
import type { AgentRunner, RunnerInput, RunnerResult } from "../runtime/types.ts";

/**
 * A runner whose behaviour is scripted per candidate label.
 *
 * The orchestration properties under test — isolation, gates, apply — must hold
 * regardless of what the model does, so the model is removed from the equation
 * and replaced with an exact, repeatable set of edits.
 */
class ScriptedRunner implements AgentRunner {
  readonly id = "agent" as const;
  private readonly script: Map<string, (input: RunnerInput) => Promise<string>>;

  constructor(script: Map<string, (input: RunnerInput) => Promise<string>>) {
    this.script = script;
  }

  async run(input: RunnerInput): Promise<RunnerResult> {
    const act = this.script.get(input.spec.label);
    const summary = act ? await act(input) : "did nothing";
    return { toolCalls: 1, commands: [], summary, tokensIn: 10, tokensOut: 10 };
  }
}

let mock: MockHasaServer;
let fixture: RepoFixture;
let store: Store;
let hub: EventHub;
let artifactDir: string;

const NODE = process.execPath;

before(async () => {
  mock = await startMockHasa({
    models: [
      { id: "cand/alpha", cannedReply: "alpha" },
      { id: "cand/beta", cannedReply: "beta" },
      { id: "judge/content", judgePrefers: "42" },
    ],
  });
});

after(async () => {
  await mock.close();
  clearSecrets();
});

beforeEach(async () => {
  fixture = await createRepoFixture({
    "src/app.ts": "export const answer = 41;\n",
    "README.md": "# fixture\n",
  });
  artifactDir = await mkdtemp(join(tmpdir(), "arena-art-"));
  store = await Store.open({ dbPath: ":memory:", artifactRoot: artifactDir, logger: nullLogger });
  hub = new EventHub();
});

afterEach(async () => {
  store.close();
  await rm(artifactDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  await fixture.dispose();
});

function manager(script: Map<string, (input: RunnerInput) => Promise<string>>): CodeRunManager {
  return new CodeRunManager({
    client: new HasaClient({
      apiKey: mock.apiKey,
      baseUrl: mock.url,
      logger: nullLogger,
      maxRetries: 0,
      sleep: async () => {},
    }),
    scheduler: new Scheduler({ globalLimit: 4, perModelLimit: 2, logger: nullLogger }),
    store,
    hub,
    logger: nullLogger,
    random: () => 0.5,
    runners: [new ScriptedRunner(script)],
  });
}

function request(overrides: Partial<CreateCodeRunRequest> = {}): CreateCodeRunRequest {
  return CreateCodeRunRequestSchema.parse({
    mode: "code",
    repoRoot: fixture.root,
    taskSpec: {
      prompt: "Change the answer to 42.",
      acceptanceCommands: [],
      ...(overrides.taskSpec ?? {}),
    },
    candidates: [{ modelId: "cand/alpha" }, { modelId: "cand/beta" }],
    judge: { modelId: "judge/content" },
    ...overrides,
  });
}

/** Writes a distinct value from each candidate so their diffs differ. */
function editScript(values: Record<string, string>): Map<string, (i: RunnerInput) => Promise<string>> {
  const script = new Map<string, (i: RunnerInput) => Promise<string>>();
  for (const [label, value] of Object.entries(values)) {
    script.set(label, async (input) => {
      await input.sandbox.writeFile("src/app.ts", `export const answer = ${value};\n`);
      return `set answer to ${value}`;
    });
  }
  return script;
}

async function runToCompletion(
  script: Map<string, (i: RunnerInput) => Promise<string>>,
  overrides: Partial<CreateCodeRunRequest> = {},
): Promise<{ runId: string; runs: CodeRunManager; result: RunResult; events: ArenaEvent[] }> {
  const runs = manager(script);
  const runId = await runs.create(request(overrides));
  const events: ArenaEvent[] = [];
  hub.forRun(runId).subscribe((e) => events.push(e));
  await runs.waitFor(runId);
  const row = store.getRun(runId);
  assert.ok(row?.result, "run finished without a result");
  return { runId, runs, result: JSON.parse(row.result) as RunResult, events };
}

describe("preconditions", () => {
  test("a non-repository path is refused", async () => {
    const plain = await mkdtemp(join(tmpdir(), "arena-plain-"));
    const runs = manager(new Map());
    await assert.rejects(runs.create(request({ repoRoot: plain })), CodeRunPrecondition);
    await rm(plain, { recursive: true, force: true }).catch(() => {});
  });

  test("a dirty working tree is refused before anything is created", async () => {
    await fixture.write("src/app.ts", "uncommitted edit\n");
    const runs = manager(new Map());
    await assert.rejects(
      runs.create(request()),
      (e: unknown) => e instanceof CodeRunPrecondition && /not clean/.test(e.reasons.join(" ")),
    );
    assert.equal(store.listRuns().length, 0, "nothing may be persisted for a refused run");
  });

  test("duplicate models are refused by the fairness contract", async () => {
    const runs = manager(new Map());
    await assert.rejects(
      runs.create(request({ candidates: [{ modelId: "cand/alpha" }, { modelId: "cand/alpha" }] })),
    );
  });
});

describe("worktree isolation", () => {
  test("candidates work in separate worktrees and never touch the main workspace", async () => {
    const { runId, runs } = await runToCompletion(editScript({ "cand-a": "42", "cand-b": "43" }));

    const view = runs.candidateView(runId);
    assert.equal(view.length, 2);

    // The requirement that matters most: the user's tree is untouched.
    assert.deepEqual(await fixture.status(), []);
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 41;\n");

    for (const candidate of view) {
      assert.deepEqual(candidate["changedFiles"], ["src/app.ts"]);
    }
  });

  test("candidates cannot see or collide with each other's files", async () => {
    const observed = new Map<string, string>();
    const script = new Map<string, (i: RunnerInput) => Promise<string>>();
    script.set("cand-a", async (input) => {
      await input.sandbox.writeFile("src/app.ts", "export const answer = 42;\n");
      await input.sandbox.writeFile("only-in-a.txt", "written by a\n");
      return "a";
    });
    script.set("cand-b", async (input) => {
      await input.sandbox.writeFile("src/app.ts", "export const answer = 43;\n");
      // b must not observe a's private file, and must see the pristine base.
      observed.set("b-sees-a-file", String(await input.sandbox.exists("only-in-a.txt")));
      observed.set("b-sees", await input.sandbox.readFile("src/app.ts"));
      return "b";
    });

    const { runId, runs } = await runToCompletion(script);

    assert.equal(observed.get("b-sees-a-file"), "false", "candidate b saw candidate a's file");

    const view = runs.candidateView(runId);
    const a = view.find((c) => c["label"] === "cand-a");
    const b = view.find((c) => c["label"] === "cand-b");
    const diffA = await runs.diffOf(runId, String(a?.["candidateId"]));
    const diffB = await runs.diffOf(runId, String(b?.["candidateId"]));

    assert.match(diffA ?? "", /answer = 42/);
    assert.match(diffA ?? "", /only-in-a\.txt/);
    assert.match(diffB ?? "", /answer = 43/);
    assert.ok(!(diffB ?? "").includes("only-in-a.txt"), "b's diff leaked a's file");
  });

  test("worktrees survive the run so the diffs can be reviewed", async () => {
    const { runId, runs } = await runToCompletion(editScript({ "cand-a": "42", "cand-b": "43" }));
    const repo = await GitRepo.open(fixture.root);
    const worktrees = await repo.listWorktrees();
    assert.equal(worktrees.length, 3, "main + two candidate worktrees must still exist");

    const removed = await runs.cleanup(runId);
    assert.equal(removed.length, 2);
    assert.equal((await GitRepo.open(fixture.root).then((r) => r.listWorktrees())).length, 1);
  });

  test("a candidate cannot write outside its declared scope", async () => {
    const script = new Map<string, (i: RunnerInput) => Promise<string>>();
    let refusal = "";
    script.set("cand-a", async (input) => {
      await input.sandbox.writeFile("src/app.ts", "export const answer = 42;\n");
      return "a";
    });
    script.set("cand-b", async (input) => {
      try {
        await input.sandbox.writeFile("README.md", "vandalised\n");
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
      }
      await input.sandbox.writeFile("src/app.ts", "export const answer = 43;\n");
      return "b";
    });

    await runToCompletion(script, { taskSpec: { prompt: "x", writeScope: ["src"] } as never });
    assert.match(refusal, /write scope/);
  });
});

describe("failed candidates", () => {
  test("a candidate that changes nothing fails the no_change gate", async () => {
    const script = editScript({ "cand-a": "42" });
    script.set("cand-b", async () => "I decided not to change anything");
    const { runId, runs, result } = await runToCompletion(script);

    const b = runs.candidateView(runId).find((c) => c["label"] === "cand-b");
    assert.equal(b?.["status"], "failed");
    assert.equal(b?.["excludedReason"], "no_change");
    assert.equal(result.outcome, "winner");
    assert.equal(result.confidence, "sole_survivor");
    assert.equal(result.requiresHumanReview, true);
  });

  test("a runner that throws does not take the run down with it", async () => {
    const script = editScript({ "cand-a": "42" });
    script.set("cand-b", async () => {
      throw new Error("model exploded");
    });
    const { runId, runs, result } = await runToCompletion(script);

    const b = runs.candidateView(runId).find((c) => c["label"] === "cand-b");
    assert.equal(b?.["status"], "failed");
    assert.equal(result.outcome, "winner");
    assert.equal(result.winnerLabel, "cand-a");
  });

  test("when every candidate fails the run is no_winner with per-candidate causes", async () => {
    const script = new Map<string, (i: RunnerInput) => Promise<string>>();
    script.set("cand-a", async () => "nothing");
    script.set("cand-b", async () => "nothing either");
    const { result } = await runToCompletion(script);

    assert.equal(result.outcome, "no_winner");
    assert.match(result.reason, /모든 후보가 기준 미달/);
    assert.match(result.reason, /cand-a/);
  });

  test("a failing declared command removes the candidate", async () => {
    const script = editScript({ "cand-a": "42", "cand-b": "43" });
    const { runId, runs, result } = await runToCompletion(script, {
      taskSpec: {
        prompt: "x",
        acceptanceCommands: [
          {
            gate: "test",
            // Acceptance: red at the base commit by design, so a baseline
            // failure must not excuse a candidate that also fails it.
            kind: "acceptance",
            cmd: NODE,
            // Passes only for the candidate that wrote 42.
            args: [
              "-e",
              "const fs=require('fs');const s=fs.readFileSync('src/app.ts','utf8');process.exit(s.includes('42')?0:1)",
            ],
            timeoutMs: 20000,
          },
        ],
      } as never,
    });

    const view = runs.candidateView(runId);
    const a = view.find((c) => c["label"] === "cand-a");
    const b = view.find((c) => c["label"] === "cand-b");
    assert.equal(a?.["status"], "completed");
    assert.equal(b?.["status"], "failed");
    assert.equal(b?.["excludedReason"], "test");
    assert.equal(result.winnerLabel, "cand-a");

    const gates = (b?.["gates"] ?? []) as Array<Record<string, unknown>>;
    assert.ok(gates.some((g) => g["gate"] === "test" && g["passed"] === false));
  });

  test("a command already failing at the base commit is not blamed on candidates", async () => {
    // The repository is broken before anyone touches it; disqualifying every
    // candidate for that would make the arena useless on real codebases.
    const script = editScript({ "cand-a": "42", "cand-b": "43" });
    const { runs, runId } = await runToCompletion(script, {
      taskSpec: {
        prompt: "x",
        acceptanceCommands: [
          { gate: "build", kind: "regression", cmd: NODE, args: ["-e", "process.exit(1)"], timeoutMs: 20000 },
        ],
      } as never,
    });

    const view = runs.candidateView(runId);
    assert.ok(view.every((c) => c["status"] === "completed"), "candidates must survive a pre-existing failure");
    const gates = (view[0]?.["gates"] ?? []) as Array<Record<string, unknown>>;
    const build = gates.find((g) => g["gate"] === "build");
    assert.equal(build?.["passed"], true);
    assert.match(String(build?.["detail"]), /base commit/);
  });

  test("an acceptance check is NOT excused by failing at the base commit", async () => {
    // The distinction that matters: a regression check red at base is the
    // repository's fault, an acceptance check red at base is the whole point of
    // the task. Treating them alike would let a do-nothing candidate pass.
    const script = new Map<string, (i: RunnerInput) => Promise<string>>();
    script.set("cand-a", async (input) => {
      await input.sandbox.writeFile("src/app.ts", "export const answer = 42;\n");
      return "a";
    });
    script.set("cand-b", async (input) => {
      await input.sandbox.writeFile("src/app.ts", "export const answer = 41; // reformatted\n");
      return "b";
    });

    const { runs, runId, result } = await runToCompletion(script, {
      taskSpec: {
        prompt: "x",
        acceptanceCommands: [
          {
            gate: "test",
            kind: "acceptance",
            cmd: NODE,
            args: [
              "-e",
              "const fs=require('fs');process.exit(fs.readFileSync('src/app.ts','utf8').includes('42')?0:1)",
            ],
            timeoutMs: 20000,
          },
        ],
      } as never,
    });

    const view = runs.candidateView(runId);
    assert.equal(view.find((c) => c["label"] === "cand-a")?.["status"], "completed");
    assert.equal(view.find((c) => c["label"] === "cand-b")?.["status"], "failed");
    assert.equal(result.winnerLabel, "cand-a");
  });
});

describe("apply", () => {
  test("the workspace is unchanged until apply, and matches the winner afterwards", async () => {
    const { runId, runs, result } = await runToCompletion(editScript({ "cand-a": "42" }));
    const before = await fixture.read("src/app.ts");
    assert.equal(before, "export const answer = 41;\n");
    assert.deepEqual(await fixture.status(), []);

    assert.equal(result.outcome, "winner");
    const row = store.getRun(runId);
    const applied = await runs.apply(runId, {
      candidateId: String(result.winnerCandidateId),
      expectedBaseCommit: String(row?.baseCommit),
    });

    assert.equal(applied.applied, true);
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 42;\n");
    assert.deepEqual(applied.changedFiles, ["src/app.ts"]);

    const status = await fixture.status();
    assert.equal(status.length, 1, "exactly the winner's file should be modified");
  });

  test("apply is refused when the base commit no longer matches", async () => {
    const { runId, runs, result } = await runToCompletion(editScript({ "cand-a": "42" }));
    await assert.rejects(
      runs.apply(runId, {
        candidateId: String(result.winnerCandidateId),
        expectedBaseCommit: "0000000000000000000000000000000000000000",
      }),
      (e: unknown) => e instanceof CodeRunPrecondition && /base commit mismatch/.test(e.reasons.join(" ")),
    );
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 41;\n");
  });

  test("apply is refused when the workspace HEAD moved since the run started", async () => {
    const { runId, runs, result } = await runToCompletion(editScript({ "cand-a": "42" }));
    const row = store.getRun(runId);
    await fixture.write("unrelated.txt", "meanwhile\n");
    await fixture.commit("someone else committed");

    await assert.rejects(
      runs.apply(runId, {
        candidateId: String(result.winnerCandidateId),
        expectedBaseCommit: String(row?.baseCommit),
      }),
      (e: unknown) => e instanceof CodeRunPrecondition && /HEAD moved/.test(e.reasons.join(" ")),
    );
  });

  test("a candidate that failed its gates cannot be applied", async () => {
    const script = editScript({ "cand-a": "42" });
    script.set("cand-b", async () => "nothing");
    const { runId, runs } = await runToCompletion(script);
    const row = store.getRun(runId);
    const b = runs.candidateView(runId).find((c) => c["label"] === "cand-b");

    await assert.rejects(
      runs.apply(runId, {
        candidateId: String(b?.["candidateId"]),
        expectedBaseCommit: String(row?.baseCommit),
      }),
      (e: unknown) => e instanceof CodeRunPrecondition && /did not pass/.test(e.reasons.join(" ")),
    );
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 41;\n");
  });

  test("nothing is applied automatically — a completed run leaves the tree clean", async () => {
    await runToCompletion(editScript({ "cand-a": "42", "cand-b": "43" }));
    assert.deepEqual(await fixture.status(), []);
  });
});

describe("events and records", () => {
  test("gate results are emitted and persisted per candidate", async () => {
    const { runId, runs, events } = await runToCompletion(editScript({ "cand-a": "42", "cand-b": "43" }));
    assert.ok(events.some((e) => e.type === "gate.result"));
    const view = runs.candidateView(runId);
    for (const candidate of view) {
      const gates = candidate["gates"] as Array<Record<string, unknown>>;
      assert.ok(gates.some((g) => g["gate"] === "no_change"));
    }
  });

  test("the run record captures diffs, gates and the outcome", async () => {
    const { runId } = await runToCompletion(editScript({ "cand-a": "42", "cand-b": "43" }));
    const lines = (await readFile(join(artifactDir, "runs", runId, "run.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(lines.map((l) => l["type"]), ["run", "candidate", "candidate", "result"]);
    const candidate = lines[1] as { artifacts?: { changedFiles?: string[] }; gates?: unknown[] };
    assert.deepEqual(candidate.artifacts?.changedFiles, ["src/app.ts"]);
    assert.ok((candidate.gates ?? []).length > 0);
  });

  test("no artifact or event carries the api key", async () => {
    const { runId, events } = await runToCompletion(editScript({ "cand-a": "42", "cand-b": "43" }));
    const record = await readFile(join(artifactDir, "runs", runId, "run.jsonl"), "utf8");
    assert.ok(!record.includes(mock.apiKey));
    assert.ok(!JSON.stringify(events).includes(mock.apiKey));
  });

  test("cancelling stops the run", async () => {
    const runs = manager(
      new Map([
        [
          "cand-a",
          async (input: RunnerInput) => {
            await new Promise((r) => setTimeout(r, 3000));
            await input.sandbox.writeFile("src/app.ts", "late\n");
            return "late";
          },
        ],
      ]),
    );
    const runId = await runs.create(request());
    assert.equal(runs.cancel(runId), true);
    await runs.waitFor(runId);
    assert.equal(store.getRun(runId)?.status, "cancelled");
    assert.equal(await fixture.read("src/app.ts"), "export const answer = 41;\n");
    await runs.cleanup(runId);
  });
});
