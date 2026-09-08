// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `local_sos_config.json` — the reader, and the writer that puts a recovered
 * calibration back into it.
 *
 * The fixture below is written in the real file's own style rather than in
 * tidied JSON, because three of its quirks are what the code has to survive:
 * keys spelled inconsistently (`P1_DIST_INCHES` beside `P1_Height_Inches`) where
 * `envName` is consistent, doubles printed to seventeen significant digits, and
 * long prose descriptions carrying the braces and quotes a text patcher has to
 * step over.
 *
 * The test that matters most is the one where the writer changes NOTHING. A
 * calibration that recovers real per-projector pose error produces an empty
 * config patch, because the two numbers per projector this file can hold were
 * already right and everything that was wrong has no field. That is the format's
 * ceiling stated as a measurement instead of as a paragraph.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { RigCalibration } from '../../calibration/src/index.ts';
import { nominalRig } from '../src/scene.ts';
import { prepareRig } from '../src/optics.ts';
import {
  formatSosConfig,
  parseSosConfig,
  readSosConfigGeometry,
  sosConfigDefault,
  updateSosConfig,
} from '../src/sosconfig.ts';

const IN = 0.0254;

/**
 * Four projectors and the sphere, in the shape and spacing the real file uses.
 *
 * `P1_Height_Inches` is deliberately spelled the way the real file spells it —
 * mixed case where its neighbour is upper — and one description carries an
 * escaped quote and a brace, which is what the patcher's brace matching is for.
 */
const FIXTURE = `{
	"P1_DIST_INCHES" :
	{
		"boxType" : "TEXTBOX",
		"dataType" : "DOUBLE",
		"description" : "Horizontal distance, in inches, of projector 1 from the sphere center.  <br><br> Default Value: <br> 211.0",
		"displayName" : "Projector 1 Distance",
		"envName" : "P1_DIST_INCHES",
		"group" : "Exhibit Distances",
		"options" : "NONE",
		"value" : 213.5
	},
	"P1_Height_Inches" :
	{
		"boxType" : "TEXTBOX",
		"dataType" : "DOUBLE",
		"description" : "Measured height of projector 1 lens, in inches. By experience: 1 inch lower than real height makes better alignment.  <br><br> Default Value: <br> 92.0",
		"displayName" : "Projector 1 Height",
		"envName" : "P1_HEIGHT_INCHES",
		"group" : "Exhibit Distances",
		"options" : "NONE",
		"value" : 100.5
	},
	"P2_DIST_INCHES" :
	{
		"dataType" : "DOUBLE",
		"description" : "Horizontal distance, in inches, of projector 2 from the sphere center. <br><br> Default Value: <br> 211.0",
		"envName" : "P2_DIST_INCHES",
		"value" : 212.25
	},
	"P2_Height_Inches" :
	{
		"dataType" : "DOUBLE",
		"description" : "Measured height of projector 2 lens, in inches. <br><br> Default Value: <br> 92.0",
		"envName" : "P2_HEIGHT_INCHES",
		"value" : 101.25
	},
	"P3_DIST_INCHES" :
	{
		"description" : "Horizontal distance, in inches, of projector 3 from the sphere center. <br><br> Default Value: <br> 211.0",
		"envName" : "P3_DIST_INCHES",
		"value" : 209.09999999999999
	},
	"P3_Height_Inches" :
	{
		"description" : "Measured height of projector 3 lens. <br><br> Default Value: <br> 92.0",
		"envName" : "P3_HEIGHT_INCHES",
		"value" : 100.25
	},
	"P4_DIST_INCHES" :
	{
		"description" : "Horizontal distance, in inches, of projector 4 from the sphere center. <br><br> Default Value: <br> 211.0",
		"envName" : "P4_DIST_INCHES",
		"value" : 209.0
	},
	"P4_Height_Inches" :
	{
		"description" : "Measured height of projector 4 lens. <br><br> Default Value: <br> 92.0",
		"envName" : "P4_HEIGHT_INCHES",
		"value" : 100.09999999999999
	},
	"Sphere_Height_At_Equator_Inches" :
	{
		"description" : "Measured height, in inches, of the equator from the floor.  <br><br> Default Value: <br> 84.0",
		"envName" : "SPHERE_HEIGHT_AT_EQUATOR_INCHES",
		"value" : 88.0
	},
	"sphere_radius_inches" :
	{
		"description" : "Standard radius of the sphere.  <br><br> Default Value: <br> 34.0",
		"envName" : "SPHERE_RADIUS_INCHES",
		"value" : 34.0
	},
	"projectorRotation" :
	{
		"description" : "Sets where 0 degrees longitude appears. Values range from 0 - 360 degrees.<br><br> Default Value: <br> 0",
		"envName" : "PROJECTOR_ROTATION",
		"value" : 45.0
	},
	"bottommask" :
	{
		"description" : "A mask of {60,70} means clip below 70. The first \\"value\\" is a low latitude.  <br><br> Default Value: <br> 60,70",
		"envName" : "BOTTOM_MASK",
		"value" : "60,70"
	}
}
`;

const SITE_DIST_IN = [213.5, 212.25, 209.1, 209.0];
const SITE_HEIGHT_IN = [100.5, 101.25, 100.25, 100.1];
const SITE_EQUATOR_IN = 88.0;

/** A rig placed exactly where the fixture's config says the projectors are. */
function rigMatchingFixture(mutate: (rig: RigCalibration) => void = () => {}): RigCalibration {
  const rig = nominalRig({
    distanceM: 211 * IN,
    centerHeightM: SITE_EQUATOR_IN * IN,
    projectorHeightM: 100 * IN,
  });
  rig.projectors.forEach((p, i) => {
    const az = ((90 * i) * Math.PI) / 180;
    p.pose.position = {
      x: SITE_DIST_IN[i] * IN * Math.cos(az),
      y: SITE_DIST_IN[i] * IN * Math.sin(az),
      z: (SITE_HEIGHT_IN[i] - SITE_EQUATOR_IN) * IN,
    };
  });
  mutate(rig);
  return rig;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test('the site’s values and the factory defaults are read apart, because they differ', () => {
  // A-39: three constants entered this project's spec as NOAA Boulder's live
  // config and were, exactly, the defaults printed inside the descriptions. The
  // two live in the same entry, one in `value` and one in prose, and reading the
  // wrong one produces plausible numbers for a different installation.
  const g = readSosConfigGeometry(parseSosConfig(FIXTURE));
  assert.deepEqual(g.distanceIn, SITE_DIST_IN);
  assert.deepEqual(g.heightIn, SITE_HEIGHT_IN);
  assert.equal(g.equatorHeightIn, 88);
  assert.equal(g.sphereRadiusIn, 34);
  assert.equal(g.rotationDeg, 45);

  assert.deepEqual(g.defaults.distanceIn, [211, 211, 211, 211]);
  assert.deepEqual(g.defaults.heightIn, [92, 92, 92, 92]);
  assert.equal(g.defaults.equatorHeightIn, 84);
  // The one place they agree, which is why the radius is not part of A-39.
  assert.equal(g.defaults.sphereRadiusIn, 34);
});

test('a default is read out of prose whatever the markup around it', () => {
  assert.equal(sosConfigDefault({ description: 'x <br><br> Default Value: <br> 211.0', value: 0 }), 211);
  assert.equal(sosConfigDefault({ description: 'Default Value: 84', value: 0 }), 84);
  assert.equal(sosConfigDefault({ description: 'no default here', value: 0 }), null);
  assert.equal(sosConfigDefault({ value: 0 }), null);
});

test('the parser refuses anything that is not this file', () => {
  assert.throws(() => parseSosConfig('[]'), /object of named settings/);
  assert.throws(() => parseSosConfig('{}'), /no settings/);
  assert.throws(() => parseSosConfig('{"a": 1}'), /is not an object/);
  assert.throws(() => parseSosConfig('{"a": {"envName": "A"}}'), /has no value/);
  assert.throws(() => parseSosConfig('not json'), SyntaxError);
});

// ---------------------------------------------------------------------------
// What the writer puts back, and what it cannot
// ---------------------------------------------------------------------------

test('the distance written is HORIZONTAL, not the slant range to the lens', () => {
  // The file's own words, and A-17 records that this repository's two
  // `nominalRig` builders disagree on exactly this. A slant range reads high by
  // `d - sqrt(d^2 - z^2)` — at a 12 inch rise on a 211 inch throw that is 0.36
  // in, which is small, plausible, and biased the same way every time.
  const config = parseSosConfig(FIXTURE);
  const rig = nominalRig({
    distanceM: 200 * IN,
    centerHeightM: 88 * IN,
    projectorHeightM: 130 * IN, // a 42 inch rise, so the two readings differ visibly
  });
  const up = updateSosConfig(config, prepareRig(rig));
  const p1 = up.changed.find((c) => c.envName === 'P1_DIST_INCHES');
  assert.ok(p1, 'no distance was proposed');
  assert.ok(Math.abs(p1.to - 200) < 1e-6, `${p1.to}`);
  const slant = Math.hypot(200, 42);
  assert.ok(Math.abs(p1.to - slant) > 4, 'the slant range was written instead');

  // And the height is above the FLOOR, not above the body's centre — the world
  // frame puts the centre at the origin, so the two differ by the equator height.
  const h1 = up.changed.find((c) => c.envName === 'P1_HEIGHT_INCHES');
  assert.ok(h1, 'no height was proposed');
  assert.ok(Math.abs(h1.to - 130) < 1e-6, `${h1.to}`);
});

test('a calibration that found real pose error changes nothing in the config', () => {
  // The headline, and the format's ceiling as a measurement rather than a
  // paragraph. The rig below sits exactly where the config says it does on the
  // two numbers the config can hold, and is wrong by more than a degree on three
  // things it cannot: azimuth off its quadrant, aim off the body's centre, roll.
  //
  // The patch is empty. An operator handed only a rewritten config would see a
  // zero-line diff and conclude the calibration found nothing.
  const config = parseSosConfig(FIXTURE);
  const rig = rigMatchingFixture((r) => {
    const az = [1.2, -0.8, 0.4, -1.6];
    r.projectors.forEach((p, i) => {
      const a = ((90 * i + az[i]) * Math.PI) / 180;
      const d = SITE_DIST_IN[i] * IN;
      p.pose.position = { x: d * Math.cos(a), y: d * Math.sin(a), z: p.pose.position.z };
      p.pose.yawDeg += [0.3, -0.5, 0.2, 0.1][i];
      p.pose.rollDeg = [0.7, -0.4, 1.1, 0.2][i];
    });
  });
  const up = updateSosConfig(config, prepareRig(rig));

  assert.deepEqual(up.changed, [], 'the config moved when nothing it can hold had moved');
  assert.deepEqual(up.missing, []);

  // Every one of these is real, recovered, and unwritable.
  up.discarded.azimuthDeg.forEach((v, i) => {
    assert.ok(v !== null && Math.abs(v - [1.2, -0.8, 0.4, -1.6][i]) < 1e-6, `azimuth ${i}: ${v}`);
  });
  assert.deepEqual(up.discarded.rollDeg, [0.7, -0.4, 1.1, 0.2]);
  assert.ok(up.discarded.worstAngleDeg > 1.5, `${up.discarded.worstAngleDeg}`);
  // The aim is off the centre on every projector, because a yaw was added to a
  // pose the nominal builder had pointing at it.
  assert.ok(
    up.discarded.aimOffAxisDeg.every((v) => v > 0.05),
    `${up.discarded.aimOffAxisDeg.join(',')}`,
  );
  // And the field of view, which the config derives from distance and radius and
  // never stores, so a recovered focal length has nowhere to go either.
  assert.ok(up.discarded.fovHDeg.every((v) => v > 1));
});

test('a rig the config disagrees with produces one change per number', () => {
  const config = parseSosConfig(FIXTURE);
  // The SOS defaults, which is what this config would say if nobody had measured.
  const rig = nominalRig({
    distanceM: 211 * IN,
    centerHeightM: 84 * IN,
    projectorHeightM: 92 * IN,
  });
  const up = updateSosConfig(config, prepareRig(rig));
  assert.equal(up.changed.length, 9, up.changed.map((c) => c.envName).join(','));
  const eq = up.changed.find((c) => c.envName === 'SPHERE_HEIGHT_AT_EQUATOR_INCHES');
  assert.ok(eq && eq.from === 88 && Math.abs(eq.to - 84) < 1e-9);
});

test('a projector is named by its own slot, never by its place in the array', () => {
  // A rig with a projector switched off is SHORTER, and the remaining lenses keep
  // their slot names: two projectors are P1 and P3, at array indices 0 and 1.
  // Naming the config entries by index writes P3's geometry into P2's row — a
  // file that loads cleanly and aims a projector at the wrong quarter of the room.
  const config = parseSosConfig(FIXTURE);
  const two = nominalRig({ projectorCount: 2, distanceM: 150 * IN, centerHeightM: 88 * IN });
  assert.deepEqual(
    two.projectors.map((p) => p.id),
    ['P1', 'P3'],
    'the fixture for this test no longer exercises the gap it exists for',
  );
  const up = updateSosConfig(config, prepareRig(two));
  const touched = up.changed.map((c) => c.envName).sort();
  // The equator height is absent because this rig agrees with the file on it,
  // which is the same skip-what-already-matches rule the empty-patch test rests
  // on — the distances moved, so those four rows are the whole change.
  assert.deepEqual(touched, [
    'P1_DIST_INCHES',
    'P1_HEIGHT_INCHES',
    'P3_DIST_INCHES',
    'P3_HEIGHT_INCHES',
  ]);
  assert.ok(!touched.includes('P2_DIST_INCHES'), 'the switched-off projector’s row was written');

  // And the discarded azimuth is measured against P3's own quadrant, 180, not
  // against the 90 its array position would imply.
  assert.equal(up.discarded.azimuthDeg.length, 2);
  up.discarded.azimuthDeg.forEach((v) => assert.ok(v !== null && Math.abs(v) < 1e-9, `${v}`));
});

test('a hand-placed projector has no row, and is reported rather than guessed at', () => {
  const config = parseSosConfig(FIXTURE);
  const rig = nominalRig({ distanceM: 150 * IN, centerHeightM: 88 * IN });
  rig.projectors[1].id = 'left-truss';
  const up = updateSosConfig(config, prepareRig(rig));
  assert.ok(up.missing.includes('left-truss_DIST_INCHES'), up.missing.join(','));
  assert.ok(!up.changed.some((c) => c.envName.startsWith('P2')), 'P2’s row was written anyway');

  // `SosConfigDiscard` promises rig order, and a projector with no config row
  // still has a roll and an aim the config cannot hold. Returning early used to
  // shorten three of the four arrays, so a hand-placed rig reported LESS
  // discarded than it discarded — the one direction this report must not err in.
  const d = up.discarded;
  for (const arr of [d.aimOffAxisDeg, d.rollDeg, d.fovHDeg, d.azimuthDeg]) {
    assert.equal(arr.length, rig.projectors.length, 'a discard array is short');
  }
  // And the one quantity that genuinely has no answer says so, rather than
  // reporting a zero that would read as "exactly where the config expects".
  assert.equal(d.azimuthDeg[1], null);
  assert.ok(d.azimuthDeg.filter((v) => v !== null).length === rig.projectors.length - 1);
  assert.ok(Number.isFinite(d.fovHDeg[1]) && d.fovHDeg[1] > 1, 'the hand-placed lens was dropped');
});

test('settings the rig has an answer for that the file lacks are reported, not invented', () => {
  const trimmed = parseSosConfig(FIXTURE);
  delete trimmed.P3_DIST_INCHES;
  const up = updateSosConfig(trimmed, prepareRig(nominalRig({ distanceM: 100 * IN })));
  assert.ok(up.missing.includes('P3_DIST_INCHES'), up.missing.join(','));
  assert.ok(!up.changed.some((c) => c.envName === 'P3_DIST_INCHES'));
});

// ---------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------

test('the output differs from the input on exactly the lines that changed', () => {
  // A surgical edit, not a re-serialization. An operator about to load a
  // generated config into a running exhibit will diff it, and a whole-file
  // reformat tells them nothing — so the diff has to be the numbers and only
  // the numbers.
  const config = parseSosConfig(FIXTURE);
  const rig = nominalRig({ distanceM: 211 * IN, centerHeightM: 84 * IN, projectorHeightM: 92 * IN });
  const up = updateSosConfig(config, prepareRig(rig));
  const out = formatSosConfig(FIXTURE, up);

  const before = FIXTURE.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length, 'the patch changed the line count');
  const differing = before.filter((line, i) => line !== after[i]);
  assert.equal(differing.length, up.changed.length, differing.join(' | '));
  for (const line of differing) assert.match(line, /"value" :/);

  // Still the same file, with the new numbers in it.
  const round = readSosConfigGeometry(parseSosConfig(out));
  assert.deepEqual(round.distanceIn, [211, 211, 211, 211]);
  assert.deepEqual(round.heightIn, [92, 92, 92, 92]);
  assert.equal(round.equatorHeightIn, 84);
  // Untouched entries keep their values, including the one whose description
  // carries an escaped quote and a brace — the brace matcher has to step over
  // both to find the right object, and a global replace would have hit it.
  assert.equal(round.rotationDeg, 45);
  assert.equal(round.sphereRadiusIn, 34);
  assert.ok(out.includes('"value" : "60,70"'), 'the mask entry was rewritten');
  assert.ok(out.includes('A mask of {60,70} means clip below 70'), 'the prose was damaged');
});

test('a key name that also appears inside a string is not mistaken for the key', () => {
  // The same quoted name appears as an `envName` VALUE in every entry, and can
  // appear escaped inside a description. A plain indexOf finds whichever comes
  // first in the file, and would patch a value that is not the one asked for.
  const decoy = FIXTURE.replace(
    '"description" : "Standard radius of the sphere.',
    '"description" : "See \\"P4_DIST_INCHES\\" : { } for the throw. Standard radius of the sphere.',
  );
  assert.ok(decoy !== FIXTURE, 'the decoy was not inserted');
  const config = parseSosConfig(decoy);
  const rig = nominalRig({ distanceM: 150 * IN, centerHeightM: 88 * IN, projectorHeightM: 100 * IN });
  const out = formatSosConfig(decoy, updateSosConfig(config, prepareRig(rig)));
  const g = readSosConfigGeometry(parseSosConfig(out));
  assert.ok(Math.abs((g.distanceIn[3] ?? 0) - 150) < 1e-9, `P4 got ${String(g.distanceIn[3])}`);
  assert.equal(g.sphereRadiusIn, 34, 'the decoy entry was patched instead');
  assert.ok(out.includes('See \\"P4_DIST_INCHES\\" : { } for the throw'), 'the prose was damaged');
});

test('an integer keeps a decimal point, because the file declares these DOUBLE', () => {
  const config = parseSosConfig(FIXTURE);
  const rig = nominalRig({ distanceM: 211 * IN, centerHeightM: 84 * IN, projectorHeightM: 92 * IN });
  const out = formatSosConfig(FIXTURE, updateSosConfig(config, prepareRig(rig)));
  assert.ok(out.includes('"value" : 211.0'), 'a whole number lost its decimal point');
  assert.ok(!/"value" : 211\b(?!\.)/.test(out), 'a bare integer was written');
});

test('a nested value of the same name is not mistaken for the setting’s own', () => {
  // `parseSosConfig` deliberately admits nested metadata this project has never
  // seen, so a setting may legitimately contain an inner object with its own
  // `value`. Replacing the first `"value"` inside the entry hits that one first
  // and leaves the live number untouched — valid JSON, wrong file.
  const nested = FIXTURE.replace(
    '\t\t"envName" : "P4_DIST_INCHES",\n\t\t"value" : 209.0',
    '\t\t"envName" : "P4_DIST_INCHES",\n\t\t"metadata" :\n\t\t{\n\t\t\t"value" : 1.0\n\t\t},\n\t\t"value" : 209.0',
  );
  assert.ok(nested !== FIXTURE, 'the nested object was not inserted');
  const rig = nominalRig({ distanceM: 150 * IN, centerHeightM: 88 * IN, projectorHeightM: 100 * IN });
  const out = formatSosConfig(nested, updateSosConfig(parseSosConfig(nested), prepareRig(rig)));

  const g = readSosConfigGeometry(parseSosConfig(out));
  assert.ok(Math.abs((g.distanceIn[3] ?? 0) - 150) < 1e-9, `P4 got ${String(g.distanceIn[3])}`);
  assert.ok(out.includes('"value" : 1.0'), 'the nested metadata was patched instead');
});

test('a same-named key nested inside an earlier setting is not the setting', () => {
  // The depth rule, from the other side. A nested property sits after a `{` just
  // as a top-level key does, so "preceded by a brace or comma" is not enough —
  // only the depth says which is the setting.
  const decoy = FIXTURE.replace(
    '\t"P4_DIST_INCHES" :\n\t{\n',
    '\t"P4_DIST_INCHES" :\n\t{\n\t\t"extra" :\n\t\t{\n\t\t\t"P1_DIST_INCHES" : 1.0\n\t\t},\n',
  );
  assert.ok(decoy !== FIXTURE, 'the decoy was not inserted');
  const rig = nominalRig({ distanceM: 150 * IN, centerHeightM: 88 * IN, projectorHeightM: 100 * IN });
  const out = formatSosConfig(decoy, updateSosConfig(parseSosConfig(decoy), prepareRig(rig)));
  const g = readSosConfigGeometry(parseSosConfig(out));
  assert.ok(Math.abs((g.distanceIn[0] ?? 0) - 150) < 1e-9, `P1 got ${String(g.distanceIn[0])}`);
  assert.ok(out.includes('"P1_DIST_INCHES" : 1.0'), 'the nested decoy was patched');
});

test('a patch that cannot be applied whole is not applied at all', () => {
  // A config that got three of its twelve numbers is worse than one that got
  // none, because it is still loadable and still wrong.
  const config = parseSosConfig(FIXTURE);
  const rig = nominalRig({ distanceM: 211 * IN, centerHeightM: 84 * IN, projectorHeightM: 92 * IN });
  const up = updateSosConfig(config, prepareRig(rig));
  assert.ok(up.changed.length > 1);
  assert.throws(
    () => formatSosConfig('{"other" : {"value" : 1}}', up),
    /has no top-level numeric value in this text/,
  );
});

test('a rig that already agrees writes the file back byte for byte', () => {
  const config = parseSosConfig(FIXTURE);
  const up = updateSosConfig(config, prepareRig(rigMatchingFixture()));
  assert.deepEqual(up.changed, []);
  assert.equal(formatSosConfig(FIXTURE, up), FIXTURE);
});
