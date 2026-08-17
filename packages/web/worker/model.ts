/**
 * The metrics worker: a shell around `src/model.ts`.
 *
 * No logic here either — see `worker/solve.ts`. What IS here is the one thing
 * the worker owns: transferring the parity image's buffer rather than copying
 * it, so a 128×96 float render crosses the boundary without being cloned.
 */

import { computeModel } from '../src/model.ts';
import type { ModelRequest, WorkerFailure } from '../src/protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<ModelRequest>): void => {
  const req = event.data;
  try {
    const reply = computeModel(req);
    const transfer: ArrayBufferLike[] = reply.projectorFrames.map((f) => f.data.buffer);
    if (reply.parityImage) transfer.push(reply.parityImage.data.buffer);
    self.postMessage(reply, transfer);
  } catch (err) {
    const failure: WorkerFailure = {
      kind: 'model',
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(failure);
  }
};
