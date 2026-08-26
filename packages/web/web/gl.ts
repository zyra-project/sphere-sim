// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * WebGL2 plumbing for the display shader: one context, one program, one content
 * texture, and the offscreen target the parity check reads back from.
 *
 * Two rules enforced rather than documented:
 *
 *  - **Every uniform the shader declares must resolve.** `glsl.ts` parses its own
 *    source for the list and a name the linker did not expose is reported on
 *    screen. A uniform that quietly went missing is a term of the model that
 *    stopped being applied — and the picture would still look like a sphere.
 *  - **The texture format is reported, not assumed.** A half-float equirect
 *    quantizes linear content by about one part in a thousand, which is a
 *    meaningful share of the parity budget before the renderer has done anything.
 *    Which format the device actually gave us goes next to the parity number.
 */

import {
  CONTENT_DECODE_FRAGMENT,
  FRAGMENT_SHADER,
  VERTEX_SHADER,
  glslUniformNames,
} from '../src/glsl.ts';
import type { DisplayUniforms, PackedRig } from '../src/uniforms.ts';

export interface DisplayGl {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
  /** Uniform names the shader declares that the linker did not expose. */
  missingUniforms: string[];
  texture: WebGLTexture;
  /** `RGBA32F` or `RGBA16F` — whichever the device gave us. */
  textureFormat: string;
  /** True when the parity read-back can be float rather than 8-bit. */
  floatReadback: boolean;
  readTarget: ReadTarget | null;
  /** The video decode pass and its frozen copy. Allocated on the first frame. */
  video: VideoTarget | null;
  /**
   * Bound as the content instead of {@link DisplayGl.texture} while set.
   *
   * The parity check needs the shader to sample the SAME bytes the CPU model was
   * handed, and with a video playing the live texture has moved on by the time
   * the worker answers. See `freezeContent`.
   */
  contentOverride: WebGLTexture | null;
}

/**
 * Everything the video path owns: the 8-bit frame as uploaded, the program that
 * turns it into linear light, the framebuffer that writes the content texture,
 * and a copy of the last frame the model was given.
 */
export interface VideoTarget {
  program: WebGLProgram;
  frameTexture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  frozen: WebGLTexture;
  width: number;
  height: number;
}

export interface ReadTarget {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
  float: boolean;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('gl.createShader returned null');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(no log)';
    // A GLSL error names a line and the source is assembled from chunks, so an
    // unnumbered dump is unusable.
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
      .join('\n');
    throw new Error(`shader compile failed:\n${log}\n\n${numbered}`);
  }
  return shader;
}

export function createDisplayGl(canvas: HTMLCanvasElement): DisplayGl {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available in this browser.');

  const program = gl.createProgram();
  if (!program) throw new Error('gl.createProgram returned null');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(program) ?? '(no log)'}`);
  }
  gl.useProgram(program);

  const uniforms = new Map<string, WebGLUniformLocation>();
  const missingUniforms: string[] = [];
  for (const name of glslUniformNames()) {
    const loc = gl.getUniformLocation(program, name);
    if (loc === null) missingUniforms.push(name);
    else uniforms.set(name, loc);
  }

  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
  const colorFloat = gl.getExtension('EXT_color_buffer_float') !== null;
  const texture = gl.createTexture();
  if (!texture) throw new Error('gl.createTexture returned null');

  return {
    gl,
    program,
    uniforms,
    missingUniforms,
    texture,
    textureFormat: floatLinear ? 'RGBA32F' : 'RGBA16F',
    floatReadback: colorFloat,
    readTarget: null,
    video: null,
    contentOverride: null,
  };
}

/**
 * The decode target for a video, sized to the frame.
 *
 * Torn down and rebuilt when the raster changes, which is once per dropped file.
 * The content texture is re-allocated at the same time: after this the equirect
 * IS the video's own raster, so a 2048-wide file is copied one texel to one
 * texel rather than resampled twice.
 */
export function ensureVideoTarget(h: DisplayGl, width: number, height: number): VideoTarget {
  const gl = h.gl;
  if (h.video && h.video.width === width && h.video.height === height) return h.video;
  if (h.video) {
    gl.deleteProgram(h.video.program);
    gl.deleteTexture(h.video.frameTexture);
    gl.deleteTexture(h.video.frozen);
    gl.deleteFramebuffer(h.video.framebuffer);
  }

  const program = gl.createProgram();
  if (!program) throw new Error('gl.createProgram returned null for the video decode pass');
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, CONTENT_DECODE_FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`video decode link failed: ${gl.getProgramInfoLog(program) ?? '(no log)'}`);
  }

  const frameTexture = gl.createTexture();
  const frozen = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  if (!frameTexture || !frozen || !framebuffer) {
    throw new Error('could not allocate the video decode target');
  }

  // The 8-bit frame, as the browser hands it over. LINEAR because a video whose
  // raster does not match the content texture is being resampled here.
  gl.bindTexture(gl.TEXTURE_2D, frameTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [
    [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
    [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
    [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
  ] as const) {
    gl.texParameteri(gl.TEXTURE_2D, k, v);
  }

  const internal = h.textureFormat === 'RGBA32F' ? gl.RGBA32F : gl.RGBA16F;
  for (const tex of [h.texture, frozen]) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, h.texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(
      `the video decode target is not renderable: 0x${status.toString(16)}. This device cannot ` +
        'render to a float texture, so a video cannot be decoded into one.',
    );
  }

  h.video = { program, frameTexture, framebuffer, frozen, width, height };
  return h.video;
}

/**
 * One video frame into the content texture, in linear light. One draw call, no
 * CPU involvement — see `CONTENT_DECODE_FRAGMENT` for why it is a pass and not a
 * sample-time decode.
 */
export function uploadVideoFrame(h: DisplayGl, frame: TexImageSource, width: number, height: number): void {
  const gl = h.gl;
  const target = ensureVideoTarget(h, width, height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, target.frameTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, target.width, target.height);
  gl.useProgram(target.program);
  const loc = gl.getUniformLocation(target.program, 'uFrame');
  if (loc) gl.uniform1i(loc, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  // The display program is what everything else assumes is current.
  gl.useProgram(h.program);
}

/**
 * Take the frame the model is going to be told about, and hold it.
 *
 * Returns the content texture's own pixels — not a re-decode of the file, the
 * actual bytes the shader has been sampling — so the CPU model and the display
 * are working from one frame rather than from two derivations of one file. The
 * same pixels are put into the frozen texture, which `withFrozenContent` binds
 * for the parity draw; without that the video would have advanced between the
 * request going out and the worker answering, and the parity number would be
 * reporting a difference of a tenth of a second rather than a disagreement
 * between two renderers.
 */
export function freezeContent(h: DisplayGl): { width: number; height: number; data: Float32Array } {
  const gl = h.gl;
  const target = h.video;
  if (!target) throw new Error('freezeContent needs a video decode target');
  const { width, height } = target;

  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  const rgba = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, rgba);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, target.frozen);
  const internal = h.textureFormat === 'RGBA32F' ? gl.RGBA32F : gl.RGBA16F;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, gl.FLOAT, rgba);

  const data = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[3 * i] = rgba[4 * i];
    data[3 * i + 1] = rgba[4 * i + 1];
    data[3 * i + 2] = rgba[4 * i + 2];
  }
  return { width, height, data };
}

/** Run `fn` with the frozen frame bound as the content. */
export function withFrozenContent(h: DisplayGl, fn: () => void): void {
  const frozen = h.video?.frozen ?? null;
  h.contentOverride = frozen;
  try {
    fn();
  } finally {
    h.contentOverride = null;
  }
}

/** Give the content texture back to the still-image path. */
export function releaseVideoTarget(h: DisplayGl): void {
  const gl = h.gl;
  if (!h.video) return;
  gl.deleteProgram(h.video.program);
  gl.deleteTexture(h.video.frameTexture);
  gl.deleteTexture(h.video.frozen);
  gl.deleteFramebuffer(h.video.framebuffer);
  h.video = null;
  h.contentOverride = null;
}

/**
 * Upload the equirect content.
 *
 * `REPEAT` on S and `CLAMP_TO_EDGE` on T, and the asymmetry is the correctness:
 * the texture is periodic in longitude and is not periodic in latitude. Wrapping
 * T folds the north pole onto the south, which looks like a rendering artifact
 * rather than like the bug it is.
 */
export function uploadEquirect(
  h: DisplayGl,
  tex: { width: number; height: number; data: Float32Array },
): void {
  const gl = h.gl;
  const n = tex.width * tex.height;
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[4 * i] = tex.data[3 * i];
    rgba[4 * i + 1] = tex.data[3 * i + 1];
    rgba[4 * i + 2] = tex.data[3 * i + 2];
    rgba[4 * i + 3] = 1;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, h.texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const internal = h.textureFormat === 'RGBA32F' ? gl.RGBA32F : gl.RGBA16F;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, tex.width, tex.height, 0, gl.RGBA, gl.FLOAT, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/**
 * Push one rig's arrays under a name prefix.
 *
 * The physical rig's uniforms are `uLens`, `uRot`, …; the compositor's are the
 * same names with a `C`. Driving both from one function is deliberate — see the
 * second rule in `src/uniforms.ts`.
 */
function setRig(h: DisplayGl, prefix: '' | 'C', rig: PackedRig): void {
  const gl = h.gl;
  const loc = (name: string): WebGLUniformLocation | null => h.uniforms.get(name) ?? null;
  gl.uniform3fv(loc(`u${prefix}Lens`), rig.lens);
  gl.uniformMatrix3fv(loc(`u${prefix}Rot`), false, rig.rot);
  gl.uniform4fv(loc(`u${prefix}Intr`), rig.intrinsics);
  gl.uniform4fv(loc(`u${prefix}Raster`), rig.raster);
  gl.uniform2fv(loc(`u${prefix}Limb`), rig.limb);
}

/** Push the whole uniform block. Once per frame; it is not the bottleneck. */
export function setUniforms(h: DisplayGl, u: DisplayUniforms): void {
  bindContent(h);
  const gl = h.gl;
  const loc = (name: string): WebGLUniformLocation | null => h.uniforms.get(name) ?? null;

  gl.uniform1i(loc('uProjCount'), u.projCount);
  gl.uniform1f(loc('uRadius'), u.physical.radiusM);
  gl.uniform1f(loc('uCenterHeight'), u.physical.centerHeightM);
  setRig(h, '', u.physical);

  gl.uniform1f(loc('uCRadius'), u.content.radiusM);
  gl.uniform1f(loc('uCRotOffset'), u.content.rotationOffsetDeg);
  setRig(h, 'C', u.content);

  // The transfer curve is the PHYSICAL projector's: it describes the lamp and
  // the panel, which do not move when the compositor's belief changes.
  gl.uniform3fv(loc('uGamma'), u.physical.gamma);
  gl.uniform3fv(loc('uBlack'), u.physical.black);
  gl.uniform3fv(loc('uGain'), u.physical.gain);

  gl.uniform1i(loc('uRampShape'), u.rampShape);
  gl.uniform1f(loc('uWidthDeg'), u.widthDeg);
  gl.uniform1f(loc('uRampGamma'), u.rampGamma);
  gl.uniform1f(loc('uMaskLo'), u.maskLo);
  gl.uniform1f(loc('uMaskHi'), u.maskHi);
  gl.uniform1i(loc('uMaskBottomOnly'), u.maskBottomOnly);
  gl.uniform1i(loc('uMaskInterp'), u.maskInterp);
  gl.uniform1i(loc('uBlendSector'), u.blendSector);

  gl.uniform3f(loc('uEncodeGamma'), u.encodeGamma[0], u.encodeGamma[1], u.encodeGamma[2]);
  gl.uniform3f(loc('uReflectance'), u.reflectance[0], u.reflectance[1], u.reflectance[2]);
  gl.uniform3f(loc('uAmbient'), u.ambient[0], u.ambient[1], u.ambient[2]);
  gl.uniform1f(loc('uRoomAlbedo'), u.roomAlbedo);

  gl.uniform3f(loc('uCamPos'), u.camPos[0], u.camPos[1], u.camPos[2]);
  gl.uniform3f(loc('uCamForward'), u.camForward[0], u.camForward[1], u.camForward[2]);
  gl.uniform3f(loc('uCamRight'), u.camRight[0], u.camRight[1], u.camRight[2]);
  gl.uniform3f(loc('uCamUp'), u.camUp[0], u.camUp[1], u.camUp[2]);
  gl.uniform2f(loc('uCamHalf'), u.camHalf[0], u.camHalf[1]);
  gl.uniform1f(loc('uCamShift'), u.camShift);

  gl.uniform1i(loc('uOverlay'), u.overlay);
  gl.uniform1f(loc('uOverlayMix'), u.overlayMix);
  gl.uniform1i(loc('uHighlight'), u.highlight);
  gl.uniform1i(loc('uDrawFloor'), u.drawFloor);
  gl.uniform1f(loc('uFloorRadius'), u.floorRadius);
  gl.uniform1i(loc('uSampleGrid'), u.sampleGrid);
  gl.uniform2f(loc('uPixelUv'), u.pixelUv[0], u.pixelUv[1]);
  gl.uniform1f(loc('uExposure'), u.exposure);
  gl.uniform1f(loc('uLift'), u.lift);
  gl.uniform1f(loc('uGridDeg'), u.gridDeg);
  gl.uniform1f(loc('uGridWidthDeg'), u.gridWidthDeg);
  gl.uniform1f(loc('uGridFeather'), u.gridFeather);
  gl.uniform1f(loc('uGridAxes'), u.gridAxes);
  gl.uniform3fv(loc('uGridColor'), u.gridColor);
  gl.uniform1f(loc('uDisplayGamma'), u.displayGamma);

  gl.uniform3fv(loc('uTint'), u.tint);
  gl.uniform1f(loc('uMarkerRadius'), u.markerRadius);
  gl.uniform1i(loc('uMarkerSelected'), u.markerSelected);
  gl.uniform1f(loc('uCeilingM'), u.ceiling);
  gl.uniform1i(loc('uRoomOn'), u.roomOn ? 1 : 0);
  gl.uniform1f(loc('uWallRadius'), u.wallRadius);
  gl.uniform1i(loc('uRailOn'), u.rail);
  gl.uniform1i(loc('uAimGuides'), u.aimGuides);

  gl.uniform1i(loc('uEquirect'), 0);
}

/**
 * Bind the content texture to unit 0.
 *
 * Called from `setUniforms`, which is the one place both the on-screen draw and
 * the parity read-back pass through, and which already tells the shader the
 * content lives at unit 0. Binding there rather than once after upload is a fix,
 * not a belt-and-braces habit. `ensureReadTarget` binds its own texture
 * to `TEXTURE_2D` while it builds the framebuffer, which silently clobbers
 * whatever `uploadEquirect` left bound. The FIRST parity read-back in a fresh
 * context therefore sampled the empty read-back texture and came back black,
 * while every later one worked because the target already existed and the
 * allocation path was skipped.
 *
 * The symptom was a parity check that failed once, hard, at exactly the moment a
 * reader would first look at it — 9.6% of pixels disagreeing, which is precisely
 * the sphere's share of the frame — and then passed forever after. It reads
 * exactly like a model difference. It was ambient GL state.
 */
function bindContent(h: DisplayGl): void {
  h.gl.activeTexture(h.gl.TEXTURE0);
  h.gl.bindTexture(h.gl.TEXTURE_2D, h.contentOverride ?? h.texture);
}

/** The full-screen triangle. No vertex buffer — `gl_VertexID` makes the corners. */
export function drawFullScreen(h: DisplayGl): void {
  h.gl.drawArrays(h.gl.TRIANGLES, 0, 3);
}

export function drawToCanvas(h: DisplayGl, u: DisplayUniforms, width: number, height: number): void {
  const gl = h.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, width, height);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  setUniforms(h, u);
  drawFullScreen(h);
}

/** An offscreen target for the parity read-back. Float when the device allows it. */
export function ensureReadTarget(h: DisplayGl, width: number, height: number): ReadTarget {
  const gl = h.gl;
  if (h.readTarget && h.readTarget.width === width && h.readTarget.height === height) {
    return h.readTarget;
  }
  if (h.readTarget) {
    gl.deleteFramebuffer(h.readTarget.framebuffer);
    gl.deleteTexture(h.readTarget.texture);
  }
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) throw new Error('could not allocate the parity read-back target');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const float = h.floatReadback;
  if (float) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`parity read-back framebuffer incomplete: 0x${status.toString(16)}`);
  }
  h.readTarget = { framebuffer: fbo, texture: tex, width, height, float };
  return h.readTarget;
}

/**
 * Render into the offscreen target and read it back, row-flipped into the
 * top-left-origin layout `packages/sim`'s `RgbImage` uses.
 *
 * The flip is the one thing that has to be right for the parity number to mean
 * anything: comparing a GPU image against a CPU image with the rows the other
 * way up produces a large, stable, entirely fictitious delta — and on a
 * four-fold-symmetric rig it does not even look obviously wrong.
 */
export function renderAndRead(
  h: DisplayGl,
  u: DisplayUniforms,
  width: number,
  height: number,
): { width: number; height: number; data: Float32Array; float: boolean } {
  const gl = h.gl;
  const target = ensureReadTarget(h, width, height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  setUniforms(h, u);
  drawFullScreen(h);

  const out = new Float32Array(width * height * 3);
  if (target.float) {
    const raw = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, raw);
    for (let row = 0; row < height; row++) {
      const src = (height - 1 - row) * width;
      for (let x = 0; x < width; x++) {
        const s = 4 * (src + x);
        const d = 3 * (row * width + x);
        out[d] = raw[s];
        out[d + 1] = raw[s + 1];
        out[d + 2] = raw[s + 2];
      }
    }
  } else {
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let row = 0; row < height; row++) {
      const src = (height - 1 - row) * width;
      for (let x = 0; x < width; x++) {
        const s = 4 * (src + x);
        const d = 3 * (row * width + x);
        out[d] = raw[s] / 255;
        out[d + 1] = raw[s + 1] / 255;
        out[d + 2] = raw[s + 2] / 255;
      }
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { width, height, data: out, float: target.float };
}
