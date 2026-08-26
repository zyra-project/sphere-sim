// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The experiments package's entry point — a dispatcher, and nothing else.
 *
 * ```
 * node packages/experiments/src/cli.ts 2        # Experiment 2, blend softness vs geometric tolerance
 * node packages/experiments/src/cli.ts 3        # Experiment 3, photometric sensitivity
 * node packages/experiments/src/cli.ts 4        # Experiment 4, what a room costs a calibration
 * node packages/experiments/src/cli.ts 5        # Experiment 5, image-space vs geometric segmentation
 * node packages/experiments/src/cli.ts photometry   # both of the above
 * node packages/experiments/src/cli.ts 1        # Experiment 1, the published run, ~2 h
 * node packages/experiments/src/cli.ts --list   # Experiment 1's plan and budget
 * node packages/experiments/src/cli.ts          # the same as `photometry`
 * ```
 *
 * A bare invocation used to run EXPERIMENT 1 — the two-hour solver sweep — which
 * is what `npm run experiments` maps to, while README.md promises that command
 * runs "experiments 2 and 3, each run once". The cheap thing is now the default
 * and the expensive one is asked for by name, which is already the rule this file
 * states for Experiments 4 and 5 and applies with more force to the longest of
 * the five.
 *
 * The three experiments are independent measurements with different shapes — one is
 * a two-hour solver sweep with resume, two are minute-scale photometric sweeps — so
 * each owns its own directory and its own runner, and this file only decides which
 * one was asked for.
 *
 * **A note for whoever is editing this file.** Experiment 1 lives in
 * `src/experiment1/` and Experiments 2 and 3 in `src/photometric/`. Experiment 1's
 * runner is loaded through a computed specifier so that this dispatcher keeps
 * type-checking and keeps working for the other two even while that side of the
 * package is being reorganized. If you are restoring or rewriting Experiment 1's
 * CLI, put it at `src/experiment1/cli.ts` exporting `main(argv: string[])` and this
 * dispatcher will find it — please leave the `2` / `3` / `photometry` branch intact
 * rather than replacing the file wholesale.
 */

import * as path from 'node:path';
import { main as photometricMain } from './photometric/cli.ts';

const argv = process.argv.slice(2);
const first = argv[0] ?? '';

if (first === '2' || first === '3') {
  photometricMain(first);
} else if (first === '4' || first === 'spill') {
  // Its own branch rather than joining `all`, deliberately. `all` means
  // Experiments 2 and 3, which are seconds of arithmetic; Experiment 4 is nine
  // minutes of real solves, and folding it in would change what a familiar
  // command costs without anybody asking for it.
  const { main: spillMain } = await import('./spill/cli.ts');
  spillMain();
} else if (first === '5' || first === 'segmentation') {
  // Same reasoning as Experiment 4's branch: this is 270 real solves, so it
  // stays out of `all` and has to be asked for by name.
  const { main: segMain } = await import('./segmentation/cli.ts');
  segMain();
} else if (first === 'photometry' || first === 'all' || first === '') {
  photometricMain('all');
} else {
  // Everything else is Experiment 1, including `--list` and its own flags, which
  // is why this stays a catch-all rather than becoming a `1` branch with an
  // unknown-argument error beside it.
  //
  // Computed, not literal: Experiment 1's CLI is being written by a separate effort
  // and a static import of a file that is momentarily absent would break the two
  // experiments that are finished.
  const target = new URL('./experiment1/cli.ts', import.meta.url).href;
  const loaded: { main?: (args: string[]) => void } = await import(target).catch(
    (error: unknown) => {
      console.error(
        `Experiment 1's runner is not at ${path.relative(process.cwd(), new URL(target).pathname)}.\n` +
          `Experiments 2 and 3 are available as: node packages/experiments/src/cli.ts 2|3|photometry\n` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 2;
      return {};
    },
  );
  if (typeof loaded.main === 'function') loaded.main(argv);
}
