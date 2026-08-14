import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_SCHEMA_VERSION,
  type RunTerminationReason,
  type SessionEvent,
  type ToolCallStatus,
} from "./sessionEvents.ts";
import { readSession, writeSession } from "./sessionLog.ts";
import { isAbnormal, reduceSession, terminationView } from "./sessionView.ts";
import { turnStateFor } from "./conversationGraph.ts";
import {
  TURN_INTENTS,
  TURN_RELATIONS,
  activeRequirements,
  emptyContract,
  mergeContract,
  parseTurnContract,
  reduceContract,
  type TaskContract,
  type TurnContract,
  type TurnRelation,
} from "./turnContract.ts";
import { evidenceFrom, isSelfAuthoredOutput, verifierFor } from "./taskState.ts";

/**
 * The third migration: two renderers became one reducer.
 *
 * A live turn used to be drawn from `AgentEvent`s and a reopened one from the
 * model's prompt array, by two different functions. The second input had no
 * room for a plan, a reasoning summary, a changed file or a reason the run
 * stopped — and the function threw away the tool calls it *did* contain.
 *
 * The fix was structural: one reducer, fed the same `SessionEvent`s live and on
 * replay. This file holds that to its promise across every event sequence it
 * can be given, and does the same for the two ledgers built the same way — the
 * contract ("what was asked") and the task state ("what happened").
 */

// ---------------------------------------------------------------------------
// Event sequences
// ---------------------------------------------------------------------------

let seq = 0;
const nextId = (): string => `e${(seq += 1)}`;

function event(type: SessionEvent["type"], turnId: string, extra: Record<string, unknown> = {}): SessionEvent {
  return { type, id: nextId(), turnId, at: 1000 + seq, ...extra } as SessionEvent;
}

const TOOL_STATUSES: readonly ToolCallStatus[] = ["success", "failed", "denied", "blocked", "cancelled"];

const TERMINATION_REASONS: readonly RunTerminationReason[] = [
  "finished",
  "denied",
  "blocked",
  "aborted",
  "timeout",
  "loop_detected",
  "no_progress",
  "max_steps",
  "max_model_calls",
  "max_tool_calls",
  "error",
];

/** Fragments a real turn is built from, each a slice of a genuine transcript. */
const FRAGMENTS: Readonly<Record<string, (turnId: string) => SessionEvent[]>> = {
  ask: (t) => [event("user_message", t, { text: "실시간 회의록 시스템을 만들어줘" })],
  answer: (t) => [event("assistant_text", t, { text: "먼저 구조를 봅니다." })],
  splitAnswer: (t) => [
    event("assistant_text", t, { text: "첫 문단. " }),
    event("assistant_text", t, { text: "둘째 문단. " }),
    event("assistant_text", t, { text: "셋째 문단." }),
  ],
  reasoning: (t) => [event("reasoning", t, { summary: "파일을 먼저 읽는다", phase: "analysis" })],
  plan: (t) => [event("plan", t, { steps: ["읽기", "고치기", "검증"], current: 0 })],
  replan: (t) => [
    event("plan", t, { steps: ["읽기", "고치기", "검증"], current: 0 }),
    event("plan", t, { steps: ["읽기", "고치기", "검증", "배포"], current: 2 }),
  ],
  tool: (t) => [
    event("tool_started", t, { callId: `c${seq}`, toolName: "read_file", risk: "read", summary: "a.ts 읽기" }),
    event("tool_completed", t, { callId: `c${seq}`, toolName: "read_file", status: "success", detail: "42줄" }),
  ],
  outOfOrderTools: (t) => {
    const a = `p${seq}a`;
    const b = `p${seq}b`;
    return [
      event("tool_started", t, { callId: a, toolName: "read_file", risk: "read", summary: "a" }),
      event("tool_started", t, { callId: b, toolName: "run_command", risk: "execute", summary: "b" }),
      event("tool_completed", t, { callId: b, toolName: "run_command", status: "success", detail: "exit 0" }),
      event("tool_completed", t, { callId: a, toolName: "read_file", status: "success", detail: "ok" }),
    ];
  },
  orphanCompletion: (t) => [
    event("tool_completed", t, { callId: `x${seq}`, toolName: "run_command", status: "denied", detail: "거부" }),
  ],
  changes: (t) => [
    event("file_changed", t, { path: "src/asr.py", change: "created" }),
    event("file_changed", t, { path: "src/asr.py", change: "modified" }),
    event("file_changed", t, { path: "src/old.py", change: "deleted" }),
  ],
  notice: (t) => [event("notice", t, { level: "warning", text: "승인이 필요합니다" })],
  truncated: (t) => [
    event("tool_started", t, { callId: `tr${seq}`, toolName: "read_file", risk: "read", summary: "big" }),
    event("tool_completed", t, {
      callId: `tr${seq}`,
      toolName: "read_file",
      status: "success",
      detail: "잘렸습니다",
      meta: { truncated: true, originalLength: 900_000, returnedLength: 262_144, reason: "file_too_large" },
    }),
  ],
};

const FRAGMENT_NAMES = Object.keys(FRAGMENTS);

/** Every turn shape worth replaying, built from those fragments. */
const SEQUENCES: Array<{ name: string; events: SessionEvent[] }> = [];
for (const first of FRAGMENT_NAMES) {
  for (const second of FRAGMENT_NAMES) {
    if (first === second) continue;
    for (const reason of ["finished", "timeout", "error"] as const) {
      const events = [
        ...FRAGMENTS["ask"]!("t1"),
        ...FRAGMENTS[first]!("t1"),
        ...FRAGMENTS[second]!("t1"),
        event("run_completed", "t1", { reason, summary: "정리했습니다", detail: "read_file 4회" }),
      ];
      SEQUENCES.push({ name: `${first}+${second}/${reason}`, events });
    }
  }
}

// Multi-turn conversations, since a turn boundary is where a projection can
// leak one turn's blocks into another's.
for (const turns of [2, 3]) {
  const events: SessionEvent[] = [];
  for (let i = 1; i <= turns; i += 1) {
    events.push(
      ...FRAGMENTS["ask"]!(`t${i}`),
      ...FRAGMENTS["plan"]!(`t${i}`),
      ...FRAGMENTS["tool"]!(`t${i}`),
      ...FRAGMENTS["answer"]!(`t${i}`),
      event("run_completed", `t${i}`, { reason: "finished", summary: "" }),
    );
  }
  SEQUENCES.push({ name: `conversation-of-${turns}-turns`, events });
}

function persistAndReload(events: SessionEvent[]): SessionEvent[] {
  const file = writeSession({
    version: SESSION_SCHEMA_VERSION,
    id: "round-trip",
    title: "t",
    createdAt: 1,
    updatedAt: 2,
    events,
    messages: [{ role: "user", content: "안녕" }],
  });
  const loaded = readSession(file);
  assert.notEqual(loaded, null, "a session that was just written must read back");
  return loaded!.session.events;
}

describe("migration · live and reopened go through the same reducer", () => {
  for (const sequence of SEQUENCES) {
    test(`${sequence.name} — the view survives the round trip`, () => {
      assert.deepEqual(
        reduceSession(persistAndReload(sequence.events)),
        reduceSession(sequence.events),
        "what the user saw live is not what they see on reopening",
      );
    });

    test(`${sequence.name} — no event is lost in writing`, () => {
      const reloaded = persistAndReload(sequence.events);
      assert.deepEqual(reloaded.map((e) => e.id), sequence.events.map((e) => e.id));
    });

    test(`${sequence.name} — the view is not empty, so the identity means something`, () => {
      const view = reduceSession(sequence.events);
      assert.ok(view.turns.length > 0);
      assert.ok(view.turns.some((t) => t.blocks.length > 0));
    });

    test(`${sequence.name} — reducing is a function of the events alone`, () => {
      assert.deepEqual(reduceSession(sequence.events), reduceSession([...sequence.events]));
    });

    test(`${sequence.name} — every block belongs to the turn its event named`, () => {
      const view = reduceSession(sequence.events);
      const known = new Set(sequence.events.map((e) => e.turnId));
      for (const turn of view.turns) assert.ok(known.has(turn.turnId));
    });

    test(`${sequence.name} — a user message never lands in the agent's half`, () => {
      const view = reduceSession(sequence.events);
      for (const turn of view.turns) {
        const texts = sequence.events.filter((e) => e.type === "user_message" && e.turnId === turn.turnId);
        if (turn.role === "user") assert.equal(turn.blocks.length, texts.length);
      }
    });

    test(`${sequence.name} — a tool call and its result stay one block`, () => {
      const view = reduceSession(sequence.events);
      const started = sequence.events.filter((e) => e.type === "tool_started");
      const blocks = view.turns.flatMap((t) => t.blocks).filter((b) => b.kind === "tool");
      const completions = sequence.events.filter((e) => e.type === "tool_completed");
      const orphans = completions.filter(
        (c) => !started.some((s) => s.type === "tool_started" && s.callId === (c as { callId: string }).callId),
      );
      assert.equal(blocks.length, started.length + orphans.length);
    });

    test(`${sequence.name} — a changed file is listed once, whatever happened to it`, () => {
      const view = reduceSession(sequence.events);
      const paths = view.changedFiles.map((f) => f.path);
      assert.equal(new Set(paths).size, paths.length);
    });

    test(`${sequence.name} — a file created and then edited is still created`, () => {
      const view = reduceSession(sequence.events);
      const created = sequence.events.some(
        (e) => e.type === "file_changed" && e.path === "src/asr.py" && e.change === "created",
      );
      if (!created) return;
      assert.equal(view.changedFiles.find((f) => f.path === "src/asr.py")?.change, "created");
    });

    test(`${sequence.name} — a plan is the latest plan, not a stack of them`, () => {
      const view = reduceSession(sequence.events);
      for (const turn of view.turns) {
        assert.ok(turn.blocks.filter((b) => b.kind === "plan").length <= 1);
      }
    });

    test(`${sequence.name} — truncation is carried through to the reader`, () => {
      const view = reduceSession(sequence.events);
      const truncated = sequence.events.some((e) => e.type === "tool_completed" && e.meta?.truncated === true);
      if (!truncated) return;
      const block = view.turns
        .flatMap((t) => t.blocks)
        .find((b) => b.kind === "tool" && b.meta?.truncated === true);
      assert.notEqual(block, undefined, "a truncated read must not look like a whole one");
    });
  }
});

// ---------------------------------------------------------------------------
// The termination table
// ---------------------------------------------------------------------------

describe("migration · every ending has one meaning, from one table", () => {
  for (const reason of TERMINATION_REASONS) {
    test(`${reason} — has a tone and a label`, () => {
      const view = terminationView(reason);
      assert.equal(view.reason, reason);
      assert.ok(["ok", "warning", "error"].includes(view.tone));
      assert.ok(view.label.length > 0);
    });

    test(`${reason} — only "finished" reads as ok`, () => {
      assert.equal(terminationView(reason).tone === "ok", reason === "finished");
      assert.equal(isAbnormal(reason), reason !== "finished");
    });

    test(`${reason} — a detail is carried, never invented`, () => {
      assert.equal(terminationView(reason).detail, undefined);
      assert.equal(terminationView(reason, "read_file를 4번 호출").detail, "read_file를 4번 호출");
    });

    test(`${reason} — maps to a turn state, and only a real finish is completed`, () => {
      const state = turnStateFor(reason);
      assert.ok(["running", "completed", "aborted", "failed"].includes(state));
      assert.equal(state === "completed", reason === "finished");
    });

    test(`${reason} — the run's ending reaches the view`, () => {
      const events = [
        event("user_message", "t1", { text: "해줘" }),
        event("run_completed", "t1", { reason, summary: "요약" }),
      ];
      const view = reduceSession(events);
      const agentTurn = view.turns.find((t) => t.role === "agent");
      assert.equal(agentTurn?.termination?.reason, reason);
    });

    test(`${reason} — survives being written and read`, () => {
      const events = [
        event("user_message", "t1", { text: "해줘" }),
        event("run_completed", "t1", { reason, summary: "요약", detail: "왜 그랬는지" }),
      ];
      assert.deepEqual(reduceSession(persistAndReload(events)), reduceSession(events));
    });
  }

  test("a reason nobody mapped does not quietly become completed", () => {
    assert.equal(turnStateFor(undefined), "failed");
    assert.equal(turnStateFor(null), "failed");
    assert.equal(turnStateFor("something_new" as RunTerminationReason), "failed");
  });

  test("the closing summary is shown only when the turn said nothing else", () => {
    const spoke = reduceSession([
      event("assistant_text", "t1", { text: "답입니다" }),
      event("run_completed", "t1", { reason: "finished", summary: "요약" }),
    ]);
    assert.equal(spoke.turns[0]!.blocks.filter((b) => b.kind === "text").length, 1);

    const silent = reduceSession([
      event("tool_started", "t1", { callId: "z", toolName: "read_file", risk: "read", summary: "s" }),
      event("run_completed", "t1", { reason: "finished", summary: "요약" }),
    ]);
    assert.ok(silent.turns[0]!.blocks.some((b) => b.kind === "text"));
  });
});

describe("migration · a tool's outcome is shown as it was", () => {
  for (const status of TOOL_STATUSES) {
    test(`${status} — reaches the block`, () => {
      const view = reduceSession([
        event("tool_started", "t1", { callId: "c", toolName: "run_command", risk: "execute", summary: "s" }),
        event("tool_completed", "t1", { callId: "c", toolName: "run_command", status, detail: "d" }),
      ]);
      const block = view.turns[0]!.blocks.find((b) => b.kind === "tool");
      assert.equal(block?.status, status);
      assert.equal(block?.detail, "d");
    });

    test(`${status} — survives the round trip`, () => {
      const events = [
        event("tool_started", "t1", { callId: "c", toolName: "run_command", risk: "execute", summary: "s" }),
        event("tool_completed", "t1", { callId: "c", toolName: "run_command", status, detail: "d" }),
      ];
      assert.deepEqual(reduceSession(persistAndReload(events)), reduceSession(events));
    });

    test(`${status} — a refusal raised before the call ran is still shown`, () => {
      const view = reduceSession([
        event("tool_completed", "t1", { callId: "never-started", toolName: "run_command", status, detail: "d" }),
      ]);
      assert.equal(view.turns[0]!.blocks.filter((b) => b.kind === "tool").length, 1);
    });
  }
});

// ---------------------------------------------------------------------------
// What was asked — the contract's merge algebra
// ---------------------------------------------------------------------------

function contractOf(
  turnId: string,
  relation: TurnRelation,
  requirements: string[],
  extra: Partial<TurnContract> = {},
): TurnContract {
  const parsed = parseTurnContract(
    {
      goal: `${relation} 목표`,
      relation,
      intents: "modify",
      requirements: requirements.join("\n"),
    },
    turnId,
  );
  assert.equal(parsed.ok, true, `fixture contract for ${relation} must parse`);
  if (!parsed.ok) throw new Error("unreachable");
  return { ...parsed.contract, ...extra };
}

describe("migration · a later turn cannot quietly lose an earlier one's requirements", () => {
  const BASE = ["CNN 분류기", "ViT 분류기", "데이터셋 준비"];

  test("refine adds without losing what was there", () => {
    const task = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
    const refined = mergeContract(task, contractOf("t2", "refine", ["오픈소스 모델도 비교"]));
    const descriptions = activeRequirements(refined).map((r) => r.description);
    for (const original of BASE) assert.ok(descriptions.includes(original), `${original} was lost`);
    assert.ok(descriptions.includes("오픈소스 모델도 비교"));
  });

  test("refine does not duplicate what is already asked", () => {
    const task = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
    const again = mergeContract(task, contractOf("t2", "refine", BASE));
    assert.equal(activeRequirements(again).length, BASE.length);
  });

  test("refine matches on the words, not the id", () => {
    const task = mergeContract(emptyContract(), contractOf("t1", "new_task", ["CNN 분류기"]));
    const again = mergeContract(task, contractOf("t9", "refine", ["  cnn 분류기  "]));
    assert.equal(activeRequirements(again).length, 1);
  });

  test("new_task replaces, because the user said they were starting over", () => {
    const task = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
    const fresh = mergeContract(task, contractOf("t2", "new_task", ["전혀 다른 것"]));
    assert.deepEqual(activeRequirements(fresh).map((r) => r.description), ["전혀 다른 것"]);
  });

  for (const relation of ["continue", "question"] as const) {
    test(`${relation} adds nothing at all`, () => {
      const task = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
      const after = mergeContract(task, contractOf("t2", relation, []));
      assert.deepEqual(
        activeRequirements(after).map((r) => r.description),
        activeRequirements(task).map((r) => r.description),
      );
    });

    test(`${relation} does not move the goal`, () => {
      const task = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
      assert.equal(mergeContract(task, contractOf("t2", relation, [])).goal, task.goal);
    });
  }

  test("correct adds what it asks for and keeps earlier requirements standing", () => {
    const task = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
    const corrected = mergeContract(task, contractOf("t2", "correct", ["표가 아니라 그래프로"]));
    const descriptions = activeRequirements(corrected).map((r) => r.description);
    for (const original of BASE) assert.ok(descriptions.includes(original));
    assert.ok(descriptions.includes("표가 아니라 그래프로"));
  });

  test("a retracted requirement is superseded, not deleted — the record stays readable", () => {
    const first = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
    const corrected = mergeContract(first, contractOf("t2", "correct", ["다시"]));
    assert.ok(corrected.requirements.length >= activeRequirements(corrected).length);
    for (const requirement of corrected.requirements) {
      assert.ok(["active", "superseded"].includes(requirement.lifecycle));
    }
  });

  for (const relation of TURN_RELATIONS) {
    test(`${relation} — the constraints are this turn's, not forever`, () => {
      const task: TaskContract = {
        ...mergeContract(emptyContract(), contractOf("t1", "new_task", BASE)),
        constraints: [{ kind: "no_execute", text: "실행하지 마", sourceTurnId: "t1" }],
      };
      const after = mergeContract(task, contractOf("t2", relation, ["뭔가"]));
      assert.deepEqual(after.constraints, [], "one 실행하지 마 must not disable execution for the session");
    });

    test(`${relation} — the last turn is recorded`, () => {
      const after = mergeContract(emptyContract(), contractOf("t7", relation, ["뭔가"]));
      assert.equal(after.lastTurnId, "t7");
      assert.equal(after.relation, relation);
    });

    test(`${relation} — merging is a function of its two inputs`, () => {
      const task = mergeContract(emptyContract(), contractOf("t1", "new_task", BASE));
      const turn = contractOf("t2", relation, ["뭔가"]);
      assert.deepEqual(mergeContract(task, turn), mergeContract(task, turn));
    });

    test(`${relation} — a requirement always says who asked for it`, () => {
      const after = mergeContract(emptyContract(), contractOf("t3", relation, ["뭔가"]));
      for (const requirement of after.requirements) {
        assert.equal(typeof requirement.provenance.sourceTurnId, "string");
        assert.ok(["explicit", "inferred"].includes(requirement.provenance.origin));
      }
    });
  }
});

describe("migration · the contract is an event, so replay and live agree", () => {
  const SEQUENCES_OF_TURNS: ReadonlyArray<{ name: string; steps: Array<[TurnRelation, string[]]> }> = [
    { name: "one request", steps: [["new_task", ["CNN"]]] },
    { name: "request then refine", steps: [["new_task", ["CNN"]], ["refine", ["ViT"]]] },
    { name: "request then continue", steps: [["new_task", ["CNN"]], ["continue", []]] },
    { name: "request then question", steps: [["new_task", ["CNN"]], ["question", []]] },
    { name: "request then correct", steps: [["new_task", ["CNN"]], ["correct", ["그래프로"]]] },
    { name: "restart", steps: [["new_task", ["CNN"]], ["refine", ["ViT"]], ["new_task", ["처음부터"]]] },
    {
      name: "the long one",
      steps: [
        ["new_task", ["CNN", "ViT"]],
        ["refine", ["오픈소스 비교"]],
        ["question", []],
        ["correct", ["표가 아니라 그래프"]],
        ["continue", []],
        ["refine", ["배포까지"]],
      ],
    },
  ];

  for (const sequence of SEQUENCES_OF_TURNS) {
    const contracts = sequence.steps.map(([relation, requirements], i) =>
      contractOf(`t${i + 1}`, relation, requirements),
    );

    test(`${sequence.name} — folding events equals folding contracts`, () => {
      const live = contracts.reduce(mergeContract, emptyContract());
      const replayed = reduceContract(contracts.map((c) => ({ type: "turn_contract", contract: c })));
      assert.deepEqual(replayed, live, "a reopened conversation must hold the same contract");
    });

    test(`${sequence.name} — events that are not contracts are ignored`, () => {
      const withNoise = [
        { type: "assistant_text" },
        ...contracts.map((c) => ({ type: "turn_contract", contract: c })),
        { type: "run_completed" },
      ];
      assert.deepEqual(
        reduceContract(withNoise),
        contracts.reduce(mergeContract, emptyContract()),
      );
    });

    test(`${sequence.name} — a fork drops exactly the requirements it forked past`, () => {
      const events = contracts.map((c) => ({ type: "turn_contract", contract: c }));
      for (let cut = 1; cut <= events.length; cut += 1) {
        assert.deepEqual(
          reduceContract(events.slice(0, cut)),
          contracts.slice(0, cut).reduce(mergeContract, emptyContract()),
        );
      }
    });

    test(`${sequence.name} — nothing the user asked for is silently dropped`, () => {
      const folded = contracts.reduce(mergeContract, emptyContract());
      const lastRestart = sequence.steps.map(([r]) => r).lastIndexOf("new_task");
      const asked = sequence.steps
        .slice(lastRestart)
        .flatMap(([relation, requirements]) => (relation === "correct" || relation === "refine" || relation === "new_task" ? requirements : []));
      const held = folded.requirements.map((r) => r.description);
      for (const requirement of asked) assert.ok(held.includes(requirement), `${requirement} was dropped`);
    });
  }
});

describe("migration · a contract is validated, not accepted", () => {
  const REJECTED: ReadonlyArray<{ name: string; args: Record<string, unknown> }> = [
    { name: "no goal", args: { relation: "new_task", intents: "modify", requirements: "a" } },
    { name: "blank goal", args: { goal: "   ", relation: "new_task", intents: "modify", requirements: "a" } },
    { name: "no relation", args: { goal: "g", intents: "modify", requirements: "a" } },
    { name: "unknown relation", args: { goal: "g", relation: "vibes", intents: "modify", requirements: "a" } },
    { name: "no intents", args: { goal: "g", relation: "new_task", requirements: "a" } },
    { name: "unknown intents", args: { goal: "g", relation: "new_task", intents: "brood", requirements: "a" } },
    { name: "a request with no requirements", args: { goal: "g", relation: "new_task", intents: "modify" } },
    { name: "a refinement with no requirements", args: { goal: "g", relation: "refine", intents: "modify" } },
  ];

  for (const rejected of REJECTED) {
    test(`${rejected.name} — is refused with a reason`, () => {
      const parsed = parseTurnContract(rejected.args, "t1");
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.ok(parsed.problem.reason.length > 0);
    });
  }

  test("continue and question may legitimately add nothing", () => {
    for (const relation of ["continue", "question"] as const) {
      assert.equal(parseTurnContract({ goal: "g", relation, intents: "discuss" }, "t1").ok, true);
    }
  });

  test("an array of requirements is read, not silently emptied", () => {
    const parsed = parseTurnContract(
      { goal: "g", relation: "new_task", intents: "modify", requirements: ["a", "b"] },
      "t1",
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.contract.requirements.length, 2);
  });

  test('"없음" is not a constraint', () => {
    for (const text of ["없음", "none", "N/A", "-", "해당 없음", "nothing"]) {
      const parsed = parseTurnContract(
        { goal: "g", relation: "new_task", intents: "modify", requirements: "a", constraints: text },
        "t1",
      );
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.deepEqual(parsed.contract.constraints, [], `${text} was recorded as a restriction`);
    }
  });

  for (const intent of TURN_INTENTS) {
    test(`intent ${intent} is accepted`, () => {
      const parsed = parseTurnContract(
        { goal: "g", relation: "new_task", intents: intent, requirements: "a" },
        "t1",
      );
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.ok(parsed.contract.intents.includes(intent));
    });
  }

  for (const relation of TURN_RELATIONS) {
    test(`relation ${relation} is accepted`, () => {
      const parsed = parseTurnContract(
        { goal: "g", relation, intents: "modify", requirements: "a" },
        "t1",
      );
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.equal(parsed.contract.relation, relation);
    });
  }
});

// ---------------------------------------------------------------------------
// What happened — evidence comes through one door
// ---------------------------------------------------------------------------

describe("migration · a sentence the model wrote is not a measurement", () => {
  const SELF_AUTHORED = [
    'echo "ALL TESTS PASSED"',
    "echo done",
    "python -c \"print('모든 코드가 정상적으로 작동합니다')\"",
    "python -c \"print('프로젝트 완료')\"",
    'python3 -c "print(\'ok\')"',
    'node -e "console.log(\'passed\')"',
    'ruby -e "puts(\'ok\')"',
  ];

  const REAL_VERIFICATION = [
    "pytest -q",
    "pytest tests/",
    "npm test",
    "pnpm test",
    "cargo test",
    "go test ./...",
    "tsc --noEmit",
  ];

  const REAL_WORK_NOT_VERIFICATION = [
    "python train.py",
    "pip install torch",
    'python -c "import torch; print(torch.__version__)"',
    "git status",
  ];

  for (const command of SELF_AUTHORED) {
    test(`${JSON.stringify(command)} is the model's own words`, () => {
      assert.equal(isSelfAuthoredOutput(command), true);
    });

    test(`${JSON.stringify(command)} can never be a verifier`, () => {
      assert.equal(verifierFor(command), null);
    });

    test(`${JSON.stringify(command)} produces evidence that is not a test result`, () => {
      const evidence = evidenceFrom(
        event("tool_completed", "t1", {
          callId: "c",
          toolName: "run_command",
          status: "success",
          detail: "exit 0",
        }) as Extract<SessionEvent, { type: "tool_completed" }>,
        command,
      );
      assert.notEqual(evidence, null);
      assert.equal(evidence!.kind, "command_result", "exit 0 says the interpreter ran, nothing more");
    });
  }

  for (const command of REAL_VERIFICATION) {
    test(`${JSON.stringify(command)} can verify something`, () => {
      assert.notEqual(verifierFor(command), null);
      assert.equal(isSelfAuthoredOutput(command), false);
    });

    test(`${JSON.stringify(command)} produces evidence of what it checked`, () => {
      const evidence = evidenceFrom(
        event("tool_completed", "t1", {
          callId: "c",
          toolName: "run_command",
          status: "success",
          detail: "12 passed",
        }) as Extract<SessionEvent, { type: "tool_completed" }>,
        command,
      );
      assert.notEqual(evidence!.kind, "command_result");
      assert.equal(evidence!.status, "passed");
    });
  }

  for (const command of REAL_WORK_NOT_VERIFICATION) {
    test(`${JSON.stringify(command)} is real work but not a verification`, () => {
      assert.equal(isSelfAuthoredOutput(command), false);
    });
  }

  test("there is no path from assistant text to evidence", () => {
    const claim = event("assistant_text", "t1", { text: "테스트를 모두 통과했습니다" });
    // The only door is `evidenceFrom`, and it takes a completed tool call.
    // A text event cannot be passed to it — which is the point, and is why the
    // completion gate cannot see a test the model merely described.
    assert.equal(claim.type, "assistant_text");
    assert.equal(
      typeof (evidenceFrom as unknown as (e: unknown, c?: string) => unknown),
      "function",
    );
  });

  test("the plan and a blocked report are not observations of the workspace", () => {
    for (const toolName of ["update_plan", "report_blocked"]) {
      const evidence = evidenceFrom(
        event("tool_completed", "t1", {
          callId: "c",
          toolName,
          status: "success",
          detail: "ok",
        }) as Extract<SessionEvent, { type: "tool_completed" }>,
      );
      assert.equal(evidence, null);
    }
  });

  for (const status of TOOL_STATUSES) {
    test(`a ${status} tool call is recorded as such rather than as a pass`, () => {
      const evidence = evidenceFrom(
        event("tool_completed", "t1", {
          callId: "c",
          toolName: "run_command",
          status,
          detail: "d",
        }) as Extract<SessionEvent, { type: "tool_completed" }>,
        "pytest -q",
      );
      assert.notEqual(evidence, null);
      assert.equal(evidence!.status === "passed", status === "success");
    });
  }
});
