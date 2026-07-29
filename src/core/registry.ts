import { readFile } from "node:fs/promises";
import {
  CapabilityMatrixSchema,
  type CapabilityMatrix,
  type Eligibility,
  type RuntimeAdapter,
} from "../protocol/index.ts";
import { checkStaleness } from "../probe/matrix.ts";

/**
 * Model registry backed by the capability matrix.
 *
 * The rule this enforces is the one Phase 0 exists to serve: a model may only
 * enter a mode whose capabilities were *measured*, not assumed. Without it, a
 * code run would happily hand a task to a model the gateway refuses to let call
 * tools, and the failure would look like the model being bad at coding.
 *
 * See docs/compatibility-matrix.md §5.
 */
export class ModelRegistry {
  private readonly matrix: CapabilityMatrix | null;

  private constructor(matrix: CapabilityMatrix | null) {
    this.matrix = matrix;
  }

  static empty(): ModelRegistry {
    return new ModelRegistry(null);
  }

  static async load(path = ".arena/capability-matrix.json"): Promise<ModelRegistry> {
    try {
      const parsed = CapabilityMatrixSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return new ModelRegistry(parsed.success ? parsed.data : null);
    } catch {
      return new ModelRegistry(null);
    }
  }

  get available(): boolean {
    return this.matrix !== null;
  }

  get probedAt(): string | null {
    return this.matrix?.probedAt ?? null;
  }

  eligibilityOf(modelId: string): Eligibility | null {
    return this.matrix?.models.find((m) => m.modelId === modelId)?.eligibility ?? null;
  }

  staleness(now: number): string[] {
    return this.matrix === null ? ["capability matrix not found"] : checkStaleness(this.matrix, { now }).reasons;
  }

  /**
   * Returns the reasons a set of candidates cannot run under a given runtime.
   *
   * An empty matrix returns no objections: refusing to run because Phase 0 was
   * never executed would be worse than running with a warning, and the probe
   * itself is what tells the user to run it.
   */
  objectionsFor(modelIds: string[], adapter: RuntimeAdapter): string[] {
    if (this.matrix === null) return [];
    const objections: string[] = [];
    for (const modelId of modelIds) {
      const eligibility = this.eligibilityOf(modelId);
      if (!eligibility) {
        objections.push(`${modelId}은(는) capability matrix에 없다 — pnpm probe를 먼저 실행하라`);
        continue;
      }
      if (adapter === "agent" && !eligibility.codingAgent) {
        objections.push(
          `${modelId}은(는) agent 런타임 자격이 없다 (${eligibility.reasons.join("; ") || "tool calling 미확인"}). ` +
            `runtimeAdapter:"patch"로 실행하거나 후보에서 제외하라`,
        );
      }
      if (adapter === "patch" && !eligibility.patchMode && !eligibility.codingAgent) {
        objections.push(`${modelId}은(는) patch 런타임 자격도 없다 (${eligibility.reasons.join("; ")})`);
      }
    }
    return objections;
  }
}
