import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { previewDesign, type Proposer } from "./preview.ts";
import { renderAdvanced, renderJson, renderReport } from "./previewReport.ts";
import { createModelProposer } from "./modelProposer.ts";

/**
 * `pnpm design:preview`
 *
 * Shows what the design engine makes of a request, and does none of it. No file
 * is read except the turns file it is given, nothing is written, and no command
 * runs. The only outbound request is the optional one asking a model for
 * requirement candidates.
 *
 *   pnpm design:preview -- --prompt "로그인 오류를 수정하고 테스트해줘."
 *   pnpm design:preview -- --turns examples/design-preview/correction.json
 *   pnpm design:preview -- --prompt "..." --offline
 *   pnpm design:preview -- --prompt "..." --json
 *   pnpm design:preview -- --prompt "..." --advanced
 *
 * `--offline` uses only the deterministic runtime extractor and sends nothing.
 * Without it, a model is asked for candidates — and a model failure is reported
 * beside the offline result rather than replacing it, because the offline half
 * is complete on its own.
 */

interface Args {
  prompt?: string;
  turns?: string;
  offline: boolean;
  json: boolean;
  advanced: boolean;
}

function parse(argv: readonly string[]): Args {
  const args: Args = { offline: false, json: false, advanced: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--prompt" && value !== undefined) args.prompt = value;
    else if (flag === "--turns" && value !== undefined) args.turns = value;
    else if (flag === "--offline") args.offline = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--advanced") args.advanced = true;
  }
  return args;
}

const USAGE = [
  "사용법:",
  '  design:preview -- --prompt "요청 내용"',
  "  design:preview -- --turns <turns.json>",
  "",
  "옵션:",
  "  --offline    모델에 묻지 않고 요청에서 직접 읽어낼 수 있는 것만 사용",
  "  --json       기계 검증용 구조화 결과",
  "  --advanced   내부 상세 (span, 규칙 ID, finding)",
].join("\n");

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parse(argv);
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  let turns: string[];
  if (args.prompt !== undefined) {
    turns = [args.prompt];
  } else if (args.turns !== undefined) {
    const parsed = JSON.parse(await readFile(args.turns, "utf8")) as { turns?: unknown };
    if (!Array.isArray(parsed.turns) || parsed.turns.some((t) => typeof t !== "string")) {
      out(`turns 파일에 문자열 배열 turns 가 없습니다: ${args.turns}`);
      return 2;
    }
    turns = parsed.turns as string[];
  } else {
    out(USAGE);
    return 2;
  }

  let propose: Proposer | undefined;
  let setupError: string | null = null;
  if (!args.offline) {
    const apiKey = process.env["HASA_API_KEY"] ?? "";
    const baseUrl = process.env["HASA_BASE_URL"] ?? "";
    if (apiKey.trim().length === 0) {
      setupError = "HASA_API_KEY 가 없어 모델에 묻지 않았습니다.";
    } else {
      try {
        // The composition root, and the only place a credential appears.
        //
        // The provider is assembled here and handed down; the design layer gets
        // an `LlmProvider` and a permission record, never a key. Permission
        // comes from a probe run under *this* credential — never from
        // `GET /v1/models`, which answers without a key at all.
        const { createHasaProvider } = await import("../provider/hasa/createProvider.ts");
        const { readCapabilityMatrix } = await import("../provider/hasa/hasaLiveProbe.ts");
        const { fingerprint } = await import("../hasa-client/redact.ts");
        const { evidenceFromMatrix } = await import("./modelPermission.ts");

        const provider = createHasaProvider({
          apiKey,
          ...(baseUrl.length === 0 ? {} : { baseUrl }),
        });
        const keyFingerprint = fingerprint(apiKey);
        const matrix = await readCapabilityMatrix({
          path: ".arena/capability-matrix.json",
          keyFingerprint,
          baseUrl: provider.baseUrl,
        }).catch(() => null);

        propose = await createModelProposer({
          provider,
          permission: evidenceFromMatrix({ matrix, keyFingerprint, baseUrl: provider.baseUrl }),
        });
      } catch (err) {
        setupError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const result = await previewDesign({
    turns,
    ...(propose === undefined ? {} : { propose }),
  });
  if (setupError !== null && result.proposals.error === null) {
    result.proposals.error = setupError;
  }

  if (args.json) {
    out(JSON.stringify(renderJson(result), null, 2));
  } else {
    out(renderReport(result));
    if (args.advanced) {
      out("");
      out(renderAdvanced(result));
    }
  }

  // A preview never fails a build. It reports, and "not executable yet" is a
  // finding about the request rather than an error in the tool.
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err: Error) => {
      process.stderr.write(`${err.stack ?? err.message}\n`);
      process.exit(2);
    },
  );
}
