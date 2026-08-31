import type { ProviderMessage } from "../provider/types.ts";
import type { SessionEvent } from "./sessionEvents.ts";
import type { StoredConversation } from "./conversationStore.ts";

/**
 * Which conversation is open, computed in one place from one stored chain.
 *
 * This is the arithmetic of `AgentHost.adopt`, lifted out of the host so it can
 * be tested and mutated. The host imports `vscode`, which nothing in
 * `node --test` can load, so until now the ordering rule this enforces was
 * recorded in `scripts/mutate.mjs` as a defence with no suite behind it — a
 * comment claiming a guarantee that nothing checked.
 *
 * ## The rule
 *
 * Opening a conversation, switching branch, forking and restoring a checkpoint
 * are four ways of saying "the conversation is now here". Each one that moved
 * the fields itself was a fresh chance to move some and not others, and the
 * failure that produced was specific: `applyPendingRestore` ran before the
 * fields moved, and it restores *both* halves — the messages of the conversation
 * being opened and the contract folded from `recorded`, which still held the
 * conversation being left. A live session could end up holding conversation B's
 * messages under conversation A's contract, and A's constraints would govern B's
 * first turn.
 *
 * Returning every field from one function makes that ordering structural: the
 * caller has nothing to assign out of order, because there is one object and it
 * is complete before the caller sees it.
 */
export interface AdoptedConversation {
  conversationId: string;
  /** The event chain the screen is drawn from and the contract is folded from. */
  recorded: SessionEvent[];
  /** The model's conversation, waiting for the session that will hold it. */
  pendingRestore: ProviderMessage[];
  /**
   * Empty, always.
   *
   * These hold what the *current* turn has produced and not yet persisted.
   * Carrying them across an adoption files the conversation being left under the
   * conversation being opened, which is the same halves-out-of-step failure from
   * the other direction.
   */
  pendingEvents: SessionEvent[];
  pendingDelta: ProviderMessage[];
  /**
   * The id the next turn takes.
   *
   * Counted from turns rather than from distinct event `turnId`s: a turn can end
   * with no events at all — a refusal, an interrupted run — and counting those
   * would hand the next turn an id that is already taken. Turns are never
   * removed, an orphaned branch included, so this only grows, which is what
   * keeps ids unique across forks.
   *
   * The larger of the two counts, not the graph's alone. `stored.turns?.length
   * ?? …` — which is what the host had — reads an *empty* graph as zero and
   * hands the next turn `t1` while `t1` already exists in the events.
   *
   * That state is not reachable through `conversationStore.load` today:
   * `readSession` folds a file whose graph did not survive into a single turn,
   * and returns null when there is neither a turn nor a message. So this is
   * defence in depth rather than a live bug fixed — recorded that way because
   * the two are not the same claim. What makes it worth the line is that the
   * uniqueness of a turn id should not rest on an invariant maintained in
   * another file, by a function this one never calls.
   */
  turnOrdinal: number;
  /**
   * The workspace this conversation was had in, not the window in front of you.
   *
   * A conversation resumed a week later must resolve `src/a.ts` to the file it
   * meant then.
   */
  boundRoot: string | null;
}

export function adoptConversation(stored: StoredConversation): AdoptedConversation {
  const recorded = [...(stored.events ?? [])];
  return {
    conversationId: stored.id,
    recorded,
    // Copied rather than aliased, like `recorded` beside it. The store hands
    // back an object it may still be holding, and a caller that appends to what
    // it was given would be editing the saved conversation.
    pendingRestore: [...stored.messages],
    pendingEvents: [],
    pendingDelta: [],
    turnOrdinal: Math.max(
      stored.turns?.length ?? 0,
      new Set(recorded.map((event) => event.turnId)).size,
    ),
    boundRoot: stored.workspace?.boundRoot ?? null,
  };
}
