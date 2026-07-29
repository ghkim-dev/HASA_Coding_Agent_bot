import type { ChatMessage } from "../protocol/index.ts";
import { GitError } from "../core/git.ts";
import { RunnerAborted, type AgentRunner, type RunnerInput, type RunnerResult } from "./types.ts";

/**
 * Patch-generation runtime — the league for models that cannot call tools.
 *
 * Phase 0 found this is not a hypothetical: `qwen2.5-coder-32b` is blocked by
 * the gateway's vLLM configuration despite being a coding model. Without this
 * runtime those models could not compete at all.
 *
 * Candidates using this runtime are never compared against agent-loop
 * candidates — that would measure runtime capability, not model quality. The
 * fairness contract refuses mixed runs.
 */

const SYSTEM_PROMPT = `You are a software engineer. You will be shown files from a repository and asked to make a change.

Reply with ONE unified diff and nothing else:
- Start each file with "--- a/<path>" and "+++ b/<path>".
- Use standard @@ hunk headers with correct line numbers.
- Paths are relative to the repository root.
- To create a file use "--- /dev/null" and "+++ b/<path>".
- Make the smallest change that satisfies the request.
- Do not wrap the diff in prose. Do not explain. Output only the diff.`;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

/** Models wrap diffs in fences despite being told not to. Unwrap rather than fail. */
export function extractPatch(raw: string): string {
  const fenced = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(raw);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.search(/^(diff --git |--- )/m);
  return start === -1 ? body : body.slice(start);
}

export class PatchGenerationRunner implements AgentRunner {
  readonly id = "patch" as const;

  async run(input: RunnerInput): Promise<RunnerResult> {
    const { spec, taskSpec, sandbox, client, log, signal, onEvent, dispatch } = input;

    const context: string[] = [];
    for (const path of taskSpec.contextFiles) {
      try {
        const contents = await sandbox.readFile(path);
        context.push(`--- FILE: ${path} ---\n${contents}`);
      } catch (err) {
        log.warn("context file unavailable", { path, error: err });
      }
    }

    const messages: ChatMessage[] = [
      { role: "system", content: taskSpec.systemPrompt ?? SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          context.length > 0 ? `## Repository files\n\n${context.join("\n\n")}` : "",
          `## Task\n\n${taskSpec.prompt}`,
          "Reply with the unified diff only.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    let tokensIn = 0;
    let tokensOut = 0;
    let summary = "";

    // One corrective retry. A patch that will not apply is usually a line-number
    // slip the model can fix when shown git's own complaint; beyond that it is
    // guessing, and a wrong patch is worse than none.
    const attempts = 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (signal.aborted) throw new RunnerAborted("cancelled");
      onEvent({ phase: "thinking", detail: `patch attempt ${attempt + 1}`, step: attempt });

      const response = await dispatch(spec.modelId, () =>
        client.chat(
          {
            model: spec.modelId,
            messages,
            temperature: spec.temperature,
            top_p: spec.topP,
            max_tokens: spec.maxOutputTokens,
          },
          { signal },
        ),
      );
      tokensIn += response.usage?.prompt_tokens ?? 0;
      tokensOut += response.usage?.completion_tokens ?? 0;

      const raw = textOf(response.choices[0]?.message?.content);
      const patch = extractPatch(raw);
      if (patch.length === 0) {
        messages.push({ role: "assistant", content: raw });
        messages.push({ role: "user", content: "That contained no diff. Reply with a unified diff only." });
        continue;
      }

      try {
        await input.applyPatch(patch);
        summary = `applied a ${patch.split("\n").length}-line patch`;
        onEvent({ phase: "done", detail: "patch applied", step: attempt });
        return { toolCalls: 0, commands: [], summary, tokensIn, tokensOut };
      } catch (err) {
        const detail = err instanceof GitError ? err.stderr.slice(0, 500) : String(err);
        log.warn("patch did not apply", { attempt: attempt + 1, detail });
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: `git apply rejected that patch:\n\n${detail}\n\nProduce a corrected unified diff. Output only the diff.`,
        });
      }
    }

    onEvent({ phase: "done", detail: "no applicable patch produced", step: attempts });
    return { toolCalls: 0, commands: [], summary: "no applicable patch produced", tokensIn, tokensOut };
  }
}
