/**
 * The metrics worker: a shell around `src/model.ts`.
 *
 * No logic here either — see `worker/solve.ts`. What IS here is the one thing
 * the worker owns: transferring the parity image's buffer rather than copying
 * it, so a 128×96 float render crosses the boundary without being cloned.
 */

import { computeFrames, computeModel } from '../src/model.ts';
import type { FramesRequest, ModelRequest, WorkerFailure } from '../src/protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<ModelRequest | FramesRequest>): void => {
  const req = event.data;
  try {
    // A frame on its own, for the lightbox: same renderer, no metrics, and a
    // compositor calibration the caller names rather than the one applied.
    if (req.kind === 'frames') {
      const reply = computeFrames(req);
      self.postMessage(reply, reply.frame ? [reply.frame.data.buffer] : []);
      return;
    }
    // The incoming image is adopted by the worker's cache, so its buffer must
    // NOT be transferred back — it is still in use here.
    const reply = computeModel(req);
    // Slot-indexed, so a switched-off projector leaves a hole rather than
    // shifting its neighbours. Transferring a `null` would throw.
    const transfer: ArrayBufferLike[] = reply.projectorFrames
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .map((f) => f.data.buffer);
    if (reply.parityImage) transfer.push(reply.parityImage.data.buffer);
    self.postMessage(reply, transfer);
  } catch (err) {
    // The kind of the REQUEST, not of this worker. This shell answers two
    // request kinds on one port, and labelling a failed frame render 'model'
    // sent it down the metrics path on the page: at best the lightbox waited
    // forever for a reply that had already been thrown away, and when the two
    // independent id sequences happened to agree it released the metrics
    // in-flight lock for a request that was still running.
    const failure: WorkerFailure = {
      kind: req.kind,
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(failure);
  }
};
