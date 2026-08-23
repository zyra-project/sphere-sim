/**
 * The PARAMETERS.md table, transcribed as data.
 *
 * Every entry carries its provenance class and, where a sweep needs one, a
 * plausible range. `rangeSource` records whether PARAMETERS.md states that range
 * or whether we inferred it — an inferred range on an ASSUME constant is an
 * assumption about an assumption, and the sensitivity experiment must say so.
 *
 * Literal values only. No arithmetic: derived quantities such as the sphere
 * radius are written out longhand with the derivation in the note.
 */

/** Provenance classes, PARAMETERS.md "How to read this". */
export type ParamClass = 'DOC' | 'CFG' | 'SOLVE' | 'ASSUME' | 'MEAS';

export interface ParamSpec {
  /** Symbol as written in PARAMETERS.md. */
  symbol: string;
  /** Human-readable name. */
  name: string;
  /** Section of PARAMETERS.md this comes from. */
  section: string;
  klass: ParamClass;
  /** Nominal value. Units per `unit`. */
  nominal: number;
  unit: string;
  /** Lower and upper end of the plausible range, for sweeps. */
  min: number;
  max: number;
  /** Whether PARAMETERS.md states the range, or we inferred it. */
  rangeSource: 'stated' | 'inferred';
  /** Whether this parameter feeds geometric metrics, photometric metrics, or both. */
  affects: 'geometry' | 'photometry' | 'both';
  note: string;
}

/**
 * Parameters that the sensitivity experiment sweeps. Keyed by a stable id so
 * results can be joined across runs.
 */
export const PARAMETER_TABLE: Record<string, ParamSpec> = {
  // ---- §1 Sphere geometry -------------------------------------------------
  D_sphere: {
    symbol: 'D_sphere',
    name: 'Sphere diameter',
    section: '§1',
    klass: 'DOC',
    nominal: 1.7272,
    unit: 'm',
    min: 1.7272,
    max: 1.7272,
    rangeSource: 'stated',
    affects: 'geometry',
    note: '68 in. Standard carbon-fibre sphere. Other sizes exist; keep configurable.',
  },
  R: {
    symbol: 'R',
    name: 'Sphere radius',
    section: '§1',
    klass: 'DOC',
    nominal: 0.8636,
    unit: 'm',
    min: 0.8636,
    max: 0.8636,
    rangeSource: 'stated',
    affects: 'geometry',
    note: 'Derived as half of D_sphere; written longhand because this package holds no arithmetic.',
  },
  h_bottom: {
    symbol: 'h_bottom',
    name: 'Floor to sphere bottom',
    section: '§1',
    klass: 'DOC',
    nominal: 1.3208,
    unit: 'm',
    min: 1.3208,
    max: 1.3208,
    rangeSource: 'stated',
    affects: 'geometry',
    note: '52 in.',
  },
  h_center: {
    symbol: 'h_center',
    name: 'Floor to sphere centre',
    section: '§1',
    klass: 'SOLVE',
    nominal: 2.1844,
    unit: 'm',
    min: 2.1590,
    max: 2.2098,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: '86 in. Range is the documented plus-or-minus one inch trial-and-error correction the alignment tips describe. Solved, not measured.',
  },
  rho_R: {
    symbol: 'ρ_R',
    name: 'Diffuse reflectance, red',
    section: '§1',
    klass: 'ASSUME',
    nominal: 0.9,
    unit: '',
    min: 0.8,
    max: 0.95,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'Matte white paint. PARAMETERS.md gives no range; §10 calls it narrower than the other three risks but says it scales every photometric result.',
  },
  rho_G: {
    symbol: 'ρ_G',
    name: 'Diffuse reflectance, green',
    section: '§1',
    klass: 'ASSUME',
    nominal: 0.9,
    unit: '',
    min: 0.8,
    max: 0.95,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'As rho_R.',
  },
  rho_B: {
    symbol: 'ρ_B',
    name: 'Diffuse reflectance, blue',
    section: '§1',
    klass: 'ASSUME',
    nominal: 0.88,
    unit: '',
    min: 0.78,
    max: 0.95,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'Slight blue falloff assumed; white paints commonly are not spectrally flat. Unpublished.',
  },
  rho_spec: {
    symbol: 'ρ_spec',
    name: 'Specular lobe weight',
    section: '§1',
    klass: 'ASSUME',
    nominal: 0.03,
    unit: '',
    min: 0.0,
    max: 0.08,
    rangeSource: 'stated',
    affects: 'photometry',
    note: 'PARAMETERS.md explicitly says to set it to 0 to test sensitivity, which fixes the low end.',
  },
  alpha_spec: {
    symbol: 'α_spec',
    name: 'Specular roughness (GGX)',
    section: '§1',
    klass: 'ASSUME',
    nominal: 0.4,
    unit: '',
    min: 0.2,
    max: 0.7,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'Broad, dim lobe. PARAMETERS.md calls the nominal a pure guess and gives no range.',
  },
  theta_rot: {
    symbol: 'θ_rot',
    name: 'Sphere rotation vs prime meridian',
    section: '§1',
    klass: 'CFG',
    nominal: 0.0,
    unit: 'deg',
    min: -180.0,
    max: 180.0,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: 'Sites rotate the sphere mechanically. Known per install.',
  },
  occl_top: {
    symbol: 'occl_top',
    name: 'Suspension hardware occlusion',
    section: '§1',
    klass: 'ASSUME',
    nominal: 6.0,
    unit: 'deg',
    min: 0.0,
    max: 12.0,
    rangeSource: 'inferred',
    affects: 'both',
    note: 'North polar cap obstructed by the mount. Explains why SOS masks only the bottom.',
  },

  // ---- §2 Projector placement --------------------------------------------
  d_proj: {
    symbol: 'd_proj',
    name: 'Sphere centre to lens distance',
    section: '§2',
    klass: 'SOLVE',
    nominal: 5.18,
    unit: 'm',
    min: 5.0,
    max: 6.5,
    rangeSource: 'stated',
    affects: 'geometry',
    note: 'CONFLICTED. Alignment manual says about 17 ft (5.18 m); floor plan implies 5.50-6.14 m. Wide prior 5.0-6.5 m, settle with a tape measure.',
  },
  h_proj: {
    symbol: 'h_proj',
    name: 'Projector height above floor',
    section: '§2',
    klass: 'SOLVE',
    nominal: 2.1844,
    unit: 'm',
    min: 1.8,
    max: 3.0,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: 'Documentation says projectors are generally at the same 7 ft 2 in as the equator.',
  },
  phi_jitter: {
    symbol: 'φ_i',
    name: 'Azimuth mount tolerance',
    section: '§2',
    klass: 'SOLVE',
    nominal: 0.0,
    unit: 'deg',
    min: -2.0,
    max: 2.0,
    rangeSource: 'stated',
    affects: 'geometry',
    note: 'Real mounts hold plus or minus 1-2 degrees about the nominal 0/90/180/270.',
  },

  // ---- §3 Optics and transfer --------------------------------------------
  T_throw: {
    symbol: 'T',
    name: 'Throw ratio',
    section: '§3.1',
    klass: 'CFG',
    nominal: 3.0,
    unit: ':1',
    min: 2.5,
    max: 3.5,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: 'Long-throw lens. See docs/AMENDMENTS.md A-01: which raster dimension the sphere diameter matches is not stated, and the two readings differ materially.',
  },
  gamma_R: {
    symbol: 'γ_R',
    name: 'Transfer exponent, red',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 2.2,
    unit: '',
    min: 1.9,
    max: 2.5,
    rangeSource: 'stated',
    affects: 'photometry',
    note: 'Real projectors diverge 0.1-0.3 between channels. Twelve values across the rig.',
  },
  gamma_G: {
    symbol: 'γ_G',
    name: 'Transfer exponent, green',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 2.2,
    unit: '',
    min: 1.9,
    max: 2.5,
    rangeSource: 'stated',
    affects: 'photometry',
    note: 'As gamma_R.',
  },
  gamma_B: {
    symbol: 'γ_B',
    name: 'Transfer exponent, blue',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 2.2,
    unit: '',
    min: 1.9,
    max: 2.5,
    rangeSource: 'stated',
    affects: 'photometry',
    note: 'As gamma_R. PARAMETERS.md §10 ranks per-channel gamma divergence the single highest photometric risk.',
  },
  L_black_R: {
    symbol: 'L_black_R',
    name: 'Black floor, red',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 0.00125,
    unit: 'fraction',
    min: 0.0005,
    max: 0.003333,
    rangeSource: 'stated',
    affects: 'photometry',
    note: '1/800 nominal, plausible range 1/2000 to 1/300. Spans roughly 6x.',
  },
  L_black_G: {
    symbol: 'L_black_G',
    name: 'Black floor, green',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 0.00125,
    unit: 'fraction',
    min: 0.0005,
    max: 0.003333,
    rangeSource: 'stated',
    affects: 'photometry',
    note: 'As L_black_R.',
  },
  L_black_B: {
    symbol: 'L_black_B',
    name: 'Black floor, blue',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 0.00125,
    unit: 'fraction',
    min: 0.0005,
    max: 0.003333,
    rangeSource: 'stated',
    affects: 'photometry',
    note: 'DLP and LCD leak differently per channel; the uplift in overlaps is tinted, usually blue-gray.',
  },
  g_R: {
    symbol: 'g_R',
    name: 'Channel gain, red',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 1.0,
    unit: '',
    min: 0.85,
    max: 1.15,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'Lamp aging diverges between projectors. Four lamps at different hour counts give four different white points.',
  },
  g_G: {
    symbol: 'g_G',
    name: 'Channel gain, green',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 1.0,
    unit: '',
    min: 0.85,
    max: 1.15,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'As g_R.',
  },
  g_B: {
    symbol: 'g_B',
    name: 'Channel gain, blue',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 1.0,
    unit: '',
    min: 0.85,
    max: 1.15,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'As g_R.',
  },
  wp: {
    symbol: 'wp_i',
    name: 'White point',
    section: '§3.2',
    klass: 'ASSUME',
    nominal: 6500.0,
    unit: 'K',
    min: 5500.0,
    max: 7500.0,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'Derived from gain; tracked separately for reporting.',
  },

  // ---- §4 Blending and masking -------------------------------------------
  w_width: {
    symbol: 'w_width',
    name: 'Blend region angular width',
    section: '§4.5',
    klass: 'ASSUME',
    nominal: 20.0,
    unit: 'deg',
    min: 5.0,
    max: 40.0,
    rangeSource: 'inferred',
    affects: 'both',
    note: 'Derived from seam geometry in PARAMETERS.md; shape and width both unpublished. Experiment 2 sweeps this against registration error.',
  },
  gamma_blend: {
    symbol: 'γ_blend',
    name: 'Blend ramp exponent',
    section: '§4.5',
    klass: 'DOC',
    nominal: 0.8,
    unit: '',
    min: 0.5,
    max: 1.5,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'From the SOS config. One global scalar for four projectors and three channels; cannot correct a chromatic seam.',
  },
  mask_lo: {
    symbol: 'mask_lo',
    name: 'Polar mask onset',
    section: '§4.5',
    klass: 'DOC',
    nominal: 60.0,
    unit: 'deg lat',
    min: 50.0,
    max: 70.0,
    rangeSource: 'inferred',
    affects: 'both',
    note: 'From `set bottommask 60,70`. Latitude units INFERRED, not published. Matches the seam-direction usable limit of about 59 deg.',
  },
  mask_hi: {
    symbol: 'mask_hi',
    name: 'Polar mask full',
    section: '§4.5',
    klass: 'DOC',
    nominal: 70.0,
    unit: 'deg lat',
    min: 60.0,
    max: 80.0,
    rangeSource: 'inferred',
    affects: 'both',
    note: 'As mask_lo. Ten-degree feather to full mask.',
  },

  // ---- §5 Room environment ------------------------------------------------
  E_amb: {
    symbol: 'E_amb',
    name: 'Ambient luminance on sphere',
    section: '§5',
    klass: 'ASSUME',
    nominal: 0.04,
    unit: 'relative',
    min: 0.01,
    max: 0.15,
    rangeSource: 'stated',
    affects: 'photometry',
    note: 'NOAA note that ambient and direct light throw off their CV, and that their own lighting control is unusually good, implying typical sites are worse.',
  },
  E_amb_chroma: {
    symbol: 'E_amb_chroma',
    name: 'Ambient colour temperature',
    section: '§5',
    klass: 'ASSUME',
    nominal: 4000.0,
    unit: 'K',
    min: 2700.0,
    max: 6500.0,
    rangeSource: 'inferred',
    affects: 'photometry',
    note: 'Exhibit lighting is rarely daylight-balanced. Tints the whole sphere and shifts every deltaE.',
  },
  r_wall: {
    symbol: 'r_wall',
    name: 'Sphere axis to the wall',
    section: '§5',
    klass: 'ASSUME',
    nominal: 6.0,
    unit: 'm',
    min: 4.0,
    max: 9.0,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: 'The room the structured-light pattern lands on when roomSpill is enabled. Nobody has measured a building. The range is the one experiment 4 swept, which is a sweep and not a survey of galleries. Had no entry here, and no row in PARAMETERS.md, until the room became switchable: it lived only as a literal in packages/bench/src/capture.ts.',
  },
  h_ceiling: {
    symbol: 'h_ceiling',
    name: 'Floor to ceiling',
    section: '§5',
    klass: 'ASSUME',
    nominal: 4.27,
    unit: 'm',
    min: 3.0,
    max: 6.0,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: '14 feet, and a guess. The surface that matters most: the ceiling and the floor are NEARER their projectors than the sphere is, so they return at least as much modulation as the ball and no decoder brightness threshold separates them from it. PARAMETERS.md §8 item 19 collects it.',
  },
  rho_room: {
    symbol: 'ρ_room',
    name: 'Wall and floor albedo',
    section: '§5',
    klass: 'ASSUME',
    nominal: 0.3,
    unit: '',
    min: 0.15,
    max: 0.6,
    rangeSource: 'inferred',
    affects: 'both',
    note: 'Reaches a geometric result directly: with room spill on it scales every off-sphere return before the decoder modulation gate, so it sets how much contamination experiments 4 and 5 see. The earlier note here said it only mattered via inter-reflection; that stopped being true when the room became switchable. PARAMETERS.md §5 and §8 item 18 carry the same statement.',
  },

  // ---- §6 Viewer ----------------------------------------------------------
  h_eye_adult: {
    symbol: 'h_eye',
    name: 'Eye height, adult',
    section: '§6',
    klass: 'ASSUME',
    nominal: 1.6,
    unit: 'm',
    min: 1.5,
    max: 1.85,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: 'The equator sits at 2.18 m, so everyone looks up. PARAMETERS.md says run both adult and child.',
  },
  h_eye_child: {
    symbol: 'h_eye',
    name: 'Eye height, child',
    section: '§6',
    klass: 'ASSUME',
    nominal: 1.15,
    unit: 'm',
    min: 0.9,
    max: 1.4,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: 'Children look up steeply and are a large share of the SOS audience.',
  },
  d_view: {
    symbol: 'd_view',
    name: 'Viewing distance from sphere centre',
    section: '§6',
    klass: 'CFG',
    nominal: 2.5,
    unit: 'm',
    min: 2.0,
    max: 3.5,
    rangeSource: 'stated',
    affects: 'geometry',
    note: 'Bounded below by the guard rail.',
  },
  fov_eye: {
    symbol: 'fov_eye',
    name: 'Viewer camera field of view',
    section: '§6',
    klass: 'ASSUME',
    nominal: 50.0,
    unit: 'deg',
    min: 35.0,
    max: 70.0,
    rangeSource: 'inferred',
    affects: 'geometry',
    note: 'Framing choice. PARAMETERS.md is explicit that metric values must not depend on it — the bench asserts this.',
  },
};

/** The ASSUME-class parameters the photometric sensitivity experiment must sweep. */
export const ASSUME_PHOTOMETRIC_IDS: string[] = [
  'rho_R',
  'rho_G',
  'rho_B',
  'rho_spec',
  'alpha_spec',
  'gamma_R',
  'gamma_G',
  'gamma_B',
  'L_black_R',
  'L_black_G',
  'L_black_B',
  'g_R',
  'g_G',
  'g_B',
  'wp',
  'w_width',
  'E_amb',
  'E_amb_chroma',
  'mask_lo',
  'mask_hi',
];

// ---------------------------------------------------------------------------
// Projector hardware profile — the spec sheet PARAMETERS.md §3.1 asks for
// ---------------------------------------------------------------------------

/**
 * A projector model's published optical envelope.
 *
 * PARAMETERS.md §3.1 classes the throw ratio `T` as `CFG` — "read from a
 * hardware spec sheet" — and derives `fov_h` from it. Until docs/AMENDMENTS.md
 * A-35 there was no spec sheet, so §3.1's own `T ~ 3.0` stood as an inference
 * and the solver had an effectively unbounded prior on the field of view.
 *
 * A profile is not a nominal and it is not a value: a zoom lens's throw ratio is
 * a RANGE, and A-35 is explicit that knowing the model does not break the
 * fov/distance degeneracy because the Red Ball procedure sets the zoom ring
 * until the image matches the sphere. What a profile gives is a HARD BOX. No
 * unit of this model can sit outside it, whatever the data says, because the
 * lens does not move that far.
 *
 * Both halves of the boundary may read this file, and neither is obliged to.
 * `packages/sim` does not: the bench draws its truth rigs around PARAMETERS.md's
 * own construction, so a forward model built from this profile and an inverse
 * model bounded by it would be the same statement made twice.
 */
export interface ProjectorProfile {
  /** Stable id, used in reports so a result computed with it is attributable. */
  id: string;
  model: string;
  klass: ParamClass;
  /** Where every number below came from, verbatim enough to re-check. */
  source: string;
  /** Native raster, PARAMETERS.md §3.1 `res_proj`. */
  resX: number;
  resY: number;
  /** Throw ratio at the wide (shortest) end of the zoom, distance over width. */
  throwRatioMin: number;
  /** Throw ratio at the tele (longest) end. */
  throwRatioMax: number;
  /**
   * Horizontal field of view at the WIDE end, degrees — the LARGER of the two,
   * because a shorter throw ratio is a wider field. Derived from
   * `throwRatioMin` as `2*atan(1/(2*T))` and written here as a literal, since
   * this package holds no arithmetic.
   */
  fovHDegMax: number;
  /** Horizontal field of view at the TELE end, degrees. From `throwRatioMax`. */
  fovHDegMin: number;
  /**
   * Mechanical lens shift limits in conventions.ts §I's units — a fraction of
   * the HALF-image dimension, which is the same convention the manufacturer's
   * percentage uses. Signed symmetric: the published figure is `-60% ~ +60%`.
   */
  shiftVMax: number;
  shiftHMax: number;
  /**
   * Projection offset at neutral shift, as a fraction of the half-image. 0
   * means the image is centred on the optical axis rather than thrown entirely
   * above it, which is what makes §3.1's `shift = 0` nominal correct for this
   * hardware rather than merely conventional.
   */
  projectionOffset: number;
  /** Clear focus range, metres, at the wide and tele ends. PARAMETERS.md §3.3. */
  focusMinWideM: number;
  focusMaxWideM: number;
  focusMinTeleM: number;
  focusMaxTeleM: number;
  /** §3.2 cares which it is: DLP and LCD leak differently per channel. */
  displaySystem: string;
  /** §3.2's gain rationale is lamp ageing. A laser has no lamp. */
  lightSource: string;
  note: string;
}

/**
 * BenQ LK935, the projector this installation runs — four of them, one model.
 *
 * Every number is quoted or derived in docs/AMENDMENTS.md A-35 from the user
 * manual (LK935_UM_EN) and confirmed against BenQ's published specification
 * page. The throw ratio was obtained by dividing projection distance by image
 * width across three rows of the manual's own distance table, all three
 * agreeing, and the product page states the same 1.36~2.18 independently.
 *
 * Two consequences A-35 draws, both load-bearing for anything reading this:
 *
 *  - **§3.1's `T ~ 3.0` is not achievable by this projector at any zoom
 *    setting.** It is beyond the tele end. docs/AMENDMENTS.md A-01 derived
 *    `T ~ 1.69` from the sphere's geometry alone, before this manual existed,
 *    and covering a 1.7272 m sphere from 5.18 m needs T = 1.687 — inside this
 *    envelope, and agreeing with A-01 to three digits.
 *  - **The model number does NOT settle `fov_h`.** The zoom is a continuous
 *    manual ring and the Red Ball procedure turns it until the image matches
 *    the sphere, so `T` stays coupled to `d_proj` exactly as before.
 */
export const PROJECTOR_LK935: ProjectorProfile = {
  id: 'LK935',
  model: 'BenQ LK935',
  klass: 'CFG',
  source:
    'BenQ LK935 user manual (LK935_UM_EN, 102 pp) plus the published specification page; both supplied by the owner and transcribed in docs/AMENDMENTS.md A-35.',
  resX: 3840,
  resY: 2160,
  throwRatioMin: 1.36,
  throwRatioMax: 2.18,
  // 2*atan(1/(2*1.36)) = 40.37 deg; 2*atan(1/(2*2.18)) = 25.84 deg.
  fovHDegMax: 40.37,
  fovHDegMin: 25.84,
  // Manual and product page agree: -60% ~ +60% vertical, -23% ~ +23% horizontal.
  shiftVMax: 0.6,
  shiftHMax: 0.23,
  // Product page: "Projection Offset (Full-Height) 0%".
  projectionOffset: 0.0,
  focusMinWideM: 1.8,
  focusMaxWideM: 6.0,
  focusMinTeleM: 2.88,
  focusMaxTeleM: 9.6,
  displaySystem: '1-CHIP DMD',
  lightSource: 'Laser',
  note:
    'Zoom 1.60x, focal length 14.3-22.9 mm (the product page gives 8.6-9.4, which contradicts its own zoom ratio and lands on no real DMD; the manual wins — see A-35 section 6). The clear-focus span of 2.88-9.60 m at tele comfortably contains the sphere\'s 0.79 m depth swing, which downgrades PARAMETERS.md §3.3 and §9\'s depth-of-field concern.',
};

/** Acceptance gates, PARAMETERS.md §7. */
export interface MetricGate {
  id: string;
  metric: string;
  /** Inclusive upper bound the metric must not exceed. */
  max: number;
  unit: string;
  klass: ParamClass | 'DERIVED';
  phase: 'geometry' | 'photometry';
  basis: string;
}

export const GATES: MetricGate[] = [
  {
    id: 'grid_displacement',
    metric: 'Grid-line displacement across a blend region',
    max: 1.0,
    unit: 'mm on sphere surface',
    klass: 'ASSUME',
    phase: 'geometry',
    basis: 'About 1 arcmin at 2.5 m.',
  },
  {
    id: 'pose_position',
    metric: 'Pose recovery position error',
    max: 0.002,
    unit: 'm',
    klass: 'DERIVED',
    phase: 'geometry',
    basis: 'Chosen so geometric error is dominated by other terms.',
  },
  {
    id: 'pose_rotation',
    metric: 'Pose recovery rotation error',
    max: 0.05,
    unit: 'deg',
    klass: 'DERIVED',
    phase: 'geometry',
    basis: 'Chosen so geometric error is dominated by other terms.',
  },
  {
    id: 'off_sphere_flux',
    metric: 'Off-sphere flux (Red Ball equivalent)',
    max: 0.52,
    unit: 'fraction',
    klass: 'ASSUME',
    phase: 'geometry',
    basis: 'Floor is about 51% from raster geometry. Catches gross misaim. See AMENDMENTS.md A-01.',
  },
  {
    id: 'unlit_in_mask',
    metric: 'Unlit fraction within the mask boundary',
    max: 0.0,
    unit: 'fraction',
    klass: 'DERIVED',
    phase: 'geometry',
    basis: 'Hard requirement. Computed inside mask_lo, not over the full sphere.',
  },
  {
    id: 'seam_luminance',
    metric: 'Seam luminance discontinuity',
    max: 0.02,
    unit: 'fraction of local mean',
    klass: 'ASSUME',
    phase: 'photometry',
    basis: 'Weber fraction for a step in a smooth field. PROVISIONAL.',
  },
  {
    id: 'seam_chroma',
    metric: 'Seam chromaticity discontinuity',
    max: 1.0,
    unit: 'dE2000',
    klass: 'ASSUME',
    phase: 'photometry',
    basis: 'Classic just-noticeable difference. The eye is more sensitive to chromatic edges. PROVISIONAL.',
  },
  {
    id: 'black_uplift',
    metric: 'Black uplift ratio, overlap over single',
    max: 1.2,
    unit: 'ratio',
    klass: 'ASSUME',
    phase: 'photometry',
    basis: 'Below where an overlap band reads as a visible rectangle in dark content. PROVISIONAL.',
  },
  {
    id: 'black_uplift_chroma',
    metric: 'Black uplift chromaticity shift',
    max: 2.0,
    unit: 'dE2000',
    klass: 'ASSUME',
    phase: 'photometry',
    basis: 'Looser than the highlight gate; chromatic discrimination is poorer in dark content. PROVISIONAL.',
  },
];
