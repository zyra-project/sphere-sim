/**
 * `node packages/experiments/src/photometric/cli.ts [2|3|all]`
 *
 * Runs Experiment 2 and/or Experiment 3 ONCE and writes each one's results file and
 * figure. There is no iteration here and there is not meant to be:
 * docs/ARCHITECTURE.md, "The three experiments are not the loop" — "Iterating an
 * experiment until it says something better is how a measurement becomes an
 * advertisement."
 *
 * Outputs land in `experiments/` at the repo root and are COMMITTED. They are
 * deliverables rather than regenerated build artifacts, which is why they are not in
 * the `bench-results.json` family that `.gitignore` covers: a measurement that ran
 * once should be in the history, and a diff on it should be a visible event.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runExperiment2 } from './experiment2.ts';
import { runExperiment3 } from './experiment3.ts';
import { renderExperiment2Svg, renderExperiment3Svg } from './plot.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments');

/**
 * Round every number to a fixed significant width.
 *
 * Not cosmetic: a results file full of 17-digit doubles makes a diff between two runs
 * unreadable, and the last eight digits of a metric computed over a 4000-point
 * lattice are not information. Non-finite values become strings rather than `null`,
 * because `Infinity` in a threshold column means "not reached anywhere in the sweep"
 * and that is a result, not missing data.
 */
export function compact(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null;
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    if (value === 0) return 0;
    return Number(value.toPrecision(Math.abs(value) >= 1 ? 6 : 4));
  }
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = compact(v);
    return out;
  }
  return value;
}

function write(name: string, contents: string): void {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, contents);
  console.log(`wrote ${path.relative(ROOT, file)} (${(contents.length / 1024).toFixed(1)} kB)`);
}

/** Run Experiment 2, write `experiments/experiment-2.{json,svg}`. */
export function writeExperiment2(): void {
  const result = runExperiment2({ onProgress: (m) => console.log(`  ${m}`) });
  write('experiment-2.json', `${JSON.stringify(compact(result), null, 1)}\n`);
  write('experiment-2.svg', `${renderExperiment2Svg(result)}\n`);
  console.log(`experiment 2 verdict: ${result.verdict.statement}`);
}

/** Run Experiment 3, write `experiments/experiment-3.{json,svg}`. */
export function writeExperiment3(): void {
  const result = runExperiment3({ onProgress: (m) => console.log(`  ${m}`) });
  write('experiment-3.json', `${JSON.stringify(compact(result), null, 1)}\n`);
  write('experiment-3.svg', `${renderExperiment3Svg(result)}\n`);
  console.log(`experiment 3, stated ranges ranked: ${result.rankedStated.join(' > ')}`);
}

/** The entry point, shared with the package's top-level `cli.ts` dispatcher. */
export function main(which: string): void {
  const started = Date.now();
  if (which !== '2' && which !== '3' && which !== 'all') {
    console.error(`usage: node packages/experiments/src/photometric/cli.ts [2|3|all]`);
    process.exitCode = 2;
    return;
  }
  if (which === '2' || which === 'all') writeExperiment2();
  if (which === '3' || which === 'all') writeExperiment3();
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// Only when invoked directly, so `cli.ts` can import `main` without running it.
if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main(process.argv[2] ?? 'all');
}
