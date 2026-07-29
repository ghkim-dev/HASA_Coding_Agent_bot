import { redact, redactString } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  // stderr, so that CLI stdout stays machine-readable
  process.stderr.write(`${line}\n`);
};

/** Test hook: capture log output to assert nothing leaks. */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

function currentThreshold(): number {
  const raw = (process.env["ARENA_LOG_LEVEL"] ?? "info").toLowerCase();
  return LEVEL_ORDER[raw as LogLevel] ?? LEVEL_ORDER.info;
}

function emit(scope: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < currentThreshold()) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: redactString(msg),
  };
  if (fields) record["fields"] = redact(fields);
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record["ts"], level, scope, msg: "[unserializable log record]" });
  }
  // Belt and braces: the whole serialised line is swept once more, so a secret
  // hidden inside an unexpected shape still cannot escape.
  sink(redactString(line));
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit(scope, "debug", m, f),
    info: (m, f) => emit(scope, "info", m, f),
    warn: (m, f) => emit(scope, "warn", m, f),
    error: (m, f) => emit(scope, "error", m, f),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
