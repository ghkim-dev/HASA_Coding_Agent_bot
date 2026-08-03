import type { NormalizedToolCall } from "../provider/types.ts";

/**
 * Tool calling for models the gateway will not let call tools.
 *
 * This is not a workaround for a weak model. `qwen2.5-coder-32b` is a coding
 * model and can call tools; the deployment it sits behind was started without
 * `--tool-call-parser`, so every `tool_choice` comes back 400 — measured, see
 * docs/compatibility-matrix.md §8.3. Excluding it would mean the best coding
 * model on the key is unusable because of a flag nobody here can set.
 *
 * So the tools are described in the prompt and the calls are read back out of
 * the text, which is what Cline does when `enableNativeToolCalls` is off. XML
 * rather than JSON, and the reason is specific to a coding agent: a tool
 * argument here is usually source code, and JSON string escaping of code —
 * quotes, backslashes, newlines — is the single thing models get wrong most
 * often. Tag-delimited values carry code verbatim.
 *
 * The output is a `NormalizedToolCall`, identical to the native path, so
 * nothing above this file knows which mode it is in.
 */

/** Cline's rule, and the reason parsing is unambiguous. */
export const ONE_CALL_PER_MESSAGE = true;

/**
 * What this file needs to know about a tool.
 *
 * Exactly the fields a `ProviderTool` already carries, so the loop's own tool
 * list can be used as-is: risk, approval and previews are the host's business
 * and have no place in a prompt.
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ParsedToolCall {
  call: NormalizedToolCall | null;
  /** The model's prose, with the tool block removed. */
  text: string;
  /**
   * Set when something was clearly *meant* to be a call and was not usable.
   * Fed back to the model, which can then correct it — an unparsed call that
   * silently becomes prose looks to the user like the agent ignoring them.
   */
  problem: string | null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function describeParameters(tool: ToolDescriptor): Array<{ name: string; required: boolean; description: string }> {
  const schema = tool.parameters as {
    properties?: Record<string, { description?: string; type?: string; enum?: unknown[] }>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, spec]) => {
    const options = Array.isArray(spec.enum) ? ` One of: ${spec.enum.join(", ")}.` : "";
    return {
      name,
      required: required.has(name),
      description: `${spec.description ?? ""}${options}`.trim(),
    };
  });
}

/**
 * The section appended to the system prompt.
 *
 * Written as instructions rather than as a schema dump because that is what the
 * model is being asked to follow. The example is a real tool from the list, so
 * there is nothing to generalise from.
 */
export function renderToolInstructions(tools: readonly ToolDescriptor[]): string {
  if (tools.length === 0) return "";

  const blocks = tools.map((tool) => {
    const params = describeParameters(tool);
    const lines = params.map(
      (p) => `  <${p.name}>${p.required ? "" : "  (optional)"}</${p.name}>  ${p.description}`,
    );
    return [`## ${tool.name}`, tool.description, "", `<${tool.name}>`, ...lines, `</${tool.name}>`].join("\n");
  });

  const example = tools[0];
  const exampleParams = example === undefined ? [] : describeParameters(example).filter((p) => p.required);

  return `

# Using tools

You have no function-calling API here. You call a tool by writing it into your
reply as XML, and the result comes back in the next message.

Rules:
- One tool call per message. Write your reasoning first, then the call, then stop.
- Put each parameter in its own tag. Values are taken literally, so code goes in
  exactly as it should appear — no escaping, no quoting, no markdown fences.
- A value that spans lines starts on the line after the opening tag and ends on
  the line before the closing tag.
- Use the exact tool and parameter names below. Nothing else is a tool.
- When you have finished and need no more tools, reply with prose and no call.

Example:

<${example?.name ?? "read_file"}>
${exampleParams.map((p) => `<${p.name}>…</${p.name}>`).join("\n")}
</${example?.name ?? "read_file"}>

# Tools

${blocks.join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Finds the block for `tag`, closing at its **last** `</tag>`.
 *
 * Last rather than first because a value can legitimately contain the closing
 * tag — a patch that edits this very file would — and the outermost pairing is
 * the one that brackets the whole call.
 */
function extractBlock(text: string, tag: string): { body: string; start: number; end: number } | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.lastIndexOf(close);
  if (end === -1 || end < start + open.length) return null;
  return { body: text.slice(start + open.length, end), start, end: end + close.length };
}

/**
 * Trims the newline the format adds, and nothing else.
 *
 * Indentation inside a value is part of the value: a patch whose replacement
 * loses its leading spaces produces code that does not compile.
 */
function trimValue(raw: string): string {
  let value = raw;
  if (value.startsWith("\r\n")) value = value.slice(2);
  else if (value.startsWith("\n")) value = value.slice(1);
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  return value;
}

function coerce(value: string, type: string | undefined): unknown {
  switch (type) {
    case "number":
    case "integer": {
      const parsed = Number(value.trim());
      // An unparseable number is left out rather than passed as NaN; the tool's
      // own default is a better answer than a value that fails every comparison.
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    case "boolean": {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(normalized)) return true;
      if (["false", "no", "0"].includes(normalized)) return false;
      return undefined;
    }
    default:
      return value;
  }
}

let callCounter = 0;

/**
 * Reads a tool call out of a model's reply.
 *
 * Returns the call *and* the prose without it, so the user reads what the model
 * said rather than the markup it wrote.
 */
export function parseToolCall(text: string, tools: readonly ToolDescriptor[]): ParsedToolCall {
  const byName = new Map(tools.map((t) => [t.name, t]));

  // The earliest tool tag wins: a model that writes its reasoning first and the
  // call last must not have a tool name mentioned in prose taken as the call.
  let chosen: { tool: ToolDescriptor; block: { body: string; start: number; end: number } } | null = null;
  for (const tool of tools) {
    const block = extractBlock(text, tool.name);
    if (block === null) continue;
    if (chosen === null || block.start < chosen.block.start) chosen = { tool, block };
  }

  if (chosen === null) {
    // A model reaching for a tool that does not exist has still tried to act,
    // and telling it so is more useful than treating the attempt as an answer.
    const invented = /<([a-z][a-z0-9_]{2,})>[\s\S]*<\/\1>/i.exec(text);
    const name = invented?.[1];
    if (name !== undefined && !byName.has(name) && looksLikeToolAttempt(name)) {
      return {
        call: null,
        text,
        problem: `"${name}" is not a tool. Available tools: ${[...byName.keys()].join(", ")}.`,
      };
    }

    const cut = unterminatedAttempt(text, tools);
    if (cut !== null) {
      return {
        call: null,
        // The markup is removed rather than shown. A user who asked for a video
        // should not be handed a fragment of the agent's own syntax, which is
        // what a bare `<tool_call>` in the reply looked like.
        text: text.slice(0, cut.start).trim(),
        problem: cut.known
          ? `${cut.name} was opened but never closed — the reply ended mid-call, ` +
            "most likely at the output limit. Write the whole call again and keep the values short."
          : `"${cut.name}" is not a tool, and it was left unclosed. ` +
            `Available tools: ${[...byName.keys()].join(", ")}. Use the XML format described above.`,
      };
    }
    return { call: null, text, problem: null };
  }

  const { tool, block } = chosen;
  const args: Record<string, unknown> = {};
  const schema = tool.parameters as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };

  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    const param = extractBlock(block.body, name);
    if (param === null) continue;
    const value = coerce(trimValue(param.body), spec.type);
    if (value !== undefined) args[name] = value;
  }

  const missing = (schema.required ?? []).filter((name) => !(name in args));
  if (missing.length > 0) {
    return {
      call: null,
      text: strip(text, block),
      problem: `${tool.name} needs ${missing.map((m) => `<${m}>`).join(", ")}, which ${missing.length === 1 ? "was" : "were"} missing or empty.`,
    };
  }

  callCounter += 1;
  const raw = JSON.stringify(args);
  return {
    call: {
      id: `text_${callCounter}`,
      name: tool.name,
      arguments: args,
      rawArguments: raw,
      argumentsValid: true,
    },
    text: strip(text, block),
    problem: null,
  };
}

/** Prose only: whatever the model wrote around the call. */
function strip(text: string, block: { start: number; end: number }): string {
  return (text.slice(0, block.start) + text.slice(block.end)).trim();
}

/**
 * A call that was started and never finished.
 *
 * `extractBlock` needs both tags, so an opening tag with no closing one is
 * invisible to it: `chosen` stays null, the "invented tool" check needs a closed
 * pair and finds none, and the whole reply — markup included — is handed to the
 * user as prose. Reported from a running session, where the visible answer was a
 * bare `<tool_call>`; the model had been cut off mid-call, was told nothing, and
 * spent the following turns insisting it could not generate video.
 *
 * Both shapes are worth catching. A truncated call to a *real* tool is the
 * common one and the fix is for the model to write it again more briefly. An
 * unclosed tag that is not a tool at all is the Qwen family reaching for the
 * `<tool_call>` format it was trained on; naming it is what lets the model
 * switch to the format this prompt actually asked for.
 *
 * The earliest attempt wins, for the same reason the earliest tool tag does.
 *
 * Only a tag that *begins a line* counts. The format writes a call as a block,
 * so that is where a real one starts; a model saying "use the <read_file> tool"
 * mid-sentence is talking, not calling. Getting this wrong in the lenient
 * direction costs one correction the model can ignore. Getting it wrong in the
 * strict direction is the bug being fixed.
 */
function startsLine(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === "\n") return true;
    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }
  return true;
}

function unterminatedAttempt(
  text: string,
  tools: readonly ToolDescriptor[],
): { name: string; start: number; known: boolean } | null {
  let best: { name: string; start: number; known: boolean } | null = null;
  const consider = (name: string, start: number, known: boolean): void => {
    if (!startsLine(text, start)) return;
    if (best === null || start < best.start) best = { name, start, known };
  };

  for (const tool of tools) {
    const open = text.indexOf(`<${tool.name}>`);
    // A close *after* the open means `extractBlock` already had it, and this
    // function is only reached when it did not.
    if (open !== -1 && text.lastIndexOf(`</${tool.name}>`) < open) consider(tool.name, open, true);
  }

  const known = new Set(tools.map((t) => t.name));
  for (const match of text.matchAll(/<([a-z][a-z0-9_]{2,})>/gi)) {
    const name = match[1];
    if (name === undefined || known.has(name) || !looksLikeToolAttempt(name)) continue;
    if (text.includes(`</${name}>`)) continue;
    consider(name, match.index, false);
  }
  return best;
}

/**
 * Whether an unknown tag was a tool attempt rather than ordinary markup.
 *
 * Prose about code contains `<div>`, `<T>`, `<string>`. Treating those as failed
 * tool calls would put a correction in front of the model every time it
 * explained some HTML.
 */
function looksLikeToolAttempt(name: string): boolean {
  if (!name.includes("_")) return false;
  const HTML_LIKE = new Set(["b_", "i_"]);
  return !HTML_LIKE.has(name);
}

/**
 * Renders a call back into the XML the model wrote.
 *
 * Needed when replaying history to a gateway that cannot accept `tool_calls` on
 * an assistant message: the conversation has to read as the text it originally
 * was, or the model sees a turn it does not recognise as its own.
 */
export function renderToolCall(call: NormalizedToolCall): string {
  const args = call.arguments;
  const entries =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : [];
  const body = entries
    .map(([name, value]) => `<${name}>\n${String(value)}\n</${name}>`)
    .join("\n");
  return `<${call.name}>\n${body}\n</${call.name}>`;
}
