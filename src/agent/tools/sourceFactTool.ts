import type { AgentTool, ToolResult } from "../types.ts";
import { SOURCE_PREDICATES, verifyFact, type SourceFact, type SourceLedger } from "../sourceFacts.ts";

/**
 * Writing down what a page said, so a later sentence can be checked against it.
 *
 * A tool rather than a second model call, for the same reason `update_plan` is
 * one: the model that just read the page is the model that knows what was on
 * it, and asking a fresh one to re-read it costs a round trip to learn
 * something already in the context.
 *
 * `read` risk. It observes nothing outside what a fetch already returned and
 * changes nothing, so gating it behind approval would put a modal between the
 * agent and its own note-taking.
 */

export interface SourceFactToolOptions {
  ledger: SourceLedger;
  onFact: (fact: SourceFact) => void;
  /** Ids come from the runtime, never from the model. */
  nextId: () => string;
  now?: () => number;
}

export function createSourceFactTool(opts: SourceFactToolOptions): AgentTool {
  return {
    name: "record_source_fact",
    risk: "read",
    description:
      "Write down one thing a page you fetched actually said, so the runtime can check your final " +
      "answer against it. Call it after web_fetch, once per model, dataset or package the page " +
      "carries — with the URL you read, the name exactly as it appears there, and a short quote.\n" +
      "This is what lets you say a thing is on a service. Reading a service's page proves the page " +
      "exists; it does not record what was on it, and a claim that something is available on one " +
      "site is refused unless a fact from that site's own page backs it. Finding a model on one " +
      "site and naming another is the mistake this prevents.\n" +
      "The name and the quote are checked against the bytes that arrived, so record what is there " +
      "rather than what you expect to be.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The page you read this from. It must be one you fetched in this session.",
        },
        subject: {
          type: "string",
          description:
            "The thing the page carries, named as the page names it — 'google/vit-base', not 'the ViT model'.",
        },
        predicate: {
          type: "string",
          enum: [...SOURCE_PREDICATES],
          description:
            "listed — the service's own catalog carries it. downloadable — the page offers it for " +
            "download. mentioned — the page merely names it, which is the weakest of the three and " +
            "the right one when you are not sure.",
        },
        sourceText: {
          type: "string",
          description:
            "A short quote from the page showing it, copied exactly. Leave it out rather than " +
            "paraphrasing — an inexact quote is refused, and the fact is still recorded without one.",
        },
      },
      required: ["url", "subject", "predicate"],
      additionalProperties: false,
    },
    summarize: (args) => {
      const subject = typeof args["subject"] === "string" ? args["subject"] : "";
      const url = typeof args["url"] === "string" ? args["url"] : "";
      return subject.length === 0 ? "출처 사실을 기록합니다" : `${subject} 을(를) ${hostOf(url)} 에서 확인`;
    },
    async execute(args): Promise<ToolResult> {
      const verdict = verifyFact(
        {
          url: str(args, "url"),
          subject: str(args, "subject"),
          predicate: str(args, "predicate"),
          ...(str(args, "sourceText").length === 0 ? {} : { sourceText: str(args, "sourceText") }),
        },
        opts.ledger,
        (opts.now ?? Date.now)(),
        opts.nextId(),
      );

      if (!verdict.ok) return { ok: false, content: verdict.problem.reason };

      opts.onFact(verdict.fact);
      return {
        ok: true,
        content:
          `기록했습니다: ${verdict.fact.hostname} 에 ${verdict.fact.subject} (${verdict.fact.predicate}). ` +
          "이 출처에 대한 주장은 이제 이 기록을 근거로 확인됩니다.",
      };
    },
  };
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}
