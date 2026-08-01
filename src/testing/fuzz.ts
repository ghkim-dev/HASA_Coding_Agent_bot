/**
 * Deterministic randomness for property tests.
 *
 * Two things matter for a fuzz test to be worth keeping. It has to be
 * reproducible — a failure that cannot be replayed is a failure nobody fixes —
 * and it has to be cheap enough by default that nobody is tempted to skip it.
 * So the generator is a seeded LCG rather than `Math.random`, every case
 * reports the seed that produced it, and the iteration count is a knob:
 *
 *   pnpm test                                 # bounded, seconds
 *   HASA_FUZZ_ITERATIONS=500000 pnpm test     # soak, hours
 */

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max] inclusive. */
  int(min: number, max: number): number;
  bool(p?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[];
  string(maxLength: number, alphabet?: string): string;
}

const DEFAULT_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789 _-./{}[]\":,가나다🧑‍💻\\\n\t";

/** Numerical Recipes LCG. Fast, adequate for shaping test input, reproducible. */
export function rngFor(seed: number): Rng {
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const int = (min: number, max: number): number =>
    max <= min ? min : min + Math.floor(next() * (max - min + 1));
  const rng: Rng = {
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("pick from an empty list");
      return items[int(0, items.length - 1)] as T;
    },
    shuffle: <T,>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        const a = copy[i] as T;
        copy[i] = copy[j] as T;
        copy[j] = a;
      }
      return copy;
    },
    string: (maxLength, alphabet = DEFAULT_ALPHABET): string => {
      const length = int(0, maxLength);
      let out = "";
      for (let i = 0; i < length; i += 1) out += alphabet[int(0, alphabet.length - 1)];
      return out;
    },
  };
  return rng;
}

/** How many cases a property runs. Raise it to soak; the default keeps CI fast. */
export function fuzzIterations(fallback = 300): number {
  const raw = process.env["HASA_FUZZ_ITERATIONS"];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Base seed, so a soak run can explore a different region than the last one. */
export function fuzzSeed(fallback = 0x5eed): number {
  const raw = process.env["HASA_FUZZ_SEED"];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : fallback;
}

/**
 * Runs `check` over a range of seeds, reporting the exact seed on failure.
 *
 * The seed is prepended to the failure message rather than logged, because the
 * only thing a person reading a CI failure wants is the command that reproduces
 * it locally.
 */
export function forEachSeed(check: (rng: Rng, seed: number) => void, iterations = fuzzIterations()): void {
  const base = fuzzSeed();
  for (let i = 0; i < iterations; i += 1) {
    const seed = (base + i) >>> 0;
    try {
      check(rngFor(seed), seed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const replay = `HASA_FUZZ_SEED=${seed} HASA_FUZZ_ITERATIONS=1`;
      throw new Error(`fuzz case failed (reproduce with ${replay}):\n${message}`, { cause: err });
    }
  }
}

/** Async variant. Same reporting contract. */
export async function forEachSeedAsync(
  check: (rng: Rng, seed: number) => Promise<void>,
  iterations = fuzzIterations(),
): Promise<void> {
  const base = fuzzSeed();
  for (let i = 0; i < iterations; i += 1) {
    const seed = (base + i) >>> 0;
    try {
      await check(rngFor(seed), seed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const replay = `HASA_FUZZ_SEED=${seed} HASA_FUZZ_ITERATIONS=1`;
      throw new Error(`fuzz case failed (reproduce with ${replay}):\n${message}`, { cause: err });
    }
  }
}
