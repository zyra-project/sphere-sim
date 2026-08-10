/**
 * SVG for the two experiment figures. No dependencies, no build step — the same
 * constraint as everything else in this repo (zero runtime dependencies, node
 * built-ins only), so the plots are written as text.
 *
 * Colour follows the project's data-visualization rules rather than taste:
 *
 *  - Experiment 2's panels encode a continuous magnitude, so they use ONE hue,
 *    light to dark, with a scale legend. The two gate contours are drawn in ink and
 *    labelled in words, never in colour alone — they are annotation on top of the
 *    magnitude, not a second encoding.
 *  - Experiment 3's bars encode identity in two classes — ranges PARAMETERS.md
 *    STATES and ranges this project INVENTED — so those get two categorical hues, a
 *    legend, and separate panels. They are never interleaved: a ranking that mixes a
 *    measured range with an invented one is the specific dishonesty the experiment
 *    exists to avoid, and putting them in one sorted list would do it silently.
 *
 * Both figures carry the word PROVISIONAL in the subtitle. A figure travels further
 * than the document it came from.
 */

import type { Experiment2Result } from './experiment2.ts';
import { LUMINANCE_GATE, CHROMA_GATE, REGISTRATION_MM, WIDTHS_DEG } from './experiment2.ts';
import type { Experiment3Result, ParameterSensitivity } from './experiment3.ts';

const SURFACE = '#fcfcfb';
const PLANE = '#f9f9f7';
const INK = '#0b0b0b';
const INK_2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';
const AXIS = '#c3c2b7';
const SERIES_1 = '#2a78d6';
const SERIES_2 = '#eb6834';

/** The project palette's blue sequential ramp, 100 -> 700. */
const RAMP: readonly string[] = [
  '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5',
  '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b',
];

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface TextOptions {
  size?: number;
  fill?: string;
  anchor?: 'start' | 'middle' | 'end';
  weight?: number;
  rotate?: number;
  mono?: boolean;
}

function text(x: number, y: number, s: string, o: TextOptions = {}): string {
  const transform = o.rotate ? ` transform="rotate(${o.rotate} ${x} ${y})"` : '';
  const numeric = o.mono ? ' font-variant-numeric="tabular-nums"' : '';
  return (
    `<text x="${r(x)}" y="${r(y)}" font-family="${FONT}" font-size="${o.size ?? 11}" ` +
    `fill="${o.fill ?? INK_2}" text-anchor="${o.anchor ?? 'start'}" ` +
    `font-weight="${o.weight ?? 400}"${numeric}${transform}>${esc(s)}</text>`
  );
}

function r(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Log scale helper. */
function logScale(min: number, max: number, lo: number, hi: number): (v: number) => number {
  const a = Math.log(min);
  const b = Math.log(max);
  return (v: number): number => lo + ((Math.log(v) - a) / (b - a)) * (hi - lo);
}

function linearScale(min: number, max: number, lo: number, hi: number): (v: number) => number {
  return (v: number): number => lo + ((v - min) / (max - min)) * (hi - lo);
}

/** Sequential colour for a magnitude, on a log scale between two decades. */
function rampColor(value: number, minDecade: number, maxDecade: number): string {
  if (!(value > 0)) return RAMP[0];
  const t = (Math.log10(value) - minDecade) / (maxDecade - minDecade);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return RAMP[Math.min(RAMP.length - 1, Math.round(clamped * (RAMP.length - 1)))];
}

// ---------------------------------------------------------------------------
// Experiment 2 — one panel per ramp shape
// ---------------------------------------------------------------------------

const MIN_DECADE = -3.3;
const MAX_DECADE = 0;

export function renderExperiment2Svg(result: Experiment2Result): string {
  const shapes = result.generatedFrom.shapes;
  const panelW = 268;
  const panelH = 230;
  const gapX = 22;
  const left = 62;
  const top = 108;
  const width = left + shapes.length * panelW + (shapes.length - 1) * gapX + 26;
  const height = top + panelH + 132;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" ` +
      `aria-label="Misregistration artifact against blend ramp width, one panel per ramp shape">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${PLANE}"/>`);
  parts.push(
    text(left - 34, 34, 'Experiment 2 — does soft blending buy geometric tolerance?', {
      size: 17,
      fill: INK,
      weight: 600,
    }),
  );
  parts.push(
    text(
      left - 34,
      54,
      'PROVISIONAL — every photometric constant behind this figure is class ASSUME and none has been measured.',
      { size: 11, fill: SERIES_2, weight: 600 },
    ),
  );
  parts.push(
    text(
      left - 34,
      70,
      'Cell colour: peak luminance error the misregistration causes, |Y − Y_calibrated| / Y_calibrated, on a flat mid-gray field.',
      { size: 11, fill: INK_2 },
    ),
  );
  parts.push(
    text(
      left - 34,
      85,
      'Contours mark where that reaches §7\'s seam gates — which gate a STEP, not a band (A-15), so they are a scale and not a verdict.',
      { size: 11, fill: INK_2 },
    ),
  );

  const x = logScale(0.35, 90, 0, panelW - 34);
  const y = linearScale(WIDTHS_DEG[0] - 3, WIDTHS_DEG[WIDTHS_DEG.length - 1] + 5, panelH - 26, 0);

  shapes.forEach((shape, index) => {
    const ox = left + index * (panelW + gapX);
    parts.push(`<g transform="translate(${ox} ${top})">`);
    parts.push(
      `<rect x="0" y="-24" width="${panelW - 34}" height="${panelH + 2}" fill="${SURFACE}" stroke="${GRID}"/>`,
    );
    parts.push(text(0, -8, shape, { size: 12, fill: INK, weight: 600 }));

    // Cells. Boundaries at geometric / arithmetic midpoints of the sampled grid, so
    // the figure shows exactly where it was sampled and interpolates nothing.
    for (let i = 0; i < REGISTRATION_MM.length; i++) {
      const mm = REGISTRATION_MM[i];
      const x0 = x(i === 0 ? mm / 1.6 : Math.sqrt(mm * REGISTRATION_MM[i - 1]));
      const x1 = x(
        i === REGISTRATION_MM.length - 1 ? mm * 1.6 : Math.sqrt(mm * REGISTRATION_MM[i + 1]),
      );
      for (let j = 0; j < WIDTHS_DEG.length; j++) {
        const w = WIDTHS_DEG[j];
        const y0 = y(j === 0 ? w - 2 : (w + WIDTHS_DEG[j - 1]) / 2);
        const y1 = y(j === WIDTHS_DEG.length - 1 ? w + 4 : (w + WIDTHS_DEG[j + 1]) / 2);
        const cell = result.cells.find(
          (c) => c.shape === shape && c.widthDeg === w && c.registrationMm === mm,
        );
        if (cell === undefined) continue;
        parts.push(
          `<rect x="${r(x0)}" y="${r(y1)}" width="${r(x1 - x0)}" height="${r(y0 - y1)}" ` +
            `fill="${rampColor(cell.misregLuminance, MIN_DECADE, MAX_DECADE)}"/>`,
        );
      }
    }

    // The two gate contours, from the per-width threshold crossings.
    const contour = (key: 'luminanceToleranceMm' | 'chromaToleranceMm', dash: string): string => {
      const points = WIDTHS_DEG.map((w) => {
        const c = result.contours.find((z) => z.shape === shape && z.widthDeg === w);
        return c === undefined ? null : { w, mm: c[key] };
      })
        .filter((p): p is { w: number; mm: number } => p !== null && Number.isFinite(p.mm) && p.mm > 0)
        .map((p) => `${r(x(p.mm))},${r(y(p.w))}`);
      if (points.length < 2) return '';
      return (
        `<polyline points="${points.join(' ')}" fill="none" stroke="${INK}" ` +
        `stroke-width="2" stroke-dasharray="${dash}" stroke-linejoin="round"/>`
      );
    };
    parts.push(contour('luminanceToleranceMm', 'none'));
    parts.push(contour('chromaToleranceMm', '5 3'));

    // §4.5's nominal 20-degree width and §7's 1.0 mm grid gate, as references.
    parts.push(
      `<line x1="0" y1="${r(y(20))}" x2="${r(panelW - 34)}" y2="${r(y(20))}" ` +
        `stroke="${MUTED}" stroke-width="1" stroke-dasharray="2 3"/>`,
    );
    parts.push(
      `<line x1="${r(x(1))}" y1="0" x2="${r(x(1))}" y2="${r(panelH - 26)}" ` +
        `stroke="${MUTED}" stroke-width="1" stroke-dasharray="2 3"/>`,
    );

    // Axes.
    for (const mm of [0.5, 1, 2, 4, 8, 16, 32, 64]) {
      parts.push(text(x(mm), panelH - 10, String(mm), { size: 9, fill: MUTED, anchor: 'middle', mono: true }));
    }
    parts.push(
      text((panelW - 34) / 2, panelH + 8, 'registration error between neighbours, mm of arc at the equator', {
        size: 9.5,
        fill: INK_2,
        anchor: 'middle',
      }),
    );
    if (index === 0) {
      for (const w of [5, 20, 40, 60, 71]) {
        parts.push(text(-8, y(w) + 3, String(w), { size: 9, fill: MUTED, anchor: 'end', mono: true }));
      }
      parts.push(
        text(-42, panelH / 2, 'blend ramp width, degrees of arc', {
          size: 9.5,
          fill: INK_2,
          anchor: 'middle',
          rotate: -90,
        }),
      );
    }
    parts.push('</g>');
  });

  // Scale legend and annotation key.
  const legendY = top + panelH + 44;
  parts.push(text(left - 34, legendY - 8, 'peak luminance error', { size: 10, fill: INK_2 }));
  const swatch = 21;
  RAMP.forEach((hex, i) => {
    parts.push(
      `<rect x="${r(left - 34 + i * (swatch + 2))}" y="${legendY}" width="${swatch}" height="10" fill="${hex}"/>`,
    );
  });
  parts.push(text(left - 34, legendY + 24, '0.05%', { size: 9, fill: MUTED, mono: true }));
  parts.push(
    text(left - 34 + RAMP.length * (swatch + 2) - 2, legendY + 24, '100%', {
      size: 9,
      fill: MUTED,
      anchor: 'end',
      mono: true,
    }),
  );

  const keyX = left + 330;
  parts.push(
    `<line x1="${keyX}" y1="${legendY + 5}" x2="${keyX + 26}" y2="${legendY + 5}" stroke="${INK}" stroke-width="2"/>`,
  );
  parts.push(text(keyX + 32, legendY + 9, `§7 luminance gate, ${LUMINANCE_GATE * 100}% of local mean`, { size: 10, fill: INK }));
  parts.push(
    `<line x1="${keyX}" y1="${legendY + 23}" x2="${keyX + 26}" y2="${legendY + 23}" stroke="${INK}" stroke-width="2" stroke-dasharray="5 3"/>`,
  );
  parts.push(text(keyX + 32, legendY + 27, `§7 chromaticity gate, ΔE2000 ${CHROMA_GATE.toFixed(1)}`, { size: 10, fill: INK }));
  parts.push(
    `<line x1="${keyX + 300}" y1="${legendY + 5}" x2="${keyX + 326}" y2="${legendY + 5}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="2 3"/>`,
  );
  parts.push(text(keyX + 332, legendY + 9, '§4.5 nominal width, 20°', { size: 10, fill: INK_2 }));
  parts.push(text(keyX + 332, legendY + 27, '§7 grid gate, 1.0 mm', { size: 10, fill: INK_2 }));

  const verdict = result.verdict;
  parts.push(
    text(
      left - 34,
      height - 30,
      `Verdict: ${verdict.holds ? 'the hypothesis HOLDS in this model' : 'the hypothesis DOES NOT hold as stated'} — ` +
        `over w_width's inferred 5–40° range the tolerable registration error rises ` +
        `${verdict.toleranceGainOverInferredRange.toFixed(2)}×.`,
      { size: 11, fill: INK, weight: 600 },
    ),
  );
  parts.push(
    text(
      left - 34,
      height - 14,
      'Same rig, same seed, one knob. The artifact is a point-for-point difference between two renders of ONE physical rig — with and without a correct calibration — so no window, polynomial or scale enters it.',
      { size: 10, fill: MUTED },
    ),
  );

  parts.push('</svg>');
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Experiment 3 — ranked bars, stated and inferred kept apart
// ---------------------------------------------------------------------------

export function renderExperiment3Svg(result: Experiment3Result): string {
  const stated = result.rankedStated
    .map((id) => result.parameters.find((p) => p.id === id))
    .filter((p): p is ParameterSensitivity => p !== undefined);
  const inferred = result.rankedInferred
    .map((id) => result.parameters.find((p) => p.id === id))
    .filter((p): p is ParameterSensitivity => p !== undefined);

  const rowH = 19;
  const barLeft = 232;
  const barW = 300;
  const width = barLeft + barW + 250;
  const headerH = 128;
  const groupGap = 62;
  const height =
    headerH + stated.length * rowH + groupGap + inferred.length * rowH + 132;

  const allScores = [...stated, ...inferred].map((p) => Math.max(p.scoreScored, p.scoreUnscored));
  const maxScore = Math.max(0.01, ...allScores);
  const scale = (v: number): number => (Math.min(v, maxScore) / maxScore) * barW;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}" role="img" ` +
      `aria-label="Photometric sensitivity ranking, stated ranges separated from inferred ranges">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${PLANE}"/>`);
  parts.push(
    text(24, 32, 'Experiment 3 — which unmeasured constant actually moves a §7 metric?', {
      size: 17,
      fill: INK,
      weight: 600,
    }),
  );
  parts.push(
    text(
      24,
      52,
      'PROVISIONAL — every constant here is class ASSUME. A bar is how far a metric moves across the constant\'s plausible range, divided by the metric\'s own gate.',
      { size: 11, fill: SERIES_2, weight: 600 },
    ),
  );
  parts.push(
    text(
      24,
      70,
      'A bar of 1.0 means the constant alone can move a §7 metric by the whole width of its gate. Longer than 1.0 means the constant decides the verdict.',
      { size: 11, fill: INK_2 },
    ),
  );

  // Legend — identity, never colour alone: each bar is also labelled with its value.
  parts.push(`<rect x="24" y="86" width="10" height="10" fill="${SERIES_1}"/>`);
  parts.push(text(40, 95, 'the four §7 gates this project SCORES', { size: 10.5, fill: INK_2 }));
  parts.push(`<rect x="292" y="86" width="10" height="10" fill="${SERIES_2}"/>`);
  parts.push(
    text(308, 95, 'readings §7 sets NO gate on (divergence, ambient-removed uplift)', {
      size: 10.5,
      fill: INK_2,
    }),
  );

  const drawGroup = (
    rows: readonly ParameterSensitivity[],
    y0: number,
    title: string,
    subtitle: string,
  ): number => {
    parts.push(text(24, y0 - 22, title, { size: 12.5, fill: INK, weight: 600 }));
    parts.push(text(24, y0 - 7, subtitle, { size: 10, fill: MUTED }));
    parts.push(
      `<rect x="${barLeft - 8}" y="${y0}" width="${barW + 16}" height="${rows.length * rowH}" fill="${SURFACE}"/>`,
    );
    for (const gridline of [0.25, 0.5, 0.75, 1]) {
      const gx = barLeft + scale(gridline * maxScore);
      parts.push(
        `<line x1="${r(gx)}" y1="${y0}" x2="${r(gx)}" y2="${y0 + rows.length * rowH}" stroke="${GRID}" stroke-width="1"/>`,
      );
    }
    rows.forEach((p, i) => {
      const cy = y0 + i * rowH;
      parts.push(
        text(barLeft - 16, cy + 13, `${p.symbol}  ${p.section}`, {
          size: 10.5,
          fill: INK,
          anchor: 'end',
        }),
      );
      // The scored bar, then the unscored one drawn under it in the same row so the
      // gap between "what §7 gates" and "what §7 misses" is a length, not a footnote.
      const scored = scale(p.scoreScored);
      const unscored = scale(p.scoreUnscored);
      if (unscored > 0.5) {
        parts.push(
          `<rect x="${barLeft}" y="${cy + 9}" width="${r(Math.max(unscored, 1))}" height="5" rx="2" fill="${SERIES_2}"/>`,
        );
      }
      if (scored > 0) {
        parts.push(
          `<rect x="${barLeft}" y="${cy + 3}" width="${r(Math.max(scored, 1))}" height="5" rx="2" fill="${SERIES_1}"/>`,
        );
      }
      const label =
        p.scoreScored >= 0.005
          ? `${p.scoreScored.toFixed(2)}× gate`
          : p.scoreScored > 0
            ? `${p.scoreScored.toExponential(1)}× gate`
            : 'no effect';
      const extra = p.scoreUnscored > 0.05 ? `   (unscored ${p.scoreUnscored.toFixed(1)}×)` : '';
      parts.push(
        text(barLeft + Math.max(scored, unscored) + 8, cy + 12, label + extra, {
          size: 9.5,
          fill: INK_2,
          mono: true,
        }),
      );
    });
    return y0 + rows.length * rowH;
  };

  let cursor = drawGroup(
    stated,
    headerH,
    'Ranges PARAMETERS.md STATES  — rank on these',
    'The swing is a statement about the projector.',
  );
  cursor = drawGroup(
    inferred,
    cursor + groupGap,
    'Ranges this project INVENTED  — docs/AMENDMENTS.md A-04',
    'The swing is a statement about our invention. Never merge these into the ranking above.',
  );

  const notes = [
    `§10 ranks gamma divergence first. On the four SCORED gates it ranks ` +
      `${result.section10[0].bestRankOverall} of ${result.parameters.length}; on the unscored ` +
      `divergence reading it is first by an order of magnitude. The gates are what disagree, not the physics.`,
    'Bars are the largest swing over any single response, one constant moved at a time, everything else at its PARAMETERS.md nominal.',
  ];
  notes.forEach((note, i) => {
    parts.push(text(24, cursor + 44 + i * 16, note, { size: 10, fill: i === 0 ? INK : MUTED }));
  });

  parts.push(
    `<line x1="24" y1="${cursor + 20}" x2="${width - 24}" y2="${cursor + 20}" stroke="${AXIS}" stroke-width="1"/>`,
  );

  parts.push('</svg>');
  return parts.join('\n');
}
