// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run experiment10` — what a photograph taken across a pattern change
 * costs a calibration: read by a counterfactual reader, and by the page's own.
 *
 * Writes `experiments/experiment-10.json`. The spec budgeted three hours in one
 * process, and the unit costs measured while this was built (a default rig 1.5 s
 * to bank, a noisy run 0.25 s, a crossing scan with its twelve pair scans 1.8 s,
 * a solve about 10 s) put it nearer four. Both were short. Summed stage by
 * stage, which is what one process would take, the third full run, the
 * counterfactual reader alone, came to about six and a half hours, and the
 * fourth, whose page column also hands every straddled position to the page's
 * own reader, to about eight (29982 s). Run as four lanes, the third took 2 h
 * 26 min from start to file, and the fourth 4 h 10 min, 28 min of that a
 * container restart. None of these times is in a results file: they are from
 * each run's own lane logs, which are not committed. Once `q0` and `bank` are
 * on disk the other five can run side by side — `pose`, `rescore` and
 * `lateness` together, since they share the solve file — then `--stage
 * assemble`. On four CPUs the re-scoring, about three and a half hours, is the
 * longest lane (lateness about two and a half, pose about an hour, gate about
 * forty minutes, decode about seventeen minutes after pose). The restart
 * stopped the two lanes still running, re-scoring and lateness; relaunched,
 * each resumed from its checkpoint.
 *
 *   node .../cli.ts                   every stage in order, resuming, then assemble
 *   node .../cli.ts --stage gate      one stage, resuming from its checkpoint
 *   node .../cli.ts --stage assemble  write the file from finished checkpoints only
 *   node .../cli.ts --quick           the plumbing (or EXP10_QUICK=1): 4 rigs at the
 *                                     reduced preset, 300 trials, no solves; about
 *                                     half an hour in one process, a quarter of an
 *                                     hour as four lanes
 *   node .../cli.ts --smoke           the solve path on one rig, a handful of solves
 *
 * Neither `--quick` nor `--smoke` ever writes the committed file. They write
 * beside their own checkpoints, under `experiments/.experiment-10-partial/`, and
 * the document they write says what it is in its first field.
 *
 * ## The stages, and what each is for
 *
 *   q0        The page's reader, as shipped: clean positions, rendered with
 *             noise, encoded to 8-bit sRGB and handed to `summarisePhoto` and
 *             `indexPhotographs`, and beside it the reader it replaced, on the
 *             same summaries. Then Q0b: the folder shapes the card itself
 *             produces (extra photographs at either end, a re-shot run), read
 *             by the counterfactual reader.
 *   bank      Every rig's clean frames once, and each camera's TWIN — the clean
 *             position through the renderer's own sensor and noise stream — whose
 *             verdicts decide what a later refusal can be blamed on.
 *   gate      The complement check's mechanism: where each run starts to be
 *             refused as the smear rises, and everything that could move that.
 *   decode    The decoder's mechanism: what a blend that passes does to a
 *             coordinate, in projector pixels and in millimetres on the sphere.
 *   pose      Designed straddles solved through `runScenario`, with twins and
 *             re-shoots, so the harm has a noise floor to be judged against.
 *   rescore   EXPERIMENT-9's photographs, replayed exactly and re-scored.
 *   lateness  The same with the emitter running late, as the page's does.
 *   assemble  The document, and the verdict sentence built from its cells.
 *
 * ## Three modules, and which of them a checkpoint answers to
 *
 * Each stage writes one JSON checkpoint per stage (and every solve one line of
 * `solves.jsonl`), and a re-run resumes from them rig by rig. A checkpoint is a
 * measurement taken by one build against one design, so each carries a schema
 * tag and a fingerprint of the design constants and the bytes of every source
 * file that decides what a stage measures (`segmentation/cli.ts`'s rule). A
 * mismatch refuses to resume rather than publish old measurements under this
 * build's provenance. `EXP10_ACCEPT_STALE=1` resumes anyway, and the document
 * then says so.
 *
 *   stages.ts    every stage, its checkpoints and its solves: inside the
 *                fingerprint, with the library it calls
 *   assemble.ts  the document and its verdict, read from finished checkpoints:
 *                outside it, so a change to the document re-assembles a
 *                finished run instead of re-measuring it
 *   cli.ts       this file: runs the one, then the other, and writes the file;
 *                outside it too, since it neither measures nor composes
 *
 * `stages.ts`'s header says why the line is drawn there and what must never
 * cross it.
 *
 * ## What this does NOT establish
 *
 * Everything is bench photometry — flat albedo, constant ambient, Gaussian shot
 * noise, one grey channel. Each cell's loud/silent split is reported twice: by
 * a COUNTERFACTUAL reader, the complement check the page's former reader ended
 * in, handed exact lit fractions (that reader refused every clean bench
 * position before its check ran, which the q0 stage keeps on record); and by
 * the page's own reader on the same photographs, the page column, where Q0
 * finds it places clean positions. The emitter is EXPERIMENT-9's perfect timer
 * except where the lateness stage says otherwise, and the lateness it sweeps
 * was measured headless, not on a display machine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble } from './assemble.ts';
import {
  FULL_PLAN,
  QUICK_PLAN,
  SMOKE_PLAN,
  STAGES,
  StaleCheckpoint,
  fileStore,
  runContext,
  runStages,
  type RunContext,
  type StageName,
} from './stages.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORK = path.join(ROOT, 'experiments', '.experiment-10-partial');
const OUT = path.join(ROOT, 'experiments', 'experiment-10.json');
/**
 * The acceptance sweep's committed record of the page's reader on every clean
 * position (`tools/reader-acceptance.ts`), which the identity I-page-twin holds
 * the page twins to. Handed to the assembly by path, like every other file it
 * reads that is not a checkpoint.
 */
const READER_ACCEPTANCE = path.join(ROOT, 'experiments', 'reader-acceptance.json');

/**
 * Every stage in order, each resuming from its checkpoint, then the document.
 * Returns null when a stage is missing, which only happens when one was asked
 * for alone; T24 runs this twice on `TEST_PLAN` and compares.
 */
export function runExperiment10(
  ctx: RunContext,
  only: StageName | null = null,
): Record<string, unknown> | null {
  runStages(ctx, only);
  if (only !== null && only !== 'assemble') return null;
  return assemble(ctx, { readerAcceptance: READER_ACCEPTANCE });
}

/**
 * The command line. Returns the exit code: 0 when every stage asked for ran
 * and any document asked for was written, 1 on a stale checkpoint or a
 * document that could not be written, 2 on an argument it does not know.
 *
 * `work` is where the checkpoints live. It is `experiments/.experiment-10-partial/`
 * unless a test hands in an empty directory. Only the checkpoints move: the
 * published plan still writes its document to `experiments/`.
 */
export function main(
  argv: readonly string[] = process.argv.slice(2),
  work: string = WORK,
): number {
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i < 0 ? null : (argv[i + 1] ?? '');
  };
  // Every argument must be one this knows, as `tessellation/cli.ts` requires.
  // Ignored instead, as it first was, a mistyped `--quick` or a `--stage=gate`
  // started the full run, which ends hours later by writing the committed file.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stage') i++;
    else if (argv[i] !== '--quick' && argv[i] !== '--smoke') {
      process.stderr.write(`experiment10: unknown argument '${argv[i]}'\n`);
      return 2;
    }
  }
  const quick = argv.includes('--quick') || process.env.EXP10_QUICK === '1';
  const smoke = argv.includes('--smoke') || process.env.EXP10_SMOKE === '1';
  const stageArg = flag('--stage');
  if (stageArg !== null && !(STAGES as readonly string[]).includes(stageArg)) {
    process.stderr.write(`--stage must be one of ${STAGES.join(', ')}; got '${stageArg}'\n`);
    return 2;
  }
  const plan = smoke ? SMOKE_PLAN : quick ? QUICK_PLAN : FULL_PLAN;
  const dir = plan.mode === 'full' ? work : path.join(work, plan.mode);
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const ctx = runContext(plan, fileStore(dir), log, process.env.EXP10_ACCEPT_STALE === '1');
  log(
    `experiment 10, ${plan.mode} plan; checkpoints in ${ctx.store.where}; ` +
      `design and measurement code ${ctx.fingerprint}`,
  );
  const t0 = Date.now();
  let doc: Record<string, unknown> | null;
  try {
    doc = runExperiment10(ctx, stageArg as StageName | null);
  } catch (e) {
    if (e instanceof StaleCheckpoint) {
      process.stderr.write(`\n${e.message}\n\n    rm -rf ${ctx.store.where}\n\n`);
      return 1;
    }
    throw e;
  }
  if (doc !== null) {
    // The committed file only from the published plan; a quick or smoke run
    // writes beside its own checkpoints, where nothing reads it as the result.
    const out = plan.mode === 'full' ? OUT : path.join(dir, `experiment-10.${plan.mode}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
    const statement = (doc.verdict as { statement: string }).statement;
    log(
      `\nexperiment 10 verdict (${plan.mode}): ${statement}\n\nwrote ${path.relative(ROOT, out)}`,
    );
  } else if (stageArg === null || stageArg === 'assemble') {
    // The document was asked for and not written, because a stage is not
    // complete on disk; the assembly has just said which. This exited 0, as a
    // single measuring stage does. A script that ran the stages side by side
    // and then assembled would carry on as if the file were new, and could
    // commit whatever experiments/experiment-10.json was already there.
    process.stderr.write('experiment10: no document was written\n');
    return 1;
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return 0;
}

// Only when invoked directly, so a test can import this module without
// running an experiment — the guard `segmentation/cli.ts` uses, for its reason.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = main();
}