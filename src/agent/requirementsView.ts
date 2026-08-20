import { assessCompletion, type RequirementStatus, type TaskState } from "./taskState.ts";
import { activeRequirements, planCoverage, type TaskContract } from "./turnContract.ts";
import { taskDisposition, type TaskDisposition } from "./finalClaims.ts";

/**
 * What the user asked for, and where each of those things has got to.
 *
 * The runtime has tracked this since C4.2 and nothing on screen said so. The
 * contract reached `sessionRecorder`, was written to the conversation file, and
 * stopped: `sessionView` did not read it, the panel was never sent it, and the
 * webview had no case for it. So a user watched an agent call tools and had no
 * way to see that their nine requirements were being held — or that two of them
 * had quietly fallen out of the plan.
 *
 * Two lists are joined here, and keeping them straight is the whole job:
 *
 *   contract requirements — what the *user* said, owned by the runtime, never
 *                           dropped because a plan forgot them
 *   plan steps            — how the *model* means to proceed, and the only
 *                           thing evidence attaches a status to
 *
 * They are not the same list and there is no authoritative mapping between
 * them. What there is, is `planCoverage`, a deliberately loose word overlap —
 * so a requirement's status here is "the plan step that appears to cover it",
 * and a requirement no step covers is shown as exactly that. That case is not a
 * rendering gap; it is the C4.2 failure becoming visible, and it is the most
 * useful thing on the panel.
 */

/** How a requirement is drawn. Deliberately coarser than `RequirementStatus`. */
export type RequirementProgress =
  /** A plan step covering it has passed. */
  | "done"
  /** A plan step covering it is running or pending. */
  | "in_progress"
  /** A covering step failed or was blocked. */
  | "failed"
  /** No plan step mentions it. The runtime still holds it; the model forgot. */
  | "unplanned";

export interface RequirementRow {
  id: string;
  text: string;
  progress: RequirementProgress;
  /** The plan step this was matched to, so the join is inspectable. */
  step?: string;
  /** The error, when a covering step failed. */
  detail?: string;
  /** True for a requirement a later turn retired. Shown struck through. */
  superseded: boolean;
}

export interface ConstraintRow {
  kind: string;
  text: string;
  /** True when the runtime enforces this kind rather than only recording it. */
  enforced: boolean;
}

export interface SourceRow {
  url: string;
  status: "pending" | "attempted" | "fetched";
}

export interface RequirementsView {
  goal: string;
  disposition: TaskDisposition;
  requirements: RequirementRow[];
  constraints: ConstraintRow[];
  sources: SourceRow[];
  /** Plan steps with their own statuses, for the half the contract cannot show. */
  steps: Array<{ text: string; status: RequirementStatus }>;
  done: number;
  total: number;
  /** Failures the record still has open, in the words the tool reported them. */
  openIssues: Array<{ summary: string; detail: string; count?: number }>;
  changedFiles: string[];
}

/** Constraint kinds the tool gate actually enforces. See `actionPolicy.ts`. */
const ENFORCED = new Set(["no_execute", "no_modify", "no_research", "present_only", "must_execute"]);

/**
 * Builds the panel's view of the contract.
 *
 * Returns null when there is nothing to show — a conversation with no contract
 * yet, which is every conversation until the model's first `record_request`. An
 * empty panel section is worse than no section: it reads as "nothing is being
 * tracked" when the truth is "not yet".
 */
export function requirementsView(
  task: TaskState | null,
  contract: TaskContract,
  termination?: string,
): RequirementsView | null {
  if (contract.requirements.length === 0 && (task === null || task.requirements.length === 0)) {
    return null;
  }

  const steps = (task?.requirements ?? []).map((r) => ({ text: r.description, status: r.status }));
  const gaps = new Set(planCoverage(contract, steps.map((s) => s.text)).map((g) => g.requirementId));

  const rows: RequirementRow[] = contract.requirements.map((requirement) => {
    const superseded = requirement.lifecycle === "superseded";
    if (gaps.has(requirement.id)) {
      return { id: requirement.id, text: requirement.description, progress: "unplanned", superseded };
    }
    const covering = coveringStep(requirement.description, task);
    return {
      id: requirement.id,
      text: requirement.description,
      progress: progressOf(covering?.status),
      ...(covering === undefined ? {} : { step: covering.description }),
      ...(covering?.detail === undefined ? {} : { detail: covering.detail }),
      superseded,
    };
  });

  const active = rows.filter((r) => !r.superseded);
  const verdict = task === null ? null : assessCompletion(task);

  // The task's own disposition, corrected against the contract.
  //
  // `assessCompletion` reads the requirements the *plan* produced, so a plan
  // that omits half of what the user asked for can reach `completed` with those
  // requirements still standing and untouched. Found by writing the test below:
  // four requirements, a three-step plan covering two of them, and the task
  // reported finished.
  //
  // Corrected here rather than there, because `assessCompletion` also feeds the
  // completion claim gate and changing what "complete" means is a runtime
  // decision with its own slice. What this does is refuse to *draw* completion
  // while something the user asked for is unaccounted for — the panel says what
  // it can see, and it can see the contract.
  const settled = active.every((r) => r.progress === "done");
  const disposition = taskDisposition(task, termination);

  return {
    goal: contract.goal,
    disposition: disposition === "completed" && !settled ? "partial" : disposition,
    requirements: rows,
    constraints: contract.constraints.map((c) => ({
      kind: c.kind,
      text: c.text,
      enforced: ENFORCED.has(c.kind),
    })),
    sources: (task?.sources ?? []).map((s) => ({ url: s.url, status: s.status })),
    steps,
    done: active.filter((r) => r.progress === "done").length,
    total: active.length,
    openIssues: (verdict?.openIssues ?? []).map((i) => ({
      summary: i.summary,
      detail: i.detail,
      ...((i.count ?? 1) > 1 ? { count: i.count } : {}),
    })),
    changedFiles: task?.changedFiles ?? [],
  };
}

function progressOf(status: RequirementStatus | undefined): RequirementProgress {
  if (status === "passed" || status === "skipped") return "done";
  if (status === "failed" || status === "blocked") return "failed";
  return "in_progress";
}

/**
 * The plan step a requirement appears to be about.
 *
 * The same word overlap `planCoverage` uses, and for the same reason: two
 * lists written independently, in Korean, by two different authors. Getting it
 * wrong shows the user a requirement beside a step that is not quite its own —
 * which is why the step is displayed, so a wrong join is visible rather than
 * silently colouring a row.
 */
function coveringStep(
  description: string,
  task: TaskState | null,
): { description: string; status: RequirementStatus; detail?: string } | undefined {
  if (task === null) return undefined;
  const words = tokens(description);
  if (words.length === 0) return undefined;

  let best: { description: string; status: RequirementStatus; detail?: string } | undefined;
  let bestScore = 0;
  for (const step of task.requirements) {
    const stepWords = tokens(step.description);
    const score = words.filter((w) =>
      stepWords.some((s) => s === w || s.startsWith(w) || w.startsWith(s)),
    ).length;
    // A tie goes to the earlier step, which is the one the plan does first.
    if (score > bestScore) {
      bestScore = score;
      best = {
        description: step.description,
        status: step.status,
        ...(step.detail === undefined ? {} : { detail: step.detail }),
      };
    }
  }
  return bestScore > 0 ? best : undefined;
}

/** Two characters for CJK, three otherwise — `taskState`'s threshold. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,·/()[\]{}"'`]+/)
    .map((word) => word.replace(/[을를이가은는의에서로과와도만]$/u, ""))
    .filter((word) => (/[가-힣]/.test(word) ? word.length >= 2 : word.length >= 3));
}

/** Re-exported so the panel's message type does not reach past this seam. */
export type { TaskContract };
export { activeRequirements };
