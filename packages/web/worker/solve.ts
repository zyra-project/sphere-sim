// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The solve worker: a shell around `src/pipeline.ts`.
 *
 * There is deliberately no logic here. The pipeline it calls runs a full
 * structured-light capture and a bundle adjustment, and a calibration pipeline
 * that only exists inside a worker is a calibration pipeline nothing can check —
 * `test/solve.test.ts` runs the real thing in Node, which it can only do because
 * the arithmetic lives on the other side of this file.
 */

import { runSolve } from '../src/pipeline.ts';
import type { SolveRequest, WorkerFailure } from '../src/protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<SolveRequest>): void => {
  const req = event.data;
  try {
    self.postMessage(runSolve(req, (progress) => self.postMessage(progress)));
  } catch (err) {
    const failure: WorkerFailure = {
      kind: 'solve',
      id: req.id,
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
    self.postMessage(failure);
  }
};
