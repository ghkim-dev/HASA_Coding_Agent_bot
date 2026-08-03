/**
 * A command line, split the way a shell would, without a shell.
 *
 * The agent is given one string — `pip install transformers torch` — because
 * that is how a person writes a command and how a model has seen ten million of
 * them. It reaches `spawn` as an argv array with `shell: false`, so nothing in
 * it is ever re-interpreted: a `;` an argument happens to contain arrives at the
 * program as a semicolon, not as a second command.
 *
 * That property is what makes accepting a free-form string safe here, and it is
 * also why the shell operators are *refused* rather than quietly passed through.
 * `pip install x && python y.py` without a shell would run `pip` with the
 * arguments `&&`, `python` and `y.py` — no error, no install, and a model that
 * cannot tell why. Saying so turns a silent wrong result into one more tool
 * call.
 */

export class UnparsableCommand extends Error {
  /** Shown to the model so it can correct itself, in English like the tools. */
  readonly guidance: string;
  constructor(guidance: string) {
    super(guidance);
    this.name = "UnparsableCommand";
    this.guidance = guidance;
  }
}

export interface ParsedCommandLine {
  cmd: string;
  args: string[];
}

/**
 * Operators that only mean anything to a shell.
 *
 * Checked outside quotes only: `git commit -m "fix > bug"` is one command with
 * an angle bracket in a message, and refusing it would be wrong.
 */
const OPERATORS: ReadonlyArray<{ token: string; guidance: string }> = [
  { token: "&&", guidance: "Run the commands one at a time, in separate calls." },
  { token: "||", guidance: "Run the commands one at a time, in separate calls." },
  { token: "|", guidance: "Pipes need a shell. Run the first command and read its output instead." },
  { token: ";", guidance: "Run the commands one at a time, in separate calls." },
  { token: ">>", guidance: "Redirection needs a shell. Write the file with the file tools instead." },
  { token: ">", guidance: "Redirection needs a shell. Write the file with the file tools instead." },
  { token: "<", guidance: "Redirection needs a shell. Pass the file as an argument instead." },
  { token: "$(", guidance: "Command substitution needs a shell. Run the inner command first." },
  { token: "`", guidance: "Command substitution needs a shell. Run the inner command first." },
];

/**
 * Splits on whitespace, honouring quotes and backslash escapes.
 *
 * Returns the tokens *and* whether each was quoted, because an operator inside
 * quotes is data and an operator outside them is a shell feature this cannot
 * provide. Losing that distinction would either refuse legitimate commit
 * messages or accept pipelines that silently do nothing.
 */
function tokenize(line: string): Array<{ text: string; quoted: boolean }> {
  const tokens: Array<{ text: string; quoted: boolean }> = [];
  let current = "";
  let quoted = false;
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === undefined) break;

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) {
        // A backslash escapes only a quote or another backslash, and only
        // inside double quotes. A POSIX shell would consume more of them, and
        // doing that here turned "C:\Program Files\app\main.py" into
        // "C:Program Filesappmain.py" — on the platform this runs on, a
        // backslash is a path separator far more often than an escape.
        i += 1;
        current += line[i];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push({ text: current, quoted });
      current = "";
      quoted = false;
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote !== null) throw new UnparsableCommand("The command has an unclosed quote.");
  if (started) tokens.push({ text: current, quoted });
  return tokens;
}

/** Splits a command line into an executable and its arguments. */
export function parseCommandLine(line: string): ParsedCommandLine {
  const trimmed = line.trim();
  if (trimmed.length === 0) throw new UnparsableCommand("No command was given.");
  if (/[\n\r]/.test(trimmed)) {
    throw new UnparsableCommand("Give one command on one line. Run several by calling the tool again.");
  }

  const tokens = tokenize(trimmed);
  for (const { text, quoted } of tokens) {
    if (quoted) continue;
    for (const { token, guidance } of OPERATORS) {
      if (text.includes(token)) {
        throw new UnparsableCommand(
          `"${token}" needs a shell, and commands here run without one. ${guidance}`,
        );
      }
    }
  }

  const [first, ...rest] = tokens;
  if (first === undefined || first.text.length === 0) throw new UnparsableCommand("No command was given.");
  return { cmd: first.text, args: rest.map((t) => t.text) };
}
