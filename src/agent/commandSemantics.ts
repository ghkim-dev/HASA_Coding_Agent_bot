import type { AgentCommandSpec } from "./commandSpec.ts";

/**
 * Whether a command means anything, as opposed to merely parsing.
 *
 * From a real session, in order:
 *
 *     pip matplotlib   → ERROR: unknown command "matplotlib"
 *     pip install      → You must give at least one requirement to install
 *     pip install      → (the same, again)
 *     python -m        → Argument expected for the -m option
 *     python -m        → (the same, again)
 *     python -c        → Argument expected for the -c option
 *     python           → REPL banner, exit 0
 *
 * and then, from the agent: "패키지 설치가 불가능한 환경입니다."
 *
 * Every one of those spawned. `pip` was found, ran, and complained about its
 * arguments — which is evidence that the environment works, and the agent read
 * it as evidence that the environment does not. The runtime had enough to know
 * better before any of it: an incomplete invocation is not a broken machine.
 *
 * ## Deliberately small
 *
 * This is not a command-line parser and must not grow into one. It knows a
 * handful of invocations that are wrong on their face, and answers `unknown`
 * for everything else — `npm install` with no package is perfectly meaningful,
 * and a validator that guessed would start refusing correct work.
 *
 * The test for adding a rule: would the program itself reject this, always,
 * before doing anything? If not, it does not belong here.
 */

export const INVALID_COMMAND_ARGUMENTS = "INVALID_COMMAND_ARGUMENTS";
export const INTERACTIVE_COMMAND_REQUIRES_PTY = "INTERACTIVE_COMMAND_REQUIRES_PTY";

export interface SemanticProblem {
  code: string;
  /** What is missing, in one line. */
  reason: string;
  /** What a correct call looks like, so the fix is obvious rather than guessed. */
  expected: string;
}

/** The program name, without a path or a Windows extension. */
export function bareName(executable: string): string {
  return executable.toLowerCase().replace(/\.(exe|cmd|bat)$/, "").split(/[\/]/).pop() ?? "";
}

/** Interpreters whose bare invocation opens a REPL rather than doing anything. */
const REPL_WHEN_BARE = new Set(["python", "python3", "node", "irb", "ruby", "php", "R"]);

/** Interpreter flags that take a value immediately after them. */
const FLAGS_NEEDING_VALUE: Readonly<Record<string, Record<string, { what: string; example: string }>>> = {
  python: {
    "-m": { what: "실행할 모듈 이름", example: "python -m pip install torch" },
    "-c": { what: "실행할 코드", example: 'python -c "import torch; print(torch.__version__)"' },
  },
  node: {
    "-e": { what: "실행할 코드", example: 'node -e "console.log(1)"' },
    "--eval": { what: "실행할 코드", example: 'node --eval "console.log(1)"' },
  },
};

/**
 * pip subcommands that need at least one operand.
 *
 * `pip list` and `pip freeze` need nothing; `install` and `uninstall` need
 * something to act on. Only the ones that are certain are here.
 */
const PIP_NEEDS_OPERAND = new Set(["install", "uninstall", "download"]);

/** Every pip subcommand, so an operand in the subcommand slot can be named. */
const PIP_SUBCOMMANDS = new Set([
  "install", "uninstall", "download", "list", "freeze", "show", "search",
  "check", "config", "wheel", "hash", "cache", "index", "debug", "help",
]);

/**
 * Checks whether a command can do anything, before it is spawned.
 *
 * Returns null when the command is fine *or* when this file has no confident
 * opinion. Those two are the same answer on purpose: an unrecognised command is
 * allowed to run, because the cost of a wrong refusal is work that cannot
 * happen and the cost of a wrong permission is one clear error message.
 */
export function validateSemantics(spec: AgentCommandSpec): SemanticProblem | null {
  // A shell command is the user's own line, and its syntax is the shell's
  // business. Only structured calls are checked here.
  if (spec.mode !== "exec") return null;

  const name = bareName(spec.executable);
  const args = spec.args;

  // A flag whose value is missing. `python -m` with nothing after it is the
  // interpreter's own error, and it is the same error every time.
  const flags = FLAGS_NEEDING_VALUE[name];
  if (flags !== undefined) {
    for (let i = 0; i < args.length; i += 1) {
      const rule = flags[args[i]!];
      if (rule === undefined) continue;
      const value = args[i + 1];
      if (value === undefined || value.trim().length === 0) {
        return {
          code: INVALID_COMMAND_ARGUMENTS,
          reason: `${args[i]} 다음에 ${rule.what}이(가) 필요합니다.`,
          expected: rule.example,
        };
      }
    }
  }

  // An interpreter with nothing to do opens a REPL. There is no terminal
  // attached here, so it prints a banner and exits 0 — which reads as success
  // and is not one. PTY support is a different piece of work; refusing is the
  // honest answer until it exists.
  if (args.length === 0 && REPL_WHEN_BARE.has(name)) {
    return {
      code: INTERACTIVE_COMMAND_REQUIRES_PTY,
      reason:
        `${name}을(를) 인자 없이 실행하면 대화형 세션이 열립니다. 여기에는 터미널이 붙어 있지 않아 ` +
        "배너만 출력하고 끝나며, 그것은 성공이 아닙니다.",
      expected: `${name} <스크립트 파일>  또는  ${name} -c "<코드>"`,
    };
  }

  const pip = pipArgumentsOf(name, args);
  if (pip !== null) return pip;

  return null;
}

/**
 * pip, whether reached directly or through `python -m pip`.
 *
 * Both spellings arrive here so the same mistake gets the same answer, and the
 * suggested fix is the form that works when several Pythons are installed.
 */
function pipArgumentsOf(name: string, args: readonly string[]): SemanticProblem | null {
  let rest: readonly string[] | null = null;
  if (name === "pip" || name === "pip3") rest = args;
  else if (args[0] === "-m" && (args[1] === "pip")) rest = args.slice(2);
  if (rest === null) return null;

  const operands = rest.filter((a) => !a.startsWith("-"));
  const subcommand = operands[0];
  if (subcommand === undefined) return null;

  if (!PIP_SUBCOMMANDS.has(subcommand)) {
    return {
      code: INVALID_COMMAND_ARGUMENTS,
      reason: `pip에 ${subcommand}(이)라는 하위 명령은 없습니다. 설치하려는 것이라면 install이 빠졌습니다.`,
      expected: `python -m pip install ${subcommand}`,
    };
  }

  if (PIP_NEEDS_OPERAND.has(subcommand) && operands.length === 1 && !rest.some((a) => a === "-r" || a === "--requirement")) {
    return {
      code: INVALID_COMMAND_ARGUMENTS,
      reason: `pip ${subcommand} 에는 대상이 하나 이상 필요합니다.`,
      expected: "python -m pip install torch torchvision matplotlib",
    };
  }
  return null;
}

/** What the model is told. Says what is missing and what to send instead. */
export function describeSemanticProblem(problem: SemanticProblem, spec: AgentCommandSpec): string {
  const what = spec.mode === "exec" ? [spec.executable, ...spec.args].join(" ") : spec.command;
  return [
    `${problem.code}: \`${what}\` 은(는) 실행하지 않았습니다.`,
    problem.reason,
    `이렇게 보내십시오: ${problem.expected}`,
    "이것은 환경 문제가 아니라 명령 구성 문제입니다. 고쳐서 다시 시도하십시오.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// What kind of failure this was
// ---------------------------------------------------------------------------

/**
 * Why a command did not do what was wanted.
 *
 * The distinction that matters is one line: some of these are facts about the
 * machine and some are facts about what the agent typed. Only the first kind
 * can support "this cannot be done here", and the transcript this came from
 * used the second kind to claim exactly that.
 *
 * Classification is deliberately partial. `PROCESS_FAILED` is the honest answer
 * for most non-zero exits, and stretching a guess into a category would produce
 * confident wrong labels on the evidence a blocker claim rests on.
 */
export type FailureKind =
  /** The agent's own invocation was incomplete or wrong. Not a blocker. */
  | "invalid_invocation"
  | "executable_not_found"
  | "permission_denied"
  | "network_failure"
  | "sandbox_denied"
  | "approval_denied"
  | "timeout"
  | "cancelled"
  /** It ran and returned non-zero. Says nothing about why on its own. */
  | "process_failed"
  | "unknown_failure";

/**
 * Failures that are evidence about the environment rather than about the agent.
 *
 * `process_failed` is not here, and that is the point: a program exiting
 * non-zero is usually a fact about the code it was given.
 */
const EXTERNAL_BLOCKERS: ReadonlySet<FailureKind> = new Set([
  "executable_not_found",
  "permission_denied",
  "network_failure",
  "sandbox_denied",
  "approval_denied",
]);

/** High-confidence markers only. Everything else stays unknown. */
const FAILURE_MARKERS: ReadonlyArray<{ match: RegExp; kind: FailureKind }> = [
  { match: /INVALID_COMMAND_ARGUMENTS|INTERACTIVE_COMMAND_REQUIRES_PTY|INVALID_COMMAND_USE_/, kind: "invalid_invocation" },
  { match: /\bENOENT\b|is not installed|command not found|not recognized as an internal/i, kind: "executable_not_found" },
  { match: /\bEACCES\b|\bEPERM\b|permission denied|access is denied/i, kind: "permission_denied" },
  { match: /\bENOTFOUND\b|\bECONNREFUSED\b|\bETIMEDOUT\b|network is unreachable|temporary failure in name resolution|proxy/i, kind: "network_failure" },
  { match: /sandbox violation|COMMAND_CWD_OUTSIDE_WORKSPACE/i, kind: "sandbox_denied" },
  { match: /declined this action|승인하지/i, kind: "approval_denied" },
  { match: /timed out|시간 제한/i, kind: "timeout" },
];

/**
 * Reads what kind of failure a result describes.
 *
 * Also reads the *interpreter's own* complaints about its arguments, because
 * those are the same mistake arriving one step later — `pip` saying "you must
 * give at least one requirement" is not a broken environment either.
 */
export function classifyFailure(detail: string): FailureKind {
  for (const marker of FAILURE_MARKERS) {
    if (marker.match.test(detail)) return marker.kind;
  }
  if (
    /must give at least one requirement|argument expected for the|unknown command|no such option|expected one argument/i.test(
      detail,
    )
  ) {
    return "invalid_invocation";
  }
  return /exit [1-9]/.test(detail) ? "process_failed" : "unknown_failure";
}

/** Whether this failure can support a claim that something cannot be done here. */
export function isExternalBlocker(kind: FailureKind): boolean {
  return EXTERNAL_BLOCKERS.has(kind);
}
