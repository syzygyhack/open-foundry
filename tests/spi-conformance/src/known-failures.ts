/**
 * Known conformance failures, declared per registration.
 *
 * Some providers diverge from the contract on behaviour that has not yet been
 * decided or fixed. Listing a divergence keeps the provider under the suite in
 * CI while saying so, rather than leaving it unchecked. A registration opts in
 * by passing `knownFailures` to runConformanceSuite; a provider registered
 * without it, as third-party providers are, gets no exemptions. Each entry is
 * strict:
 *
 * - The test still runs. If it fails with an error matching the entry's
 *   `error` pattern, it is reported as skipped with the reason. A failure that
 *   does not match fails the test, so an unrelated regression cannot hide
 *   behind the entry.
 * - If it passes, it fails with "known failure now passes". Remove the entry,
 *   so the fix is locked in and cannot regress silently.
 * - Every entry must name exactly one collected test. A file-level afterAll
 *   checks this against the collected tree (so it holds under `-t` filters)
 *   and prints the list, so CI logs show what was exempted.
 *
 * Keys are the test's describe path below the "[Provider] SPI Conformance:
 * <Category>" suite, prefixed by the category and joined with " > ".
 */

import { afterAll, it as vitestIt, type TestContext } from 'vitest';

export interface KnownFailure {
  /** Why the provider diverges, and what is undecided or unfixed. */
  reason: string;
  /** The failure the divergence produces; any other failure is a real failure. */
  error: RegExp;
}

export type KnownFailures = Readonly<Record<string, KnownFailure>>;

/** Registrations in this test file (vitest isolates modules per file). */
const registry = new Map<string, KnownFailures>();

/** "[Name] SPI Conformance: Category" -> { provider, category } */
function parseRoot(name: string): { provider: string; category: string } | null {
  const m = /^\[(.+)\] SPI Conformance: (.+)$/s.exec(name);
  return m ? { provider: m[1]!, category: m[2]! } : null;
}

function keyOf(ctx: TestContext): { provider: string; key: string } | null {
  const names: string[] = [ctx.task.name];
  for (let s = ctx.task.suite; s; s = s.suite) {
    const root = parseRoot(s.name);
    if (root) return { provider: root.provider, key: [root.category, ...names].join(' > ') };
    names.unshift(s.name);
  }
  return null;
}

type TestBody = () => unknown | Promise<unknown>;

/**
 * Drop-in for vitest's `it` in the conformance categories: runs the body as
 * usual unless the test is a declared known failure for this registration.
 */
export function it(title: string, body: TestBody, timeout?: number): void {
  vitestIt(
    title,
    async (ctx) => {
      const id = keyOf(ctx);
      const entry = id ? registry.get(id.provider)?.[id.key] : undefined;
      if (!id || entry === undefined) {
        await body();
        return;
      }
      let failure: unknown;
      try {
        await body();
      } catch (err) {
        failure = err;
      }
      if (failure === undefined) {
        throw new Error(`Known failure now passes; remove its knownFailures entry: ${id.key}`);
      }
      const message = failure instanceof Error ? failure.message : String(failure);
      // A fresh copy, flags kept: with g or y, .test() on the declared object
      // would carry lastIndex from one match into the next.
      const pattern = new RegExp(entry.error);
      if (!pattern.test(message)) {
        throw new Error(
          `Known failure failed differently than declared (expected ${String(entry.error)}): ` +
            `${id.key}\n${message}`,
          { cause: failure },
        );
      }
      ctx.skip(`known failure: ${entry.reason}`);
    },
    timeout,
  );
}

interface TaskLike {
  name: string;
  type: string;
  tasks?: readonly TaskLike[];
}

/** How many collected tests each key names, under one provider's suites. */
function countKeys(provider: string, file: TaskLike): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (task: TaskLike, path: string[] | null): void => {
    if (path === null) {
      const root = task.type === 'suite' ? parseRoot(task.name) : null;
      const next = root && root.provider === provider ? [root.category] : null;
      for (const child of task.tasks ?? []) walk(child, next);
      return;
    }
    if (task.type === 'test') {
      const key = [...path, task.name].join(' > ');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const child of task.tasks ?? []) walk(child, [...path, task.name]);
  };
  for (const child of file.tasks ?? []) walk(child, null);
  return counts;
}

/**
 * Record a registration's known failures and check them once the file has
 * run. Called by runConformanceSuite at file scope.
 */
export function registerKnownFailures(provider: string, knownFailures: KnownFailures | undefined): void {
  const entries = knownFailures ?? {};
  const previous = registry.get(provider);
  if (previous !== undefined && (Object.keys(previous).length > 0 || Object.keys(entries).length > 0)) {
    throw new Error(
      `runConformanceSuite: "${provider}" is registered twice in one file with known failures; ` +
        'give each registration its own name.',
    );
  }
  registry.set(provider, entries);
  const keys = Object.keys(entries);
  if (keys.length === 0) return;

  // vitest 5 passes fixtures first (the argument must be destructured) and the
  // file's task tree second.
  afterAll(({}, file) => {
    const counts = countKeys(provider, file as unknown as TaskLike);
    const bad = keys
      .map((k) => [k, counts.get(k) ?? 0] as const)
      .filter(([, n]) => n !== 1)
      .map(([k, n]) => `${k} (names ${n} tests)`);
    if (bad.length > 0) {
      throw new Error(
        `knownFailures entries for ${provider} must each name exactly one test:\n  ${bad.join('\n  ')}`,
      );
    }
    // Straight to stderr: vitest's default reporter does not reliably show
    // console output from a passing file, and this list belongs in CI logs.
    process.stderr.write(
      `${provider}: ${keys.length} declared known failure(s), run and reported as skipped:\n` +
        keys.map((k) => `  - ${k}\n      ${entries[k]!.reason}`).join('\n') +
        '\n',
    );
  });
}
