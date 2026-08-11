import type { NormalizedToolCall, ProviderChatRequest } from "../provider/types.ts";
import type { EvalScenario } from "./scenario.ts";
import type { AgentCompletion, AgentModel } from "../agent/types.ts";

/**
 * Models that behave badly on purpose, so the evaluator can be checked.
 *
 * The thing nobody can test with a real model: whether a number in the
 * scoreboard means what it says. A real model's behaviour is not known in
 * advance, so a wrong metric and a surprising model look identical. These are
 * known in advance — a model that omits exactly two requirements should show a
 * recall of exactly 7/9 — and `evaluator.test.ts` asserts that it does.
 *
 * They are not baselines and are not comparable to anything. They exist to make
 * the ruler straight before anything is measured with it.
 *
 * ## How they work
 *
 * Each is one behaviour spec driving a small policy that reads the conversation
 * so far. They speak the same `AgentModel` interface a real model does, so they
 * go through the identical `AgentSession`, tools, preflight and gate.
 */

export interface Behaviour {
  /** How many of the fixture's requirements it records. 1 is all of them. */
  recordFraction: number;
  /** `correct` reads the fixture; `always_new_task` is the classic misreading. */
  relation: "correct" | "always_new_task";
  /** Whether the first substantive action is a sensible one. */
  firstAction: "correct" | "wrong_execute";
  /** Malformed commands proposed before getting it right. */
  invalidInvocations: number;
  /** Whether it fixes what the runtime objects to, or repeats it. */
  recovers: boolean;
  /** What it tries to say at the end. */
  claim: "grounded" | "cross_source" | "premature_completion" | "false_blocker";
  /** Whether it writes down what a fetched page carried. */
  recordsFacts: "all" | "some" | "none";
  /** Whether it reads pages the user named at all. */
  fetchesNamedSources: boolean;
}

export const GOOD: Behaviour = {
  recordFraction: 1,
  relation: "correct",
  firstAction: "correct",
  invalidInvocations: 0,
  recovers: true,
  claim: "grounded",
  recordsFacts: "all",
  fetchesNamedSources: true,
};

/** Wrong in every way the control plane was built for, and it listens. */
export const SLOPPY: Behaviour = {
  recordFraction: 0.5,
  relation: "always_new_task",
  firstAction: "wrong_execute",
  invalidInvocations: 2,
  recovers: true,
  claim: "cross_source",
  recordsFacts: "some",
  fetchesNamedSources: true,
};

/** The same, and it does not listen. Every containment number has to hold anyway. */
export const STUBBORN: Behaviour = {
  ...SLOPPY,
  recovers: false,
  invalidInvocations: 6,
  claim: "false_blocker",
  recordsFacts: "none",
  fetchesNamedSources: false,
};

/** Behaves, then claims the work is done when it is not. */
export const OVERCLAIMER: Behaviour = {
  ...GOOD,
  claim: "premature_completion",
  recordsFacts: "none",
};

interface State {
  turn: number;
  step: number;
  contracted: boolean;
  planned: boolean;
  invalidsLeft: number;
  fetched: string[];
  factsWritten: number;
  read: string[];
  ran: string[];
  finished: boolean;
}

let counter = 0;
function call(name: string, args: Record<string, unknown>): NormalizedToolCall {
  counter += 1;
  return {
    id: `c${counter}`,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
    argumentsValid: true,
  };
}

function completion(over: Partial<AgentCompletion>): AgentCompletion {
  return { text: "", reasoning: "", toolCalls: [], inputTokens: 10, outputTokens: 20, ...over };
}

/**
 * A model that plays one scenario according to one behaviour.
 *
 * It reads the fixture to know what "correct" means, which is fine and is the
 * point: it is a stand-in for a model that understood the request, not a
 * measurement of whether understanding is possible.
 */
export function fakeModel(scenario: EvalScenario, behaviour: Behaviour, id: string): AgentModel {
  const state: State = {
    turn: -1,
    step: 0,
    contracted: false,
    planned: false,
    invalidsLeft: behaviour.invalidInvocations,
    fetched: [],
    factsWritten: 0,
    read: [],
    ran: [],
    finished: false,
  };
  let lastUserCount = 0;

  return {
    modelId: id,
    async complete(request: Omit<ProviderChatRequest, "modelId">): Promise<AgentCompletion> {
      // A new turn is a new message *from the user*, and not every user-role
      // message is one: the runtime pushes its corrections onto the same role,
      // so counting the role advanced the turn in the middle of one and every
      // contract after the first carried the next turn's relation. Matched
      // against the fixture's own text instead, which is information a real
      // model has too — it is the message it was sent.
      const users = request.messages.filter(
        (m) =>
          m.role === "user" &&
          // `startsWith`, not `includes`. The runtime's record message quotes
          // the task's goal — which is the first user message — so a substring
          // test matched it and advanced the turn in the middle of one.
          scenario.turns.some((t) => String(m.content ?? "").trim().startsWith(t.user.slice(0, 40))),
      ).length;
      if (users > lastUserCount) {
        lastUserCount = users;
        state.turn += 1;
        state.step = 0;
        state.contracted = false;
        state.planned = false;
        state.finished = false;
        state.invalidsLeft = behaviour.invalidInvocations;
      }
      state.step += 1;

      const turn = scenario.turns[state.turn];
      if (turn === undefined) return completion({ text: "done" });
      const names = new Set(request.tools?.map((t) => t.name) ?? []);
      const lastResult = request.messages.at(-1);
      const objected =
        lastResult?.role === "tool" || lastResult?.role === "user"
          ? String(lastResult.content ?? "")
          : "";

      // 1. The contract, always first.
      if (!state.contracted && names.has("record_request")) {
        state.contracted = true;
        const wanted = turn.requirements ?? [];
        const keep = Math.max(
          wanted.length === 0 ? 0 : 1,
          Math.round(wanted.length * behaviour.recordFraction),
        );
        return completion({
          toolCalls: [
            call("record_request", {
              goal: turn.user.slice(0, 80),
              relation: behaviour.relation === "correct" ? (turn.expectedRelation ?? "new_task") : "new_task",
              intents: intentsFor(turn.user, turn.forbids ?? []),
              requirements: wanted.slice(0, keep).join("\n"),
              ...(turn.forbids === undefined
                ? {}
                : { constraints: turn.forbids.map((f) => `no_${f}: ${turn.user}`).join("\n") }),
            }),
          ],
        });
      }

      // 2. A plan, so the runtime has requirements to settle.
      if (!state.planned && names.has("update_plan")) {
        state.planned = true;
        return completion({
          toolCalls: [call("update_plan", { steps: planFor(turn.user), current: 0 })],
        });
      }

      // 3. Work. Bounded, so a stubborn model still terminates.
      if (state.step < 9) {
        const action = nextAction(scenario, turn, behaviour, state, names, objected);
        if (action !== null) return completion({ toolCalls: [action] });
      }

      // 4. The answer.
      state.finished = true;
      return completion({ text: answerFor(scenario, behaviour, state) });
    },
  };
}

function intentsFor(user: string, forbids: readonly string[]): string {
  const out: string[] = [];
  if (/보여|알려|정리|확인|분석/.test(user)) out.push("present", "inspect");
  // "실행하지 말고" contains 실행. A keyword match on a negated sentence is the
  // classic misreading, and a stand-in for a model that understood the request
  // must not make it — the fixture says what the sentence forbids.
  if (/실행|돌려|학습|설치/.test(user) && !forbids.includes("execute")) out.push("execute");
  if (/만들|추가|수정|번역/.test(user) && !forbids.includes("modify")) out.push("modify");
  if (/찾아|검색|참고|기준으로/.test(user)) out.push("research");
  if (/왜|어때|무엇/.test(user)) out.push("discuss");
  return out.length === 0 ? "continue" : out.join("\n");
}

function planFor(user: string): string {
  const steps = ["요청 확인"];
  if (/실행|돌려|학습/.test(user)) steps.push("코드 실행");
  if (/보여|정리|확인|분석/.test(user)) steps.push("파일 읽기");
  if (/찾아|검색|기준으로|모델/.test(user)) steps.push("모델 검색");
  return steps.join("\n");
}

/**
 * The next thing to do, or null when there is nothing left.
 *
 * The order matters and mirrors what a model actually does: obey the correction
 * it just received, then reach for the tool the turn calls for.
 */
function nextAction(
  scenario: EvalScenario,
  turn: { user: string; forbids?: Array<"execute" | "modify"> },
  behaviour: Behaviour,
  state: State,
  names: ReadonlySet<string>,
  objected: string,
): NormalizedToolCall | null {
  const user = turn.user;
  // A model that read the request does not propose what the request forbade.
  // The sloppy ones do, on purpose, and the harness has to hold them.
  const mayExecute = behaviour.firstAction !== "correct" || turn.forbids?.includes("execute") !== true;
  const wasRefused = /INVALID_COMMAND|ACTION_DENIED|ACTION_REQUIRES|은\(는\) 이번 세션에서 읽은|없습니다/.test(
    objected,
  );
  if (wasRefused && !behaviour.recovers && state.step < 6) {
    // Repeats itself. Every containment number has to hold against this.
    return call("run_command", { command: "pip install" });
  }

  // A malformed command, up to the behaviour's quota.
  if (state.invalidsLeft > 0 && mayExecute && /설치|install|학습|실행/.test(user) && names.has("run_command")) {
    state.invalidsLeft -= 1;
    return call("run_command", { command: "pip install" });
  }

  // The wrong first action, when the behaviour calls for one.
  if (behaviour.firstAction === "wrong_execute" && state.step <= 4 && names.has("run_command")) {
    // Two attempts, then it moves on. A model that only ever proposes the
    // forbidden thing never reaches the rest of the scenario, and the rest is
    // what the other metrics are measured on.
    if (state.ran.filter((r) => r === "__wrong").length < 2) {
      state.ran.push("__wrong");
      return call("run_command", { executable: "python", args: "main.py" });
    }
  }

  const urls = scenario.turns.flatMap((t) => t.exactSources ?? []);
  if (behaviour.fetchesNamedSources && names.has("web_fetch")) {
    const next = urls.find((u) => !state.fetched.includes(u));
    if (next !== undefined) {
      state.fetched.push(next);
      return call("web_fetch", { url: next });
    }
    // The other services the fixture knows about, so isolation can be tested.
    for (const host of Object.keys(scenario.entities ?? {})) {
      const url = `https://${host}/models`;
      if (!state.fetched.includes(url)) {
        state.fetched.push(url);
        return call("web_fetch", { url });
      }
    }
  }

  // Note-taking.
  if (behaviour.recordsFacts !== "none" && names.has("record_source_fact")) {
    const wanted = Object.entries(scenario.entities ?? {}).flatMap(([host, subjects]) =>
      subjects.map((subject) => ({ host, subject })),
    );
    const budget = behaviour.recordsFacts === "all" ? wanted.length : Math.ceil(wanted.length / 2);
    const next = wanted[state.factsWritten];
    if (next !== undefined && state.factsWritten < budget && state.fetched.some((u) => u.includes(next.host))) {
      state.factsWritten += 1;
      return call("record_source_fact", {
        url: `https://${next.host}/models`,
        subject: next.subject,
        predicate: "listed",
      });
    }
  }

  if (/보여|분석|정리|확인|왜/.test(user) && names.has("read_file")) {
    // Each file once. Reading the same one three times is a stall, and a fake
    // model that trips the stall detector would be measuring the detector.
    const file = Object.keys(scenario.world?.files ?? {}).find((f) => !state.read.includes(f));
    if (file !== undefined) {
      state.read.push(file);
      return call("read_file", { path: file });
    }
  }

  if (behaviour.claim === "false_blocker" && names.has("report_blocked") && state.step >= 5) {
    return call("report_blocked", {
      goal: "패키지 설치",
      obstacle: "패키지를 설치할 수 없는 환경입니다",
      tried: "pip install",
    });
  }

  if (mayExecute && /실행|돌려|학습/.test(user) && names.has("run_command")) {
    const file =
      Object.keys(scenario.world?.files ?? {}).find((f) => f.endsWith(".py") && !state.ran.includes(f)) ??
      (state.ran.includes("main.py") ? undefined : "main.py");
    if (file !== undefined) {
      state.ran.push(file);
      return call("run_command", { executable: "python", args: file });
    }
  }

  return null;
}

function answerFor(scenario: EvalScenario, behaviour: Behaviour, state: State): string {
  const hosts = Object.keys(scenario.entities ?? {});
  if (behaviour.claim === "cross_source" && hosts.length >= 2) {
    const [a, b] = hosts;
    const subject = scenario.entities?.[a ?? ""]?.[0] ?? "";
    // The provenance failure, said out loud: a thing found on one site,
    // reported as the other's.
    return `${subject} 은(는) ${b} 에서 사용할 수 있습니다.`;
  }
  if (behaviour.claim === "premature_completion") {
    return "요청하신 작업을 모두 완료했습니다.";
  }
  void state;
  return "확인한 범위에서 정리했습니다.";
}
