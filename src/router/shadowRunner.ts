import { embeddingMatcher, type EmbeddingProvider } from "./embedding.ts";
import { createHasaEmbeddingProvider } from "./hasaEmbedding.ts";
import { evaluateShadow, type SemanticShadowEvaluation } from "./shadow.ts";
import { projectTaskSemanticProfile } from "./semanticProfile.ts";
import type { ModelProfile } from "./modelProfile.ts";
import type { WorkerDecision } from "./routing.ts";
import type { TaskContract } from "../agent/turnContract.ts";

/**
 * The host's half of the shadow, extracted so it can be tested by behaviour.
 *
 * It used to live inside `AgentHost` as two private methods, which meant the
 * only thing that could check it was a regex over the source. That is a weak
 * test for a strong claim, and the claim matters: for two whole slices the
 * matcher was never passed to the recommender and every unit test passed,
 * because nothing exercised the wiring at all.
 *
 * What is left in the host is a delegation. What is here is the part with
 * behaviour worth asserting:
 *
 *   the provider and its cache are built once, not per turn
 *   the observation runs against the decision production already made
 *   nothing it returns can reach the decision
 *   a failure of any kind returns rather than throwing
 */

export interface ShadowRunnerOptions {
  /** Resolves the credential. Async because the host reads it from storage. */
  apiKey: () => Promise<string | null>;
  baseUrl: () => string;
  /** The contract to project the task's semantic half from. */
  taskContract: () => TaskContract;
  /** Injected by tests; production builds a real gateway provider. */
  createProvider?: (apiKey: string, baseUrl: string) => EmbeddingProvider;
}

export class ShadowRunner {
  private readonly options: ShadowRunnerOptions;
  /**
   * Built on first use and kept.
   *
   * The cache inside it is the only thing between this and one network round
   * trip per candidate per message. A matcher rebuilt per turn would have a
   * cache that never hits, which is the same as having no cache while looking
   * like it has one.
   */
  private matcher: ReturnType<typeof embeddingMatcher> | null = null;
  private failedToBuild = false;

  constructor(options: ShadowRunnerOptions) {
    this.options = options;
  }

  /** Drops the matcher, so a new credential does not reuse the old space. */
  reset(): void {
    this.matcher = null;
    this.failedToBuild = false;
  }

  /** Exposed so a caller can report cost without reaching into the cache. */
  get embeddingCalls(): number {
    return this.matcher?.cache.calls ?? 0;
  }

  private async ensureMatcher(): Promise<ReturnType<typeof embeddingMatcher> | null> {
    if (this.matcher !== null) return this.matcher;
    if (this.failedToBuild) return null;

    const key = await this.options.apiKey();
    if (key === null || key.trim().length === 0) {
      this.failedToBuild = true;
      return null;
    }

    const provider =
      this.options.createProvider?.(key, this.options.baseUrl()) ??
      createHasaEmbeddingProvider({ apiKey: key, baseUrl: this.options.baseUrl() });

    this.matcher = embeddingMatcher({
      provider,
      taskSemantic: () => projectTaskSemanticProfile(this.options.taskContract()),
    });
    return this.matcher;
  }

  /**
   * Observes the decision that has already been made.
   *
   * Takes the decision rather than the inputs to it, so there is no way to
   * write a version of this that recomputes and substitutes. Returns null when
   * there is nothing to observe — a carried turn ran no recommendation, and a
   * turn with no credential has no provider.
   */
  async observe(
    decision: WorkerDecision,
    profiles: readonly ModelProfile[],
    signal?: AbortSignal,
  ): Promise<SemanticShadowEvaluation | null> {
    const recommendation = decision.recommendation;
    const taskProfile = decision.taskProfile;
    // A carried or restored turn ran no recommendation, so there is nothing to
    // observe and — the point of the exercise — nothing to embed.
    if (recommendation === undefined || taskProfile === undefined) return null;

    const matcher = await this.ensureMatcher();
    if (matcher === null) return null;

    try {
      return await evaluateShadow({
        task: taskProfile,
        taskSemantic: projectTaskSemanticProfile(this.options.taskContract()),
        recommendation,
        profiles,
        matcher,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      // `evaluateShadow` is written not to throw. If it ever does, an
      // observation must still not be able to end a turn.
      return null;
    }
  }
}
