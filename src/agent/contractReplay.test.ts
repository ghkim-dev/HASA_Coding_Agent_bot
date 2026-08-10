import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { AgentSession } from "./session.ts";
import { allowingApprovalPort } from "./approval.ts";
import { nullLogger } from "../hasa-client/logger.ts";
import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import { TurnRecorder } from "./sessionRecorder.ts";
import { readSession, writeSession } from "./sessionLog.ts";
import { SESSION_SCHEMA_VERSION, type SessionEvent } from "./sessionEvents.ts";
import { activeRequirements, reduceContract, unverifiedProvenance, parseTurnContract } from "./turnContract.ts";
import { TURN_CONTRACT_REQUIRED, assessNecessity } from "./actionPolicy.ts";
import { assessCompletion } from "./taskState.ts";
import { reduceTask } from "./taskReducer.ts";
import type { AgentCompletion, AgentEvent, AgentModel } from "./types.ts";
import type { NormalizedToolCall } from "../provider/types.ts";

/**
 * What the user asked for, after a reload, a timeout and a branch.
 *
 * The previous slice made the contract binding within a turn and left it in
 * session memory. So a conversation reopened tomorrow had none — which is the
 * same failure the layer was built to prevent, arriving by the other door.
 *
 * The fix is not to save it. It is to store what was *observed* — each
 * validated `record_request` — and fold them, which is what the turn graph
 * already does for messages. Live and replayed are then the same computation
 * over the same inputs, and a branch is right because the events after a fork
 * are not in its chain.
 */

const fixtures: RepoFixture[] = [];
after(async () => {
  for (const f of fixtures) await f.dispose().catch(() => {});
});

function completion(overrides: Partial<AgentCompletion> = {}): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 1, outputTokens: 1, ...overrides };
}

function call(name: string, id: string, args: Record<string, unknown> = {}): NormalizedToolCall {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args), argumentsValid: true };
}

function records(
  id: string,
  goal: string,
  relation: string,
  intents: string,
  requirements = "",
  extra: Record<string, unknown> = {},
): AgentCompletion {
  return completion({
    toolCalls: [call("record_request", id, { goal, relation, intents, requirements, ...extra })],
  });
}

/** A session whose events are recorded the way the host records them. */
class Driven {
  readonly events: SessionEvent[] = [];
  readonly session: AgentSession;
  readonly seen: unknown[] = [];
  private ordinal = 0;
  private index = 0;
  private readonly script: AgentCompletion[];

  constructor(session: AgentSession, script: AgentCompletion[]) {
    this.session = session;
    this.script = script;
  }

  next(): AgentCompletion {
    return this.script[this.index++] ?? completion({ text: "끝" });
  }

  async ask(prompt: string): Promise<void> {
    const recorder = new TurnRecorder({ turnId: `c-${this.ordinal++}` });
    this.events.push(...recorder.userMessage(prompt, []));
    this.session.setEventSink((event: AgentEvent) => this.events.push(...recorder.record(event)));
    await this.session.send(prompt, new AbortController().signal);
  }
}

async function driven(script: AgentCompletion[]): Promise<Driven> {
  const fixture = await createRepoFixture({ "src/a.ts": "export const a = 1;\n" });
  fixtures.push(fixture);
  let driver: Driven;
  const session = await AgentSession.open({
    workspaceRoot: fixture.root,
    model: {
      modelId: "test",
      async complete(request) {
        driver.seen.push(request);
        return driver.next();
      },
    } as AgentModel,
    approvalPort: allowingApprovalPort,
    approvalMode: "auto",
    mode: "code",
    logger: nullLogger,
  });
  driver = new Driven(session, script);
  return driver;
}

const DOG_CAT_REQUIREMENTS = [
  "개와 고양이 분류",
  "CNN 계열 활용",
  "Transformer 계열 활용",
  "학습",
  "추론",
  "웹에서 내용 보충",
  "Hugging Face 활용",
  "open.hasa.re.kr 활용",
].join("\n");

describe("A/J — nothing substantive happens before the request has been read", () => {
  test("a write attempted without a contract does not happen", async () => {
    const d = await driven([
      completion({ toolCalls: [call("create_file", "c1", { path: "new.ts", contents: "x" })] }),
      completion({ text: "만들지 못했습니다." }),
    ]);
    await d.ask("파일 만들어줘");

    const attempt = d.events.find(
      (e) => e.type === "tool_completed" && e.toolName === "create_file",
    ) as Extract<SessionEvent, { type: "tool_completed" }> | undefined;

    assert.ok(attempt !== undefined, "the attempt is on the record");
    assert.match(attempt.detail, new RegExp(TURN_CONTRACT_REQUIRED));
    assert.deepEqual(
      d.events.filter((e) => e.type === "file_changed"),
      [],
      "no file may change before anything has read the request",
    );
  });

  test("running a command without one does not happen either", async () => {
    const d = await driven([
      completion({ toolCalls: [call("run_command", "c1", { command: "ls" })] }),
      completion({ text: "실행하지 못했습니다." }),
    ]);
    await d.ask("실행해줘");
    const attempt = d.events.find((e) => e.type === "tool_completed") as
      | Extract<SessionEvent, { type: "tool_completed" }>
      | undefined;
    assert.match(String(attempt?.detail), new RegExp(TURN_CONTRACT_REQUIRED));
  });

  test("reading is not blocked, because that is how a request gets understood", async () => {
    const d = await driven([
      completion({ toolCalls: [call("read_file", "c1", { path: "src/a.ts" })] }),
      records("c2", "a.ts 설명", "question", "discuss"),
      completion({ text: "상수를 내보냅니다." }),
    ]);
    await d.ask("이 파일 뭐야?");

    const read = d.events.find(
      (e) => e.type === "tool_completed" && e.toolName === "read_file",
    ) as Extract<SessionEvent, { type: "tool_completed" }> | undefined;
    assert.equal(read?.status, "success");
  });

  test("after the request is read, the same action goes ahead", async () => {
    const d = await driven([
      records("c1", "파일 생성", "new_task", "modify", "new.ts 생성"),
      completion({ toolCalls: [call("create_file", "c2", { path: "new.ts", contents: "x" })] }),
      completion({ text: "만들었습니다." }),
    ]);
    await d.ask("파일 만들어줘");
    assert.ok(d.events.some((e) => e.type === "file_changed" && e.path === "new.ts"));
  });

  test("K — no contract means no completion claim is possible", async () => {
    const d = await driven([completion({ text: "작업을 완료했습니다." })]);
    await d.ask("해줘");

    const task = reduceTask(d.events);
    assert.ok(task !== null);
    assert.equal(assessCompletion(task).complete, false);
    assert.deepEqual(reduceContract(d.events).requirements, []);
  });
});

describe("D/E — the contract is folded from events, so it replays", () => {
  test("live and replayed are the same contract", async () => {
    const d = await driven([
      records("c1", "개/고양이 프로젝트", "new_task", "modify execute research", DOG_CAT_REQUIREMENTS),
      completion({ text: "시작하겠습니다." }),
    ]);
    await d.ask("개와 고양이 분류 프로젝트 만들어줘");

    const live = reduceContract(d.events);
    assert.equal(activeRequirements(live).length, 8);

    // Through the file and back, which is the path a reload takes.
    const onDisk = writeSession({
      version: SESSION_SCHEMA_VERSION,
      id: "c1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      events: d.events,
      messages: [{ role: "user", content: "x" }],
    });
    const replayed = reduceContract(readSession(onDisk)!.session.events);

    assert.deepEqual(replayed, live, "a reload must not change what was asked for");
  });

  test("③ — the requirements are there after a reload", async () => {
    const d = await driven([
      records("c1", "개/고양이 프로젝트", "new_task", "modify", DOG_CAT_REQUIREMENTS),
      completion({ text: "시작." }),
    ]);
    await d.ask("만들어줘");

    const raw = writeSession({
      version: SESSION_SCHEMA_VERSION,
      id: "c1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      events: d.events,
      messages: [{ role: "user", content: "x" }],
    });
    const back = reduceContract(readSession(raw)!.session.events);
    const text = activeRequirements(back).map((r) => r.description).join(" | ");
    for (const asked of ["Hugging Face", "hasa.re.kr", "Transformer", "학습"]) {
      assert.match(text, new RegExp(asked, "i"));
    }
  });

  test("⑤ — a correction survives a reload", async () => {
    const events: SessionEvent[] = [];
    let seq = 0;
    const push = (contract: Record<string, unknown>): void => {
      const parsed = parseTurnContract(contract, `t${seq}`);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) return;
      events.push({
        type: "turn_contract",
        id: `e${seq++}`,
        turnId: `t${seq}`,
        at: seq,
        contract: parsed.contract,
      });
    };
    push({ goal: "결과 실행", relation: "new_task", intents: "execute", requirements: "결과 실행", deliverables: "실행 결과" });
    push({ goal: "코드 출력", relation: "correct", intents: "present", requirements: "소스 코드 표시", deliverables: "소스 코드" });

    const raw = writeSession({
      version: SESSION_SCHEMA_VERSION,
      id: "c1",
      title: "t",
      createdAt: 1,
      updatedAt: 1,
      events,
      messages: [{ role: "user", content: "x" }],
    });
    const back = reduceContract(readSession(raw)!.session.events);

    assert.deepEqual(back.intents, ["present"], "the corrected intent is what survives");
    assert.equal(back.relation, "correct");
    const retired = back.deliverables.find((d) => d.description === "실행 결과");
    assert.equal(retired?.lifecycle, "superseded");
  });

  test("a contract that arrives malformed is dropped rather than emptied", () => {
    // A file edited by hand, restored from a backup, written by another build.
    // Reading it as an empty contract would silently drop every requirement,
    // which is the failure this layer exists to prevent.
    const events = [
      { type: "turn_contract", id: "e1", turnId: "t1", at: 1, contract: { turnId: "t1" } },
      { type: "turn_contract", id: "e2", turnId: "t2", at: 2, contract: null },
    ] as unknown as SessionEvent[];
    assert.deepEqual(reduceContract(events).requirements, []);
    assert.equal(reduceContract(events).lastTurnId, "");
  });
});

describe("F/G — timeout and branch", () => {
  /** Two turns' worth of contract events, with a fork point between them. */
  function chain(): { shared: SessionEvent[]; later: SessionEvent[] } {
    const make = (n: number, args: Record<string, unknown>): SessionEvent => {
      const parsed = parseTurnContract(args, `t${n}`);
      assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.problem.reason);
      if (!parsed.ok) throw new Error("unreachable");
      return { type: "turn_contract", id: `e${n}`, turnId: `t${n}`, at: n, contract: parsed.contract };
    };
    return {
      shared: [
        make(1, { goal: "비교 프로젝트", relation: "new_task", intents: "modify", requirements: "R1\nR2" }),
      ],
      later: [make(2, { goal: "추가", relation: "refine", intents: "modify", requirements: "R3" })],
    };
  }

  test("④ — a timeout leaves the contract exactly where it was", () => {
    const { shared } = chain();
    const timedOut: SessionEvent[] = [
      ...shared,
      { type: "run_completed", id: "e9", turnId: "t1", at: 9, reason: "timeout", summary: "" },
    ];
    const contract = reduceContract(timedOut);
    assert.deepEqual(activeRequirements(contract).map((r) => r.description), ["R1", "R2"]);
    assert.equal(contract.goal, "비교 프로젝트");
  });

  test("⑥ — a branch taken before R3 does not have R3", () => {
    // Nothing extra is needed for this. The events after the fork are not in
    // the branch's chain, so neither are the requirements they carried.
    const { shared, later } = chain();
    const atFork = reduceContract(shared);
    const onMain = reduceContract([...shared, ...later]);

    assert.deepEqual(activeRequirements(atFork).map((r) => r.description), ["R1", "R2"]);
    assert.deepEqual(activeRequirements(onMain).map((r) => r.description), ["R1", "R2", "R3"]);
  });

  test("and the session can be put back to either", async () => {
    const { shared, later } = chain();
    const d = await driven([]);

    d.session.restoreContract(shared);
    assert.deepEqual(activeRequirements(d.session.taskContract).map((r) => r.description), ["R1", "R2"]);

    d.session.restoreContract([...shared, ...later]);
    assert.deepEqual(activeRequirements(d.session.taskContract).map((r) => r.description), ["R1", "R2", "R3"]);
  });
});

describe("C — provenance can be checked against what the user typed", () => {
  const raw = "CNN과 ViT를 비교해줘. Hugging Face 모델도 써줘.";

  test("a quote that is really in the message verifies", () => {
    const parsed = parseTurnContract(
      { goal: "비교", relation: "new_task", intents: "modify", requirements: "CNN과 ViT를 비교" },
      "t1",
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    parsed.contract.requirements[0]!.provenance.sourceText = "CNN과 ViT를 비교";
    assert.deepEqual(unverifiedProvenance(parsed.contract, raw), []);
  });

  test("one that is not is reported", () => {
    // Weak on purpose, and named as weak: it catches a requirement attributed
    // to words the user never wrote. It cannot catch one the model never
    // noticed, because that leaves no trace to check.
    const parsed = parseTurnContract(
      { goal: "비교", relation: "new_task", intents: "modify", requirements: "PyTorch Lightning 사용" },
      "t1",
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    parsed.contract.requirements[0]!.provenance.sourceText = "PyTorch Lightning을 써서";
    assert.equal(unverifiedProvenance(parsed.contract, raw).length, 1);
  });
});

describe("H/L — how strongly an action is judged", () => {
  function contractFor(intents: string, requirements = "x", constraints = ""): ReturnType<typeof reduceContract> {
    const parsed = parseTurnContract(
      { goal: "g", relation: "new_task", intents, requirements, constraints },
      "t1",
    );
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.problem.reason);
    if (!parsed.ok) throw new Error("unreachable");
    return reduceContract([
      { type: "turn_contract", id: "e1", turnId: "t1", at: 1, contract: parsed.contract } as SessionEvent,
    ]);
  }

  test("⑦ — present-only makes reading plain and running questionable", () => {
    const present = contractFor("present");
    assert.equal(assessNecessity(present, "read_file").necessity, "allow");
    assert.equal(assessNecessity(present, "search_files").necessity, "allow");

    const running = assessNecessity(present, "run_command");
    assert.equal(running.necessity, "requires_justification");
    assert.match(String(running.reason), /필요하지 않을 수 있습니다/);
    assert.notEqual(running.necessity, "deny", "an interpretation must not become a prohibition");
  });

  test("⑧ — present plus execute allows both", () => {
    // The check that the policy did not become timid. A user who asks for both
    // gets both.
    const both = contractFor("present execute");
    assert.equal(assessNecessity(both, "read_file").necessity, "allow");
    assert.equal(assessNecessity(both, "run_command").necessity, "allow");
  });

  test("⑨ — an explicit prohibition is still a hard deny", () => {
    const forbidden = contractFor("present", "x", "no_execute: 실행하지 마");
    const verdict = assessNecessity(forbidden, "run_command");
    assert.equal(verdict.necessity, "deny");
    assert.match(String(verdict.reason), /실행하지 마/);
  });

  test("a turn nobody read judges nothing", () => {
    assert.equal(assessNecessity(reduceContract([]), "run_command").necessity, "allow");
  });
});
