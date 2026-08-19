/**
 * `node packages/experiments/src/spill/cli.ts`
 *
 * Runs Experiment 4 ONCE and writes its results file and figure. There is no
 * iteration here and there is not meant to be: docs/ARCHITECTURE.md, "The three
 * experiments are not the loop" — "Iterating an experiment until it says
 * something better is how a measurement becomes an advertisement." There is no
 * `--tune`, no best-of-N, and nothing that reads a previous run and changes the
 * design.
 *
 * About nine minutes: eighty solves at the bench's default preset.
 *
 * Outputs land in `experiments/` beside 2 and 3, and are COMMITTED — a
 * measurement that ran once should be in the history, and a diff on it should be
 * a visible event.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compact } from '../photometric/cli.ts';
import { renderSpillSvg } from './plot.ts';
import { runSpillExperiment } from './run.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const OUT = path.join(ROOT, 'experiments');

function write(name: string, contents: string): void {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, contents);
  console.log(`wrote ${path.relative(ROOT, file)} (${(contents.length / 1024).toFixed(1)} kB)`);
}

/** Run Experiment 4, write `experiments/experiment-4.{json,svg}`. */
export function writeExperiment4(): void {
  const result = runSpillExperiment({ onProgress: (m) => console.log(`  ${m}`) });
  write('experiment-4.json', `${JSON.stringify(compact(result), null, 1)}\n`);
  write('experiment-4.svg', `${renderSpillSvg(result)}\n`);
  console.log(`experiment 4 verdict: ${result.verdict.statement}`);
}

/** The entry point, shared with the package's top-level `cli.ts` dispatcher. */
export function main(): void {
  const started = Date.now();
  writeExperiment4();
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

// Only when invoked directly, so the dispatcher can import `main` without
// running it — the same guard `photometric/cli.ts` uses and for the same reason.
if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main();
}
