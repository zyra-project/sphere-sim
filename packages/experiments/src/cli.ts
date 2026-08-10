/**
 * The experiments package's entry point — a dispatcher, and nothing else.
 *
 * ```
 * node packages/experiments/src/cli.ts 2        # Experiment 2, blend softness vs geometric tolerance
 * node packages/experiments/src/cli.ts 3        # Experiment 3, photometric sensitivity
 * node packages/experiments/src/cli.ts photometry   # both of the above
 * node packages/experiments/src/cli.ts --list   # Experiment 1's plan and budget
 * node packages/experiments/src/cli.ts          # Experiment 1, the published run
 * ```
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
} else if (first === 'photometry' || first === 'all') {
  photometricMain('all');
} else {
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
