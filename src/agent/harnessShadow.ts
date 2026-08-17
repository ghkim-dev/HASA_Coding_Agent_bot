import { previewDesign } from "../design/preview.ts";
import { shadowScenarioFrom, type ShadowScenarioResult } from "../design/scenarioShadow.ts";

/**
 * The design engine watching a real turn, and changing nothing about it.
 *
 * This is the first connection between the auto-design work and the product path,
 * and it is deliberately the weakest one that produces evidence: after a turn has
 * finished, the user's own words are run through the *offline* preview — no model
 * is asked, so no call is added — mapped to an `EvalScenario`, and written to an
 * in-memory record beside the turn.
 *
 *     user request → production path (unchanged) → answer
 *                 ↘ offline design preview → shadow scenario → local record
 *
 * ## Why after, and why offline
 *
 * After, because a shadow that ran first would sit between the user and their
 * answer, and the first thing it could do wrong is add latency to every turn.
 * Offline, because the model half of the preview is the only part that could
 * reach a network, and a shadow that spends a user's quota to measure ourselves
 * has taken something from them.
 *
 * ## What it may not touch
 *
 * Model selection, harness strategy, the tool registry, approval, the tool gate,
 * whether the request runs, the loop's stop reason, the answer the user reads.
 * The shape is the guarantee: this function takes strings and returns a record.
 * It is called with the turn's result already decided and its return value is
 * appended to a list nobody reads to make a decision — `session.shadowRecords()`
 * exists for a report, and the tests assert that a run with the observer and a
 * run without it produce identical production decisions.
 *
 * ## Failure is a result
 *
 * Never throws. A shadow that could end somebody's turn would be a new failure
 * mode bought for a number nobody is acting on yet.
 */

export interface ShadowRecord {
  /** Which turn this observed. */
  turnId: string;
  /** What the production path decided, for comparison. Never influenced by us. */
  production: {
    /** The loop's own stop reason. */
    reason: string;
    /** Files the turn actually changed. Counted, not listed — see the note below. */
    changedFileCount: number;
    /** Who wrote the answer the user read. */
    summarySource: string;
  };
  /** What the design engine would have planned, and on what evidence. */
  shadow: {
    status: ShadowScenarioResult["status"];
    /**
     * Requirement provenance: turn, span, the runtime's own cut, origin.
     *
     * The `turnId` inside these is the *preview's* numbering of the conversation
     * it was handed — `t1` for the first user message — and not the session's
     * turn id above, which starts at `t0`. Two numbering schemes meeting in one
     * record is worth stating rather than leaving a reader to discover.
     */
    requirementSources: ShadowScenarioResult["requirementSources"];
    designRulesUsed: string[];
    oracleCoverage: string[];
    unresolved: ShadowScenarioResult["unresolved"];
    notMapped: ShadowScenarioResult["notMapped"];
    /** Whether the plan was runnable, and whether tools were permitted. */
    executable: boolean;
    mayExecute: boolean;
    plannedTools: string[];
  };
  /**
   * Where the two disagree, as a list of names.
   *
   * The point of the whole exercise: a turn the production path ran while the
   * design engine considered the request unexecutable is a case worth reading.
   */
  differences: string[];
  /** Set when the observation could not be made. The turn is unaffected. */
  failure?: string;
}

/** What the production path decided. Passed in, never read back out of here. */
export interface ProductionOutcome {
  reason: string;
  changedFileCount: number;
  summarySource: string;
}

/**
 * Observes one turn. Returns a record, or a record saying why it could not.
 *
 * `turns` is every user message so far, because the design engine reads a
 * conversation rather than a message: a correction only means something next to
 * what it corrects.
 *
 * Nothing is stored from the model's side of the conversation, and nothing from
 * the workspace: the record holds the user's own words, ids, rule names and
 * counts. No API key, no `Authorization` header, no response body — none of which
 * this function is even given.
 */
export async function observeHarnessShadow(input: {
  turnId: string;
  turns: readonly string[];
  production: ProductionOutcome;
}): Promise<ShadowRecord> {
  const base = (
    shadow: ShadowRecord["shadow"],
    differences: string[],
    failure?: string,
  ): ShadowRecord => ({
    turnId: input.turnId,
    production: { ...input.production },
    shadow,
    differences,
    ...(failure === undefined ? {} : { failure }),
  });

  const empty: ShadowRecord["shadow"] = {
    status: "adapter_failed",
    requirementSources: [],
    designRulesUsed: [],
    oracleCoverage: [],
    unresolved: [],
    notMapped: [],
    executable: false,
    mayExecute: false,
    plannedTools: [],
  };

  try {
    // Offline: no `propose`, so the preview never asks a model and adds no call.
    const preview = await previewDesign({ turns: input.turns });
    const mapped = shadowScenarioFrom({ id: `shadow-${input.turnId}`, preview });

    const differences: string[] = [];
    if (!preview.mayExecute && input.production.changedFileCount > 0) {
      differences.push("production_changed_files_while_design_withheld_execution");
    }
    if (!preview.executable && input.production.reason === "finished") {
      differences.push("production_finished_while_design_found_plan_unexecutable");
    }
    if (mapped.status !== "mapped") differences.push(`shadow_${mapped.status}`);
    if (mapped.unresolved.length > 0) differences.push("design_left_unresolved_items");

    return base(
      {
        status: mapped.status,
        requirementSources: mapped.requirementSources,
        designRulesUsed: mapped.designRulesUsed,
        oracleCoverage: mapped.oracleCoverage,
        unresolved: mapped.unresolved,
        notMapped: mapped.notMapped,
        executable: preview.executable,
        mayExecute: preview.mayExecute,
        plannedTools: preview.plannedTools,
      },
      differences,
    );
  } catch (err) {
    return base(empty, [], err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}
