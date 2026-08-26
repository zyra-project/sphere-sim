// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Eric Hackathorn

/**
 * A small plotting kit: SVG generated from the data, with no charting library
 * and no JavaScript in the output.
 *
 * The same reasoning packages/bench/README.md gives for the progress page
 * applies here and more so: these files are the experiment's deliverable, they
 * will be opened in a browser with no network, and a plot that quietly needs a
 * CDN is a plot that will be blank in the room where it matters. So every figure
 * is one self-contained `<svg>` with inline styles, and every number in it comes
 * from the results JSON that ships beside it.
 *
 * Design rules the figures follow, each with a failure mode behind it:
 *
 *  - **Log axes wherever the data spans decades**, which is most of them: pose
 *    error runs from a tenth of a millimetre to hundreds. On a linear axis every
 *    point below 10 mm would sit on the frame and the interesting structure —
 *    which is all at the bottom — would be invisible.
 *  - **Every seed is drawn**, not just the median. A median line with no dots is
 *    a claim about a distribution the reader cannot check.
 *  - **Points outside the axis range are clamped to the frame and marked**,
 *    never dropped. An outlier silently removed is the one thing a measurement
 *    plot must not do.
 *  - **Gate lines are drawn where §7 puts them**, labelled with the section, so
 *    the reader does not have to hold the threshold in their head.
 */

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Fixed significant figures without exponent noise for the ranges plotted. */
export function fmt(v: number, sig = 3): string {
  if (!Number.isFinite(v)) return 'n/a';
  if (v === 0) return '0';
  const mag = Math.abs(v);
  if (mag >= 1000) return v.toFixed(0);
  if (mag >= 100) return v.toFixed(sig >= 4 ? 1 : 0);
  if (mag >= 10) return v.toFixed(1);
  if (mag >= 1) return v.toFixed(2);
  if (mag >= 0.01) return v.toFixed(3);
  return v.toExponential(1);
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export interface Scale {
  /** Data value -> pixel. */
  to(v: number): number;
  ticks: { value: number; label: string }[];
  min: number;
  max: number;
  kind: 'linear' | 'log';
}

export function linearScale(
  min: number,
  max: number,
  pxLo: number,
  pxHi: number,
  ticks: { value: number; label: string }[],
): Scale {
  const span = max - min || 1;
  return {
    to: (v) => pxLo + ((v - min) / span) * (pxHi - pxLo),
    ticks,
    min,
    max,
    kind: 'linear',
  };
}

/**
 * A log scale over a data range, snapped outward to decade boundaries.
 *
 * Non-positive data is not representable, so the caller passes a floor: values
 * at or below it are clamped to the axis minimum and drawn as clamped. That is
 * the honest treatment for a recovery error of exactly zero, which does happen
 * on a noiseless capture.
 */
export function logScale(
  dataMin: number,
  dataMax: number,
  pxLo: number,
  pxHi: number,
): Scale {
  const lo = Math.pow(10, Math.floor(Math.log10(Math.max(dataMin, 1e-12))));
  const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(dataMax, lo * 10))));
  const l0 = Math.log10(lo);
  const l1 = Math.log10(hi);
  const ticks: { value: number; label: string }[] = [];
  const decades = Math.round(l1 - l0);
  // Minor ticks only when the axis is short enough for them to be legible.
  const minors = decades <= 3 ? [1, 2, 5] : [1];
  for (let d = 0; d <= decades; d++) {
    for (const m of minors) {
      const v = m * Math.pow(10, l0 + d);
      if (v > hi * 1.0001) continue;
      ticks.push({ value: v, label: fmt(v) });
    }
  }
  return {
    to: (v) => {
      const clamped = Math.max(lo, Math.min(hi, v));
      return pxLo + ((Math.log10(clamped) - l0) / (l1 - l0)) * (pxHi - pxLo);
    },
    ticks,
    min: lo,
    max: hi,
    kind: 'log',
  };
}

/**
 * A log scale over exactly the range asked for, with a little padding.
 *
 * Used for x axes that carry explicit ticks — camera resolution, floor-reference
 * sigma. Snapping those outward to decade boundaries would put 320x240 and
 * 4032x3024 inside a 100..10000 frame and waste half the plot on empty space
 * either side of the data.
 */
export function logScaleExact(
  min: number,
  max: number,
  pxLo: number,
  pxHi: number,
  ticks: { value: number; label: string }[],
  padFraction = 0.06,
): Scale {
  const l0 = Math.log10(Math.max(min, 1e-12));
  const l1 = Math.log10(Math.max(max, min * 1.0001));
  const pad = (l1 - l0) * padFraction;
  const a = l0 - pad;
  const b = l1 + pad;
  return {
    to: (v) => {
      const l = Math.log10(Math.max(1e-12, v));
      return pxLo + ((Math.min(b, Math.max(a, l)) - a) / (b - a)) * (pxHi - pxLo);
    },
    ticks,
    min: Math.pow(10, a),
    max: Math.pow(10, b),
    kind: 'log',
  };
}

// ---------------------------------------------------------------------------
// Figure model
// ---------------------------------------------------------------------------

export interface PlotPoint {
  x: number;
  /** Median over seeds. */
  y: number;
  /** Whiskers: the observed range over seeds. */
  lo: number;
  hi: number;
  /** Every seed's own value, drawn as dots. */
  values: number[];
  n: number;
}

export interface PlotSeries {
  label: string;
  color: string;
  points: PlotPoint[];
  /** Drawn dashed — used for predictions rather than measurements. */
  dashed?: boolean;
  /** Suppress the per-seed dots. Predictions have no seeds. */
  noDots?: boolean;
}

export interface GateLine {
  value: number;
  label: string;
}

export interface Panel {
  title: string;
  subtitle?: string;
  xLabel: string;
  yLabel: string;
  xKind: 'linear' | 'log' | 'category';
  /** For `category`, the tick labels in order; x is the index. */
  categories?: string[];
  xTicks?: { value: number; label: string }[];
  series: PlotSeries[];
  gates?: GateLine[];
  /**
   * Horizontal reference lines that are not gates — a condition measured off
   * the x axis, drawn where it lands so it can be compared by eye rather than
   * by flipping to a table.
   */
  refLines?: { value: number; label: string; color: string }[];
  /** Extra prose printed under the panel. */
  footnote?: string;
}

const PANEL_W = 420;
const PANEL_H = 300;
const PAD_L = 62;
const PAD_R = 18;
const PAD_T = 44;
const PAD_B = 74;

export const PALETTE = {
  tripod: '#1f5fa9',
  handheld: '#c2521a',
  third: '#2e7d4f',
  fourth: '#7a4fa3',
  prediction: '#777777',
  gate: '#b3261e',
  axis: '#333333',
  grid: '#e3e3e3',
  text: '#1a1a1a',
  muted: '#5a5a5a',
  bg: '#ffffff',
};

function ySpan(panel: Panel): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of panel.series) {
    for (const p of s.points) {
      for (const v of [p.y, p.lo, p.hi, ...p.values]) {
        if (!Number.isFinite(v) || v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  for (const g of panel.gates ?? []) {
    if (g.value > 0) {
      if (g.value < min) min = g.value;
      if (g.value > max) max = g.value;
    }
  }
  for (const r of panel.refLines ?? []) {
    if (r.value > 0) {
      if (r.value < min) min = r.value;
      if (r.value > max) max = r.value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0.1, max: 10 };
  return { min, max };
}

function renderPanel(panel: Panel, ox: number, oy: number): string {
  const x0 = ox + PAD_L;
  const x1 = ox + PANEL_W - PAD_R;
  const y0 = oy + PANEL_H - PAD_B;
  const y1 = oy + PAD_T;

  const span = ySpan(panel);
  const ys = logScale(span.min, span.max, y0, y1);

  let xs: Scale;
  if (panel.xKind === 'log') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of panel.series) {
      for (const p of s.points) {
        if (p.x <= 0) continue;
        lo = Math.min(lo, p.x);
        hi = Math.max(hi, p.x);
      }
    }
    // Explicit ticks mean the caller knows the levels it measured, so the axis
    // spans exactly those rather than the enclosing decades.
    xs =
      panel.xTicks && panel.xTicks.length > 0
        ? logScaleExact(
            Math.min(lo, ...panel.xTicks.map((t) => t.value)),
            Math.max(hi, ...panel.xTicks.map((t) => t.value)),
            x0,
            x1,
            panel.xTicks,
          )
        : logScale(lo, hi, x0, x1);
  } else if (panel.xKind === 'category') {
    const cats = panel.categories ?? [];
    xs = linearScale(
      -0.5,
      cats.length - 0.5,
      x0,
      x1,
      cats.map((c, i) => ({ value: i, label: c })),
    );
  } else {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of panel.series) {
      for (const p of s.points) {
        lo = Math.min(lo, p.x);
        hi = Math.max(hi, p.x);
      }
    }
    const ticks = panel.xTicks ?? [];
    xs = linearScale(lo - 0.4, hi + 0.4, x0, x1, ticks);
  }

  const out: string[] = [];
  out.push(
    `<text x="${ox + 10}" y="${oy + 20}" class="ttl">${esc(panel.title)}</text>`,
  );
  if (panel.subtitle) {
    out.push(`<text x="${ox + 10}" y="${oy + 35}" class="sub">${esc(panel.subtitle)}</text>`);
  }

  // Grid + y ticks
  for (const t of ys.ticks) {
    const y = ys.to(t.value);
    out.push(`<line x1="${x0}" y1="${y.toFixed(2)}" x2="${x1}" y2="${y.toFixed(2)}" class="grid"/>`);
    out.push(
      `<text x="${x0 - 6}" y="${(y + 3.5).toFixed(2)}" class="tick end">${esc(t.label)}</text>`,
    );
  }
  // x ticks
  for (const t of xs.ticks) {
    const x = xs.to(t.value);
    out.push(`<line x1="${x.toFixed(2)}" y1="${y0}" x2="${x.toFixed(2)}" y2="${y0 + 4}" class="ax"/>`);
    const rotate = panel.xKind === 'category' && t.label.length > 6;
    if (rotate) {
      out.push(
        `<text transform="translate(${x.toFixed(2)},${y0 + 9}) rotate(-38)" class="tick end">${esc(t.label)}</text>`,
      );
    } else {
      out.push(
        `<text x="${x.toFixed(2)}" y="${y0 + 16}" class="tick mid">${esc(t.label)}</text>`,
      );
    }
  }
  out.push(`<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" class="ax"/>`);
  out.push(`<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" class="ax"/>`);

  // Gate lines
  for (const g of panel.gates ?? []) {
    if (!(g.value > 0)) continue;
    const y = ys.to(g.value);
    if (y < y1 - 1 || y > y0 + 1) continue;
    out.push(
      `<line x1="${x0}" y1="${y.toFixed(2)}" x2="${x1}" y2="${y.toFixed(2)}" class="gate"/>`,
    );
    out.push(
      `<text x="${x1 - 4}" y="${(y - 4).toFixed(2)}" class="gatelbl end">${esc(g.label)}</text>`,
    );
  }

  // Non-gate reference lines
  for (const r of panel.refLines ?? []) {
    if (!(r.value > 0)) continue;
    const y = ys.to(r.value);
    if (y < y1 - 1 || y > y0 + 1) continue;
    out.push(
      `<line x1="${x0}" y1="${y.toFixed(2)}" x2="${x1}" y2="${y.toFixed(2)}" stroke="${r.color}" stroke-width="1.2" stroke-dasharray="2 3" opacity="0.85"/>`,
    );
    out.push(
      `<text x="${x0 + 4}" y="${(y - 4).toFixed(2)}" class="tick" fill="${r.color}">${esc(r.label)}</text>`,
    );
  }

  // Series.
  //
  // Everything finite is drawn. A log axis cannot represent zero or a negative
  // number, so those are drawn ON the axis floor and marked, rather than
  // skipped: a recovery error of exactly zero is a result, and a plot that
  // silently deleted it would read as a missing measurement.
  const offScale = (v: number): boolean => v <= 0 || v < ys.min || v > ys.max;
  for (const s of panel.series) {
    const pts = s.points.filter((p) => Number.isFinite(p.y));
    // Whiskers
    if (!s.noDots) {
      for (const p of pts) {
        if (!(p.lo > 0) || !(p.hi > 0) || p.n < 2) continue;
        const x = xs.to(p.x);
        out.push(
          `<line x1="${x.toFixed(2)}" y1="${ys.to(p.lo).toFixed(2)}" x2="${x.toFixed(2)}" y2="${ys.to(p.hi).toFixed(2)}" stroke="${s.color}" stroke-width="1" opacity="0.45"/>`,
        );
      }
    }
    // Median polyline
    if (pts.length > 1) {
      const d = pts
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${xs.to(p.x).toFixed(2)},${ys.to(p.y).toFixed(2)}`)
        .join(' ');
      out.push(
        `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dashed ? ' stroke-dasharray="5 4"' : ''}/>`,
      );
    }
    // Per-seed dots, then the median marker on top.
    if (!s.noDots) {
      for (const p of s.points) {
        for (const v of p.values) {
          if (!Number.isFinite(v)) continue;
          const clamped = offScale(v);
          out.push(
            `<circle cx="${xs.to(p.x).toFixed(2)}" cy="${ys.to(v).toFixed(2)}" r="${clamped ? 3 : 2}" fill="${s.color}" opacity="${clamped ? 0.9 : 0.32}"${clamped ? ` stroke="${PALETTE.gate}" stroke-width="1"` : ''}/>`,
          );
        }
      }
    }
    for (const p of pts) {
      const clamped = offScale(p.y);
      out.push(
        `<circle cx="${xs.to(p.x).toFixed(2)}" cy="${ys.to(p.y).toFixed(2)}" r="3.4" fill="${PALETTE.bg}" stroke="${clamped ? PALETTE.gate : s.color}" stroke-width="2"/>`,
      );
    }
  }

  // Axis labels
  out.push(
    `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${oy + PANEL_H - 22}" class="axlbl mid">${esc(panel.xLabel)}</text>`,
  );
  out.push(
    `<text transform="translate(${ox + 14},${((y0 + y1) / 2).toFixed(1)}) rotate(-90)" class="axlbl mid">${esc(panel.yLabel)}</text>`,
  );
  if (panel.footnote) {
    out.push(
      `<text x="${ox + 10}" y="${oy + PANEL_H - 6}" class="foot">${esc(panel.footnote)}</text>`,
    );
  }
  return out.join('\n');
}

export interface FigureSpec {
  title: string;
  /** One line under the title: what was held, and how many seeds. */
  subtitle: string;
  panels: Panel[];
  /** Legend entries, drawn once for the whole figure. */
  legend: { label: string; color: string; dashed?: boolean }[];
  /** Prose under the figure. The method note a reader needs to trust the plot. */
  caption: string[];
  /** Columns of panels. */
  columns: number;
}

export function renderFigure(spec: FigureSpec): string {
  const cols = Math.max(1, spec.columns);
  const rows = Math.ceil(spec.panels.length / cols);
  const headerH = 74;
  const legendH = 26;
  const captionH = 18 * spec.caption.length + 14;
  const width = cols * PANEL_W + 20;
  const height = headerH + legendH + rows * PANEL_H + captionH;

  const body: string[] = [];
  body.push(
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${PALETTE.bg}"/>`,
  );
  body.push(`<text x="14" y="30" class="h1">${esc(spec.title)}</text>`);
  body.push(`<text x="14" y="50" class="h2">${esc(spec.subtitle)}</text>`);

  let lx = 14;
  const ly = headerH + 6;
  for (const l of spec.legend) {
    body.push(
      `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 22}" y2="${ly - 4}" stroke="${l.color}" stroke-width="2.5"${l.dashed ? ' stroke-dasharray="5 4"' : ''}/>`,
    );
    body.push(
      `<circle cx="${lx + 11}" cy="${ly - 4}" r="3.4" fill="${PALETTE.bg}" stroke="${l.color}" stroke-width="2"/>`,
    );
    body.push(`<text x="${lx + 28}" y="${ly}" class="leg">${esc(l.label)}</text>`);
    lx += 34 + l.label.length * 6.4;
  }

  spec.panels.forEach((p, i) => {
    const cx = (i % cols) * PANEL_W + 10;
    const cy = headerH + legendH + Math.floor(i / cols) * PANEL_H;
    body.push(renderPanel(p, cx, cy));
  });

  const capY = headerH + legendH + rows * PANEL_H + 4;
  spec.caption.forEach((line, i) => {
    body.push(`<text x="14" y="${capY + 12 + i * 16}" class="cap">${esc(line)}</text>`);
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(spec.title)}">
<style>
  text { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; fill: ${PALETTE.text}; }
  .h1 { font-size: 17px; font-weight: 650; }
  .h2 { font-size: 12px; fill: ${PALETTE.muted}; }
  .ttl { font-size: 13px; font-weight: 600; }
  .sub { font-size: 10.5px; fill: ${PALETTE.muted}; }
  .tick { font-size: 10px; fill: ${PALETTE.muted}; }
  .axlbl { font-size: 11px; fill: ${PALETTE.text}; }
  .leg { font-size: 11.5px; }
  .cap { font-size: 11px; fill: ${PALETTE.muted}; }
  .foot { font-size: 10px; fill: ${PALETTE.muted}; }
  .gatelbl { font-size: 10px; fill: ${PALETTE.gate}; }
  .mid { text-anchor: middle; }
  .end { text-anchor: end; }
  .grid { stroke: ${PALETTE.grid}; stroke-width: 1; }
  .ax { stroke: ${PALETTE.axis}; stroke-width: 1; }
  .gate { stroke: ${PALETTE.gate}; stroke-width: 1.2; stroke-dasharray: 6 3; }
</style>
${body.join('\n')}
</svg>
`;
}
