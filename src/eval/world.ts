import { createRepoFixture, type RepoFixture } from "../testing/repo-fixture.ts";
import type { CommandOutcome } from "../core/commands.ts";
import type { AgentSessionOptions } from "../agent/session.ts";
import type { WorldSpec } from "./scenario.ts";

/**
 * A world that answers the same way twice.
 *
 * Comparing two models means the only thing that differs between two runs is
 * the model. A real network does not cooperate: Hugging Face changes its
 * markup, a package index rate-limits, `pip install torch` takes four minutes
 * and then fails differently. Scores that move for those reasons are not
 * measuring anything.
 *
 * So the world is a fixture — pages, search results and command outcomes,
 * declared per scenario. What is *not* faked is everything between the model
 * and the world: the same `AgentSession`, the same tools, the same preflight,
 * the same sandbox, the same claim gate. The seams used here are the two the
 * runtime already had for testing (`fetchImpl`) or gained as one line beside it
 * (`run`), and both sit below every check they would otherwise skip.
 *
 * The workspace is real. Files are written to a temporary directory through the
 * actual sandbox, because "the model wrote a file" is a fact worth having be
 * true.
 */

export interface ControlledWorld {
  root: string;
  /** Pieces to hand to `AgentSession.open`. */
  options: Pick<AgentSessionOptions, "web" | "runCommand" | "commands">;
  /** Every command the world was asked to run, in order. */
  readonly spawned: string[];
  /** Every URL fetched, in order. */
  readonly fetched: string[];
  dispose(): Promise<void>;
}

const OK_HEADERS = { "content-type": "text/html; charset=utf-8" };

export async function createWorld(spec: WorldSpec = {}): Promise<ControlledWorld> {
  const fixture: RepoFixture = await createRepoFixture(spec.files ?? { "README.md": "# fixture\n" });
  const spawned: string[] = [];
  const fetched: string[] = [];

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    // A search goes to the engine's own endpoint; everything else is a page.
    const query = /[?&]q=([^&]*)/.exec(url)?.[1];
    if (query !== undefined) {
      const decoded = decodeURIComponent(query);
      const results =
        Object.entries(spec.search ?? {}).find(([key]) => decoded.includes(key))?.[1] ?? [];
      const blocks = results
        .map(
          (r) =>
            `<div class="result"><a class="result__a" href="${r.url}">${r.title}</a>` +
            `<a class="result__snippet">${r.snippet}</a></div>`,
        )
        .join("");
      return new Response(`<html><body>${blocks}</body></html>`, { status: 200, headers: OK_HEADERS });
    }

    fetched.push(url);
    const page = Object.entries(spec.pages ?? {}).find(([key]) => url.includes(key))?.[1];
    if (page === undefined) return new Response("", { status: 404 });
    if (page.timeout === true) {
      // What a real timeout looks like to `fetchPage`: the abort, not a status.
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { "content-type": page.contentType ?? OK_HEADERS["content-type"] },
    });
  };

  const runCommand = async (
    command: { gate: string; cmd: string; args: string[] },
  ): Promise<CommandOutcome> => {
    const line = [command.cmd, ...command.args].join(" ");
    spawned.push(line);
    const match = (spec.commands ?? []).find((c) => line.includes(c.match));
    return {
      gate: command.gate,
      cmd: command.cmd,
      args: command.args,
      // Unmatched is "no such program", which is what an unfixtured command
      // genuinely is in this world — and it is the answer that teaches a model
      // to try something else rather than to keep going.
      exitCode: match?.exitCode ?? null,
      timedOut: false,
      durationMs: 1,
      stdout: match?.stdout ?? "",
      stderr: match === undefined ? `[spawn error] spawn ${command.cmd} ENOENT` : (match.stderr ?? ""),
    };
  };

  return {
    root: fixture.root,
    options: {
      web: { enabled: true, fetchImpl, resolve: async () => [{ address: "93.184.216.34", family: 4 }] },
      runCommand: runCommand as AgentSessionOptions["runCommand"],
      commands: (spec.declared ?? [{ cmd: "node", args: ["--version"] }]).map((c) => ({
        gate: "run" as const,
        kind: "regression" as const,
        cmd: c.cmd,
        args: c.args,
        timeoutMs: 30_000,
      })),
    },
    spawned,
    fetched,
    dispose: () => fixture.dispose(),
  };
}
