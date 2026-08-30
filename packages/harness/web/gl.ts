// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The WebGL2 plumbing: one context, one program, one texture, and the
 * offscreen target the parity check reads back from.
 *
 * Kept apart from `main.ts` so the interesting file is about what the harness
 * shows rather than about `getUniformLocation`.
 *
 * Two rules this module enforces rather than documents:
 *
 *  - **Every uniform the shader declares must be found.** `glsl.ts` parses its
 *    own source for the list, and a name that fails to resolve is reported
 *    rather than silently ignored. A uniform that quietly went missing is a term
 *    of the model that stopped being applied, and the picture would still look
 *    like a sphere.
 *  - **The texture format is reported, not assumed.** A half-float equirect
 *    texture quantizes the content by about one part in a thousand, which is
 *    half of the GPU parity tolerance all on its own. Which format was actually
 *    obtained therefore goes on screen next to the parity number.
 */

import { FRAGMENT_SHADER, VERTEX_SHADER, glslUniformNames } from '../src/glsl.ts';
import type { Mat3x3, MeshUniforms, TextureData, Uniforms } from '../src/uniforms.ts';

export interface GlHarness {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation>;
  /** Uniform names the shader declares that the linker did not expose. */
  missingUniforms: string[];
  texture: WebGLTexture;
  /**
   * The packed model, on units 1 to 3 — nodes, triangles, footprint field.
   *
   * Allocated once and re-uploaded when the model changes, because a hierarchy
   * is megabytes and a frame is not the place to build one. `meshUploaded` is
   * what was last put in them, so a redraw of the same model costs nothing.
   */
  meshTextures: { nodes: WebGLTexture; triangles: WebGLTexture; field: WebGLTexture };
  /**
   * What is in {@link meshTextures} now, or `undefined` before anything has
   * been put there.
   *
   * THREE states, and collapsing two of them was a bug: `null` means the
   * placeholders are uploaded, `undefined` means the textures have no storage at
   * all. Started as `null`, which made `uploadMesh(h, null)` -- the ordinary
   * no-model case, and the first call every page makes -- return early and leave
   * the samplers bound to textures that were never defined. `undefined === null`
   * is false, so the guard needs no special case; the initial value carries it.
   */
  meshUploaded: MeshUniforms | null | undefined;
  /** `RGBA32F`, `RGBA16F` or `RGBA8` — whichever the device gave us. */
  textureFormat: string;
  /** True when the parity read-back can be done in float rather than 8-bit. */
  floatReadback: boolean;
  readTarget: ReadTarget | null;
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
    // Number the lines: a GLSL error names a line and the source is assembled
    // from chunks, so an unnumbered dump is unusable.
    const numbered = source
      .split('\n')
      .map((l, i) => `${String(i + 1).padStart(4)}| ${l}`)
      .join('\n');
    throw new Error(`shader compile failed:\n${log}\n\n${numbered}`);
  }
  return shader;
}

export function createHarnessGl(canvas: HTMLCanvasElement): GlHarness {
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

  // Float textures are wanted for one reason: the equirect content is linear
  // light and a half-float texture quantizes it by ~1e-3, which is half the
  // whole GPU parity budget before the renderer has done anything.
  const floatLinear = gl.getExtension('OES_texture_float_linear') !== null;
  const colorFloat = gl.getExtension('EXT_color_buffer_float') !== null;

  const texture = gl.createTexture();
  if (!texture) throw new Error('gl.createTexture returned null');
  const meshNodes = gl.createTexture();
  const meshTris = gl.createTexture();
  const meshField = gl.createTexture();
  if (!meshNodes || !meshTris || !meshField) {
    throw new Error('gl.createTexture returned null for the packed model');
  }

  const harness: GlHarness = {
    gl,
    program,
    uniforms,
    missingUniforms,
    texture,
    meshTextures: { nodes: meshNodes, triangles: meshTris, field: meshField },
    // `undefined`, not `null`: see the field. `null` is a model that IS uploaded.
    meshUploaded: undefined,
    textureFormat: floatLinear ? 'RGBA32F' : 'RGBA16F',
    floatReadback: colorFloat,
    readTarget: null,
  };
  return harness;
}

/**
 * Upload the equirect content.
 *
 * `REPEAT` on S and `CLAMP_TO_EDGE` on T, and the asymmetry is the correctness:
 * the texture is periodic in longitude and is not periodic in latitude. Wrapping
 * T folds the north pole onto the south, which on a globe dataset looks like a
 * rendering artifact rather than like the bug it is.
 *
 * `UNPACK_FLIP_Y_WEBGL` is left at its default of false so texture row 0 is the
 * data's row 0, which conventions.ts and `equirect.ts` both put at latitude +90.
 */
export function uploadEquirect(h: GlHarness, tex: TextureData): void {
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
 * Put the packed model on units 1 to 3, if it is not there already.
 *
 * `RGBA32F` and NEAREST throughout, both load-bearing. The data is coordinates
 * and indices, not colour: a half-float node bound would move a box by
 * millimetres and a filtered fetch would return the average of two triangles,
 * which is not a triangle. `texelFetch` in the shader ignores the filter, but a
 * driver still requires a complete texture with no mipmaps, and NEAREST plus
 * CLAMP_TO_EDGE is what makes it complete.
 *
 * A `null` model leaves 1x1 placeholders bound. The shader never samples them —
 * `uMeshMode` is 0 and `bvhIntersect` returns before it fetches — but a sampler
 * bound to nothing is undefined behaviour on some drivers rather than an unused
 * uniform, so they are bound anyway.
 */
export function uploadMesh(h: GlHarness, mesh: MeshUniforms | null): void {
  // Bound first, and every time. The upload below is what the identity guard
  // skips; the binding is not, because the units do not stay where they were
  // put. See `bindMesh`.
  bindMesh(h);
  if (h.meshUploaded === mesh) return;
  const gl = h.gl;
  const put = (
    unit: number,
    tex: WebGLTexture,
    data: Float32Array | null,
    width: number,
  ): void => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const w = data === null ? 1 : width;
    const height = data === null ? 1 : data.length / (4 * width);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, w, height, 0, gl.RGBA, gl.FLOAT,
      data ?? new Float32Array(4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  put(1, h.meshTextures.nodes, mesh?.nodes ?? null, mesh?.nodeWidth ?? 1);
  put(2, h.meshTextures.triangles, mesh?.triangles ?? null, mesh?.triangleWidth ?? 1);
  put(3, h.meshTextures.field, mesh?.field ?? null, mesh?.fieldWidth ?? 1);
  h.meshUploaded = mesh;
  // Unit 0 again. Every bare `bindTexture` in this file means unit 0 -- see
  // `bindContent` -- so leaving 3 selected would make the next one clobber the
  // field texture instead of the content.
  gl.activeTexture(gl.TEXTURE0);
}

/**
 * Point the mesh samplers at the mesh textures. Every frame, unlike the upload.
 *
 * Binding and uploading were one function and that was the bug. The upload is
 * skipped when the model has not changed -- a hierarchy is megabytes -- so the
 * binding was skipped with it, and the units stayed wherever the last piece of
 * ambient GL state left them. `ensureReadTarget` and `ensureVideoTarget` both
 * call `bindTexture` with no `activeTexture`, which is unit 0 when the invariant
 * holds and was unit 3 after an upload: the read-back target landed on
 * `uBvhField`, and the identity guard meant it was never displaced again. The
 * blend then sampled the framebuffer's own colour attachment for the life of the
 * model.
 *
 * `bindContent`'s docblock is about precisely this failure, one texture unit
 * over, found the same way. Binding at the point of use is the fix there and it
 * is the fix here.
 */
function bindMesh(h: GlHarness): void {
  const gl = h.gl;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, h.meshTextures.nodes);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, h.meshTextures.triangles);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, h.meshTextures.field);
  gl.activeTexture(gl.TEXTURE0);
}

function transposed(m: Mat3x3): number[] {
  // GLSL matrices are column-major; `uniforms.ts` builds row-major. Transposing
  // here rather than passing `transpose = true` keeps the call portable and
  // makes the convention visible at the point it changes.
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Push the whole uniform block. Called once per frame; it is not the bottleneck. */
export function setUniforms(h: GlHarness, u: Uniforms): void {
  bindContent(h);
  const gl = h.gl;
  const loc = (name: string): WebGLUniformLocation | null => h.uniforms.get(name) ?? null;

  gl.uniform1i(loc('uProjCount'), u.projCount);
  gl.uniform1f(loc('uRadius'), u.radius);
  gl.uniform1f(loc('uCenterHeight'), u.centerHeight);
  gl.uniform1f(loc('uRotationOffset'), u.rotationOffset);

  const n = 4;
  const lens = new Float32Array(n * 3);
  const rot = new Float32Array(n * 9);
  const intr = new Float32Array(n * 4);
  const rast = new Float32Array(n * 4);
  const limb = new Float32Array(n * 2);
  const refDistance = new Float32Array(n);
  const gamma = new Float32Array(n * 3);
  const black = new Float32Array(n * 3);
  const gain = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // Slots past the projector count are never read (every loop guards on
    // `uProjCount`), but they are filled with the last real projector rather
    // than with zeros so a driver that speculatively evaluates cannot divide by
    // a zero distance.
    const p = u.projectors[Math.min(i, u.projectors.length - 1)];
    lens.set([p.lens.x, p.lens.y, p.lens.z], i * 3);
    rot.set(transposed(p.rot), i * 9);
    intr.set(p.intrinsics, i * 4);
    rast.set(p.raster, i * 4);
    limb.set(p.limb, i * 2);
    refDistance[i] = p.refDistance;
    gamma.set([p.gamma.r, p.gamma.g, p.gamma.b], i * 3);
    black.set([p.black.r, p.black.g, p.black.b], i * 3);
    gain.set([p.gain.r, p.gain.g, p.gain.b], i * 3);
  }
  gl.uniform3fv(loc('uLens'), lens);
  gl.uniformMatrix3fv(loc('uRot'), false, rot);
  gl.uniform4fv(loc('uIntrinsics'), intr);
  gl.uniform4fv(loc('uRaster'), rast);
  gl.uniform2fv(loc('uLimb'), limb);
  gl.uniform1fv(loc('uRefDistance'), refDistance);
  gl.uniform3fv(loc('uGamma'), gamma);
  gl.uniform3fv(loc('uBlack'), black);
  gl.uniform3fv(loc('uGain'), gain);

  gl.uniform1i(loc('uRampShape'), u.rampShape);
  gl.uniform1f(loc('uWidthDeg'), u.widthDeg);
  gl.uniform1f(loc('uRampGamma'), u.rampGamma);
  gl.uniform1f(loc('uMaskLo'), u.maskLo);
  gl.uniform1f(loc('uMaskHi'), u.maskHi);
  gl.uniform1i(loc('uMaskBottomOnly'), u.maskBottomOnly);
  gl.uniform1i(loc('uMaskInterp'), u.maskInterp);

  gl.uniform3f(loc('uEncodeGamma'), u.encodeGamma.r, u.encodeGamma.g, u.encodeGamma.b);
  gl.uniform3f(loc('uReflectance'), u.reflectance.r, u.reflectance.g, u.reflectance.b);
  gl.uniform3f(loc('uAmbient'), u.ambient.r, u.ambient.g, u.ambient.b);
  gl.uniform1f(loc('uRoomAlbedo'), u.roomAlbedo);
  gl.uniform1f(loc('uSpecWeight'), u.specWeight);
  gl.uniform1f(loc('uSpecAlpha'), u.specAlpha);

  gl.uniform3f(loc('uCamPos'), u.camPos.x, u.camPos.y, u.camPos.z);
  gl.uniform3f(loc('uCamForward'), u.camForward.x, u.camForward.y, u.camForward.z);
  gl.uniform3f(loc('uCamRight'), u.camRight.x, u.camRight.y, u.camRight.z);
  gl.uniform3f(loc('uCamUp'), u.camUp.x, u.camUp.y, u.camUp.z);
  gl.uniform2f(loc('uCamHalf'), u.camHalf[0], u.camHalf[1]);

  gl.uniform1i(loc('uMode'), u.mode);
  gl.uniform1i(loc('uProjIndex'), u.projIndex);
  gl.uniform1i(loc('uDrawFloor'), u.drawFloor);
  gl.uniform1f(loc('uFloorRadius'), u.floorRadius);
  gl.uniform1f(loc('uExposure'), u.exposure);
  gl.uniform1f(loc('uDisplayGamma'), u.displayGamma);
  gl.uniform1i(loc('uEquirect'), 0);

  // The model. `uploadMesh` is a no-op when it is already there, so this costs a
  // pointer comparison on every frame that does not change models.
  uploadMesh(h, u.mesh);
  gl.uniform1i(loc('uBvhNodes'), 1);
  gl.uniform1i(loc('uBvhTris'), 2);
  gl.uniform1i(loc('uBvhField'), 3);
  gl.uniform1i(loc('uMeshMode'), u.mesh === null ? 0 : 1);
  gl.uniform1i(loc('uBvhNodeCount'), u.mesh?.nodeCount ?? 0);
  gl.uniform1i(loc('uMeshHasField'), u.mesh?.field == null ? 0 : 1);
  gl.uniform1f(loc('uMeshShadowBias'), u.meshShadowBias);
  gl.uniform1f(loc('uMeshBlendWidthM'), u.meshBlendWidthM);
}

/**
 * Bind the content texture to unit 0.
 *
 * Called from `setUniforms`, which is the one place both the on-screen draw and
 * the parity read-back pass through, and which already tells the shader the
 * content lives at unit 0. Binding there means the two statements cannot drift
 * apart. `ensureReadTarget` binds its own
 * texture while it builds the framebuffer, which clobbers whatever
 * `uploadEquirect` left bound — so the FIRST parity read-back in a fresh context
 * sampled the empty read-back texture and came back black, and every later one
 * worked because the target already existed and the allocation path was skipped.
 *
 * Found in `packages/web`, which has the same structure, where it produced a
 * runtime parity failure at exactly the moment a reader first looks at the
 * number, on 9.6% of pixels — the sphere's share of the frame — and then passed
 * forever after. It reads exactly like a model difference. It is ambient GL
 * state, and it was latent here too.
 */
function bindContent(h: GlHarness): void {
  h.gl.activeTexture(h.gl.TEXTURE0);
  h.gl.bindTexture(h.gl.TEXTURE_2D, h.texture);
}

/** The full-screen triangle. No vertex buffer — `gl_VertexID` makes the corners. */
export function drawFullScreen(h: GlHarness): void {
  h.gl.drawArrays(h.gl.TRIANGLES, 0, 3);
}

/** An offscreen target for the parity read-back. Float when the device allows it. */
export function ensureReadTarget(h: GlHarness, width: number, height: number): ReadTarget {
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
 * way up produces a large, stable, entirely fictitious delta, and on a
 * four-fold-symmetric rig it does not even look obviously wrong.
 */
export function renderAndRead(
  h: GlHarness,
  u: Uniforms,
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
