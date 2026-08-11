/**
 * The figures.
 *
 * A figure is the part of an experiment that travels: it gets pasted into a
 * document, opened on a laptop in a room with no network, and read by somebody who
 * will never open the JSON. So three things are asserted, and the first two are here
 * because both have already gone wrong once.
 *
 *  1. **It is well-formed XML.** The first version of `plot.ts` put a font stack
 *     containing double quotes inside a double-quoted attribute, which produced a
 *     file that every check passed and no browser would render. There is no XML
 *     parser in the Node standard library, so this file carries a small one.
 *  2. **No NaN, no undefined, no Infinity reaches a coordinate.** A threshold the
 *     sweep never crossed is `Infinity` by design, and a polyline with `Infinity` in
 *     it silently disappears.
 *  3. **The word PROVISIONAL is on the face of the figure.** docs/ARCHITECTURE.md's
 *     phase gate requires it on every photometric output, and a figure separated from
 *     its document has nothing else to carry the warning.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderExperiment2Svg, renderExperiment3Svg } from '../src/photometric/plot.ts';
import { runExperiment2 } from '../src/photometric/experiment2.ts';
import { runExperiment3 } from '../src/photometric/experiment3.ts';

// A reduced grid, run once and shared. The published figures come from the full
// sweep in `photometric/cli.ts`; what these tests check is the RENDERER, and a
// renderer that works on four widths works on eleven. Both results carry the grid
// they were run on, so nothing here can be mistaken for the published measurement.
const result2 = runExperiment2({
  grid: { widthsDeg: [5, 12, 20, 40], registrationMm: [1, 4, 16], shapes: ['linear', 'cosine'] },
});
const result3 = runExperiment3({ levels: 3, maxInteractionIds: 0 });

/**
 * A minimal XML well-formedness check: every tag closes, attribute values are
 * quoted and contain no bare quote of their own delimiter, and text carries no raw
 * `<`. Enough to catch the class of bug that produced an unrenderable figure.
 */
function assertWellFormed(svg: string): void {
  const stack: string[] = [];
  let i = 0;
  while (i < svg.length) {
    const lt = svg.indexOf('<', i);
    if (lt < 0) break;
    const text = svg.slice(i, lt);
    assert.ok(!text.includes('>'), `raw '>' in text content near: ${text.slice(0, 40)}`);
    let j = lt + 1;
    let closing = false;
    if (svg[j] === '/') {
      closing = true;
      j++;
    }
    let name = '';
    while (j < svg.length && /[A-Za-z0-9:_-]/.test(svg[j])) name += svg[j++];
    assert.ok(name.length > 0, `unnamed tag at ${lt}`);
    // Walk the attributes, honouring quoted values.
    let selfClosing = false;
    while (j < svg.length && svg[j] !== '>') {
      if (svg[j] === '"') {
        const end = svg.indexOf('"', j + 1);
        assert.ok(end > 0, `unterminated attribute value in <${name}>`);
        j = end + 1;
        continue;
      }
      if (svg[j] === '/') selfClosing = true;
      j++;
    }
    assert.ok(j < svg.length, `unterminated tag <${name}>`);
    if (closing) {
      const open = stack.pop();
      assert.equal(open, name, `</${name}> closes <${open}>`);
    } else if (!selfClosing) {
      stack.push(name);
    }
    i = j + 1;
  }
  assert.deepEqual(stack, [], `unclosed elements: ${stack.join(', ')}`);
}

/**
 * Nothing is drawn outside the frame.
 *
 * SVG does not wrap text and does not clip by default, so a caption longer than the
 * figure runs off the edge and is simply gone — which happened to the first
 * Experiment 3 header, and is invisible to every other check in this file. Text width
 * is estimated at 0.52 em per character, which is generous for a UI sans and is used
 * only to catch gross overflow rather than to lay anything out.
 */
function assertInsideFrame(svg: string, label: string): void {
  const box = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  assert.ok(box !== null, `${label} has no viewBox`);
  const width = Number(box[1]);
  const height = Number(box[2]);

  const check = (fragment: string, ox: number, oy: number): void => {
    const texts = fragment.matchAll(
      /<text x="([-\d.]+)" y="([-\d.]+)"[^>]*font-size="([\d.]+)"[^>]*text-anchor="(\w+)"([^>]*)>([^<]*)</g,
    );
    for (const t of texts) {
      if (t[5].includes('rotate')) continue; // Rotated labels need a different box.
      const x = Number(t[1]) + ox;
      const y = Number(t[2]) + oy;
      const w = t[6].length * Number(t[3]) * 0.52;
      const anchor = t[4];
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      assert.ok(
        x0 >= -1 && x0 + w <= width + 1 && y >= 0 && y <= height,
        `${label}: "${t[6].slice(0, 48)}" runs outside the ${width}x${height} frame`,
      );
    }
    for (const rect of fragment.matchAll(
      /<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g,
    )) {
      const x = Number(rect[1]) + ox;
      const y = Number(rect[2]) + oy;
      assert.ok(
        x >= -1 && y >= -1 && x + Number(rect[3]) <= width + 1 && y + Number(rect[4]) <= height + 1,
        `${label}: a rect at ${x},${y} leaves the ${width}x${height} frame`,
      );
    }
  };

  let rest = svg;
  for (const g of svg.matchAll(/<g transform="translate\(([-\d.]+) ([-\d.]+)\)">([\s\S]*?)<\/g>/g)) {
    check(g[3], Number(g[1]), Number(g[2]));
    rest = rest.replace(g[0], '');
  }
  check(rest, 0, 0);
}

function assertPlottable(svg: string, label: string): void {
  assertInsideFrame(svg, label);
  for (const bad of ['NaN', 'undefined', 'Infinity']) {
    assert.ok(!svg.includes(bad), `${label} contains ${bad}`);
  }
  assert.ok(svg.includes('PROVISIONAL'), `${label} does not say PROVISIONAL`);
  assert.ok(!svg.includes('http://') || svg.includes('http://www.w3.org/2000/svg'));
  // Self-contained: no external reference of any kind.
  assert.ok(!/<image|xlink:href|<script|@import/.test(svg), `${label} reaches outside itself`);
}

test('the Experiment 2 figure is well-formed, self-contained and marked', () => {
  const result = result2;
  const svg = renderExperiment2Svg(result);
  assertWellFormed(svg);
  assertPlottable(svg, 'experiment 2');
  // Every cell of the sweep is drawn, plus the panel frames and the legend swatches.
  const rects = svg.match(/<rect /g)?.length ?? 0;
  assert.ok(rects >= result.cells.length, `${rects} rects for ${result.cells.length} cells`);
});

test('the Experiment 3 figure separates stated ranges from invented ones', () => {
  const result = result3;
  const svg = renderExperiment3Svg(result);
  assertWellFormed(svg);
  assertPlottable(svg, 'experiment 3');
  assert.ok(svg.includes('STATES'), 'the stated-range panel is not labelled');
  assert.ok(svg.includes('INVENTED'), 'the invented-range panel is not labelled');
  assert.ok(svg.includes('A-04'), 'the invented ranges do not cite the amendment that records them');
  // Every swept parameter appears in one panel or the other, none in both.
  assert.equal(
    result.rankedStated.length + result.rankedInferred.length,
    result.parameters.length,
  );
  for (const id of result.rankedStated) assert.ok(!result.rankedInferred.includes(id));
});

test('a threshold the sweep never reached is drawn as absent, not as a number', () => {
  const result = result2;
  const unreached = result.contours.filter((c) => !Number.isFinite(c.chromaToleranceMm));
  const svg = renderExperiment2Svg(result);
  assertWellFormed(svg);
  // Whether any contour ran off the sweep is data-dependent; what must hold either
  // way is that the figure never invents a coordinate for one.
  assert.ok(!svg.includes('Infinity'));
  if (unreached.length > 0) {
    assert.ok(svg.includes('§7 chromaticity gate'), 'the key must still explain the missing line');
  }
});

/** Guards against a future edit that silently drops the falsification record. */
test('the Experiment 2 figure states the verdict it computed', () => {
  const svg = renderExperiment2Svg(result2);
  assert.ok(svg.includes('Verdict:'));
  assert.ok(
    svg.includes(result2.verdict.holds ? 'HOLDS' : 'DOES NOT hold'),
    'the figure and the results file disagree about the verdict',
  );
});
