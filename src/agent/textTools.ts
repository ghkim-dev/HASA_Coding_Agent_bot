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
 * A plausible value for the example, by parameter name.
 *
 * An ellipsis was what the example used, and a model that copies the example
 * copies the ellipsis. Anything concrete is better; matching the name is better
 * still, because it also demonstrates what kind of thing the parameter wants.
 */
function placeholderFor(name: string): string {
  if (/path|file/i.test(name)) return "src/main.py";
  if (/command|cmd/i.test(name)) return "python src/main.py";
  if (/url/i.test(name)) return "https://example.com/docs";
  if (/quer|search/i.test(name)) return "blip2 image captioning example";
  if (/prompt|description/i.test(name)) return "a lion in a forest";
  if (/current|index|count|limit|seconds|number/i.test(name)) return "1";
  if (/steps|plan/i.test(name)) return "패키지를 설치한다\n예제를 실행한다";
  return "값을 여기에 씁니다";
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

  // Parameters are described, not drawn as tags.
  //
  // They used to be rendered as an empty tag pair per parameter, which made the
  // reference section the nearest tag-shaped thing in the prompt — and a model
  // copies the nearest pattern. Measured on `qwen3-coder`, which answered with
  // the skeleton and nothing in it:
  //
  //   <update_plan>\n  <steps>\n    </steps>\n  <current></current>\n</update_plan>
  //
  // A perfectly formed call carrying no information, which parsed, and which the
  // tool then had to refuse. Now the only tag-shaped text in the prompt is one
  // example with real values in it.
  const blocks = tools.map((tool) => {
    const params = describeParameters(tool);
    const lines = params.map(
      (p) => `- ${p.name}${p.required ? "" : " (optional)"} — ${p.description}`,
    );
    return [`## ${tool.name}`, tool.description, "", "Parameters:", ...lines].join("\n");
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
- Every parameter must contain a real value. An empty tag is not a call — it is a
  call that does nothing, and it will be refused.
- When you have finished and need no more tools, reply with prose and no call.

Example of the shape, with values filled in:

<${example?.name ?? "read_file"}>
${exampleParams.map((p) => `<${p.name}>${placeholderFor(p.name)}</${p.name}>`).join("\n")}
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

  // The other spelling, and it is not a mistake by the model.
  //
  // Hermes, Qwen and most open-weight tool-calling fine-tunes emit
  // `<tool_call>{"name": …, "arguments": {…}}</tool_call>` — it is what they
  // were trained on, and a prompt asking for something else competes with the
  // weights. Observed in use: a correct `record_request` with the right name and
  // valid arguments, refused as an invented tool, so no contract was recorded
  // and every action for the rest of the turn was deferred.
  //
  // Read before the "not a tool" branch and after the native spelling, so a
  // model using the documented format is unaffected.
  const envelope = chosen === null ? readJsonEnvelope(text, byName) : null;
  if (envelope !== null) {
    callCounter += 1;
    return {
      call: {
        id: `text_${callCounter}`,
        name: envelope.tool.name,
        arguments: envelope.args,
        rawArguments: JSON.stringify(envelope.args),
        argumentsValid: true,
      },
      text: strip(text, envelope, tools),
      problem: null,
    };
  }

  if (chosen === null) {
    // A model reaching for a tool that does not exist has still tried to act,
    // and telling it so is more useful than treating the attempt as an answer.
    const invented = /<([a-z][a-z0-9_]{2,})>[\s\S]*<\/\1>/i.exec(text);
    const name = invented?.[1];
    if (name !== undefined && !byName.has(name) && looksLikeToolAttempt(name)) {
      return {
        call: null,
        text: stripToolBlocks(text, tools),
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
        text: stripToolBlocks(text.slice(0, cut.start), tools),
        problem: cut.known
          ? `${cut.name} was opened but never closed — the reply ended mid-call, ` +
            "most likely at the output limit. Write the whole call again and keep the values short."
          : `"${cut.name}" is not a tool, and it was left unclosed. ` +
            `Available tools: ${[...byName.keys()].join(", ")}. Use the XML format described above.`,
      };
    }
    return { call: null, text: stripToolBlocks(text, tools), problem: null };
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

  // The other way models write a body, and the one that left a live model
  // unable to call anything at all:
  //
  //     <web_search>
  //     query: 개와 고양이 데이터셋
  //     limit: 5
  //     </web_search>
  //
  // Parameters as `key: value` lines rather than nested tags. It is what a
  // model reaches for when the example it half-remembers is YAML, and it is
  // unambiguous here because a key only counts when it names a parameter this
  // tool actually has. Read only for parameters the tags did not already
  // supply, so a well-formed call is untouched.
  if (Object.keys(args).length < Object.keys(schema.properties ?? {}).length) {
    for (const [name, value] of Object.entries(readKeyValueBody(block.body, schema.properties ?? {}))) {
      if (name in args) continue;
      const coerced = coerce(value, schema.properties?.[name]?.type);
      if (coerced !== undefined) args[name] = coerced;
    }
  }

  const missing = (schema.required ?? []).filter((name) => !(name in args));
  if (missing.length > 0) {
    return {
      call: null,
      text: strip(text, block, tools),
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
    text: strip(text, block, tools),
    problem: null,
  };
}

/**
 * Prose only: whatever the model wrote around the call.
 *
 * Every tool block goes, not just the one that was read. A reply can carry two
 * attempts — one parsed and one malformed — and removing only the parsed one
 * left the other in the answer. Seen in a live run, where a user's reply ended:
 *
 *     <web_search>
 *     query: "개와 고양이 분류를 위한 데이터셋"
 *     </web_search>
 *
 * They asked for a classifier and were handed a fragment of our own syntax.
 */
function strip(text: string, block: { start: number; end: number }, tools: readonly ToolDescriptor[] = []): string {
  const withoutCall = text.slice(0, block.start) + text.slice(block.end);
  return stripToolBlocks(withoutCall, tools).trim();
}

/**
 * Removes any remaining `<tool>…</tool>` block, closed or not.
 *
 * The sibling of `hasaModel.stripToolMarkup`, which does the same job on the
 * native path for the envelope tokens a gateway leaves behind. This one knows
 * the tool names, because on the text path the leftovers are whole calls the
 * model wrote and the parser did not take.
 */
export function stripToolBlocks(text: string, tools: readonly ToolDescriptor[]): string {
  let out = text;
  for (const name of [...tools.map((t) => t.name), ...ENVELOPE_TAGS]) {
    // Tool names are identifiers, so nothing here needs escaping; asserted
    // rather than assumed, because a name with a regex character in it would
    // otherwise build a pattern that matches something else entirely.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    out = out.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "gi"), "");
    // An unclosed one runs to the end of the reply — that is what being cut off
    // at the output limit looks like, and it is no more readable than a closed
    // one.
    out = out.replace(new RegExp(`<${name}>[\\s\\S]*$`, "i"), "");
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Parameters written as `key: value` lines inside a tool tag.
 *
 * A key starts a new value only when it names a parameter the tool declares —
 * so a colon inside a value, which is most of what a shell command or a URL
 * contains, does not split anything. Everything until the next such key belongs
 * to the value, which is what makes a multi-line body work:
 *
 *     contents: def main():
 *         print("hello")
 *
 * Surrounding quotes are dropped from a single-line value, because a model that
 * writes YAML writes `query: "…"` about half the time and the quotes are not
 * part of what it meant.
 */
function readKeyValueBody(
  body: string,
  properties: Record<string, { type?: string }>,
): Record<string, string> {
  const names = new Set(Object.keys(properties));
  const out: Record<string, string> = {};
  let current: string | null = null;
  const buffer: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    const joined = buffer.join("\n").trim();
    out[current] = joined.length > 1 && /^(["']).*\1$/s.test(joined) ? joined.slice(1, -1) : joined;
    buffer.length = 0;
  };

  for (const line of body.split("\n")) {
    const match = /^\s*[-*]?\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*:\s?(.*)$/.exec(line);
    if (match !== null && names.has(match[1] ?? "")) {
      flush();
      current = match[1] ?? null;
      buffer.push(match[2] ?? "");
      continue;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// The JSON envelope
// ---------------------------------------------------------------------------

/**
 * Wrappers open-weight models emit around a JSON tool call.
 *
 * Three spellings of one convention. `tool_call` is the Hermes/Qwen form and
 * the one seen in use; the others come from models trained on OpenAI-shaped
 * transcripts. None of them is a tool name, and treating them as invented tools
 * is what threw a perfectly good call away.
 */
const ENVELOPE_TAGS = ["tool_call", "function_call", "tool_use", "function"];

interface Envelope {
  tool: ToolDescriptor;
  args: Record<string, unknown>;
  start: number;
  end: number;
}

/**
 * Reads `<tool_call>{"name": …, "arguments": {…}}</tool_call>`.
 *
 * Strict about two things and forgiving about the rest. The name has to be a
 * tool that exists — an envelope naming something else is still a model
 * inventing a tool, and it gets the message it always got. And the body has to
 * be JSON: a half-written envelope is left to `unterminatedAttempt`, which
 * already knows how to say "the reply stopped mid-call".
 *
 * Forgiving about a fenced code block inside the envelope, and about
 * `parameters` as an alias for `arguments`, because models write both.
 */
function readJsonEnvelope(
  text: string,
  byName: ReadonlyMap<string, ToolDescriptor>,
): Envelope | null {
  for (const tag of ENVELOPE_TAGS) {
    const block = extractBlock(text, tag);
    if (block === null) continue;

    const body = block.body.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"] : "";
    const tool = byName.get(name);
    if (tool === undefined) continue;

    const raw = record["arguments"] ?? record["parameters"] ?? record["args"] ?? {};
    const args =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    return { tool, args, start: block.start, end: block.end };
  }
  return null;
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
