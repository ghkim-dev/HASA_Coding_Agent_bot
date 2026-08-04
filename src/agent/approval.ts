import {
  RISK_ORDER,
  atMost,
  type ApprovalAnswer,
  type ApprovalMode,
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  type ToolRisk,
} from "./types.ts";

/**
 * Who decides whether an action happens.
 *
 * Three levels, and the interesting one is `dangerous`: no mode permits it and
 * no mode asks about it. A prompt the user can say yes to is a prompt they will
 * eventually say yes to at the wrong moment, so the answer is not a question.
 *
 * See §16 of the product brief.
 */

export interface ApprovalPolicy {
  /** Highest risk that runs without asking. */
  autoUpTo: ToolRisk | null;
  /** Highest risk the user may be asked about. Above this, nothing runs. */
  askUpTo: ToolRisk;
}

export const APPROVAL_POLICIES: Record<ApprovalMode, ApprovalPolicy> = {
  // Reading is free; anything that touches the tree or the shell is asked.
  safe: { autoUpTo: "read", askUpTo: "execute" },
  // Edits flow, commands still stop. The middle ground for someone who has
  // watched the agent work and trusts its edits but not its shell.
  balanced: { autoUpTo: "write", askUpTo: "execute" },
  // Everything short of `dangerous`, for a scratch repository or a replay.
  auto: { autoUpTo: "execute", askUpTo: "execute" },
};

export interface ApprovalManagerOptions {
  mode?: ApprovalMode;
  port: ApprovalPort;
  /**
   * Whether "always" is honoured, and for how long.
   *
   * `session` is what the panel uses: a grant given during a conversation lasts
   * until the conversation ends or the mode changes. `turn` was the original
   * behaviour and is kept for callers that want a narrower promise. `never`
   * asks every time, which is right for a headless caller that has nobody to
   * ask twice.
   */
  rememberGrants?: "never" | "turn" | "session" | boolean;
}

export class ApprovalManager {
  private mode: ApprovalMode;
  private readonly port: ApprovalPort;
  private readonly remember: "never" | "turn" | "session";
  private readonly granted = new Set<string>();

  constructor(opts: ApprovalManagerOptions) {
    this.mode = opts.mode ?? "safe";
    this.port = opts.port;
    const remember = opts.rememberGrants ?? false;
    this.remember = remember === true ? "turn" : remember === false ? "never" : remember;
  }

  get currentMode(): ApprovalMode {
    return this.mode;
  }

  /** Tools the user has said "always" to, for showing what is standing. */
  grantedTools(): string[] {
    return [...this.granted].map((key) => key.split(":")[0] ?? key);
  }

  setMode(mode: ApprovalMode): void {
    this.mode = mode;
    // A remembered grant was given under the old policy and does not carry.
    this.granted.clear();
  }

  /** Takes back every standing grant. The user's undo for "always". */
  revokeGrants(): void {
    this.granted.clear();
  }

  policy(): ApprovalPolicy {
    return APPROVAL_POLICIES[this.mode];
  }

  /** True when this tool would run without interrupting the user. */
  isAutomatic(risk: ToolRisk): boolean {
    const { autoUpTo } = this.policy();
    return autoUpTo !== null && atMost(risk, autoUpTo);
  }

  async decide(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const policy = this.policy();

    // Above every policy's ceiling. Nobody is asked, because the only safe
    // answer to "may I do something irreversible and unreviewed" is no.
    if (RISK_ORDER[request.risk] > RISK_ORDER[policy.askUpTo]) return "blocked";

    if (this.isAutomatic(request.risk)) return "auto";

    const key = `${request.toolName}:${request.risk}`;
    if (this.remember !== "never" && this.granted.has(key)) return "standing";

    const answer = await this.port.request(request);
    if (answer === false) return "denied";
    // Only an explicit "always" creates a standing grant. A plain yes is an
    // answer to this question, and quietly widening it into a policy is how a
    // user ends up having permitted something they never agreed to.
    if (answer === "always" && this.remember !== "never") this.granted.add(key);
    return "granted";
  }

  /**
   * Forgets grants that do not outlive a turn.
   *
   * Called between turns by the session. A `session` grant survives it, which is
   * the whole difference: the user said "stop asking me about this" and a fresh
   * turn is not a fresh conversation.
   */
  endTurn(): void {
    if (this.remember === "turn") this.granted.clear();
  }

  /** Test and CLI helper: forget everything remembered. */
  reset(): void {
    this.granted.clear();
  }
}

/** Approves nothing. The correct default for a headless caller. */
export const denyingApprovalPort: ApprovalPort = {
  request: async () => false,
};

/** Approves everything. Only ever appropriate in a test or a sandbox. */
export const allowingApprovalPort: ApprovalPort = {
  request: async () => true,
};

/** Records what it was asked, so a test can assert the wording. */
export function recordingApprovalPort(answer: (req: ApprovalRequest) => ApprovalAnswer): {
  port: ApprovalPort;
  requests: ApprovalRequest[];
} {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    port: {
      request: async (req) => {
        requests.push(req);
        return answer(req);
      },
    },
  };
}
