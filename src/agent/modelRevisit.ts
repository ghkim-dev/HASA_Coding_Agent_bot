import { modeCanWrite } from "./modes.ts";
import type { AgentMode } from "./types.ts";

/**
 * Whether the model a session opened with may no longer be the right one.
 *
 * Lifted out of `agentHost.ts` for the reason `conversationAdoption.ts` was: the
 * host imports `vscode`, nothing in `node --test` can load it, and this is a
 * policy with an asymmetry a reader can easily get backwards.
 *
 * ## Why it is asked rather than assumed
 *
 * Re-resolving is not free. It can spend live inference requests measuring
 * candidates, so a session keeps the model it has unless one of two things says
 * otherwise.
 *
 * ## The asymmetry
 *
 * A hand-picked model is the plain case: the user chose one and the running
 * session is not using it.
 *
 * A mode change matters in **one direction only**. A model chosen for a mode
 * that writes already satisfies one that only reads, so CODE → ASK keeps what it
 * has. ASK → CODE does not: a chat-only model will accept the request and then
 * *describe* the change instead of making it — the failure `autoModel` exists to
 * prevent, and the one a reused session would walk straight into.
 *
 * Reversing those two costs nothing visible. The session keeps running, the
 * model answers, and the work simply does not happen.
 */
export interface RevisitInput {
  /** The model the user picked by hand, or null when `✨ Auto` is choosing. */
  selectedModelId: string | null;
  /** What the session actually opened with, or null when there is no session. */
  sessionChoice: { modelId: string } | null;
  /** The mode the session opened in, or null when there is no session. */
  modeAtSession: AgentMode | null;
  /** The mode now. */
  mode: AgentMode;
}

export function modelNeedsRevisiting(input: RevisitInput): boolean {
  const { selectedModelId, sessionChoice, modeAtSession, mode } = input;
  // A hand-picked model outranks everything below: if the session is not using
  // it, it is the wrong session whatever the modes are.
  if (selectedModelId !== null) return selectedModelId !== sessionChoice?.modelId;
  // No session to keep. Anything is a change from nothing.
  if (sessionChoice === null || modeAtSession === null) return true;
  if (modeAtSession === mode) return false;
  return modeCanWrite(mode) && !modeCanWrite(modeAtSession);
}
