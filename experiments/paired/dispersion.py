"""
Has Phase 1 stopped moving?

docs/ARCHITECTURE.md defines the stopping condition:

    a round is non-improving when no gate-facing metric's round-over-round
    change exceeds its own run-to-run dispersion across seeds.

So the test needs two quantities per gate:

  DISPERSION  the spread of the scored statistic across seeds with the CODE
              HELD FIXED. This is the measurement's own noise floor — how much
              a number moves when nothing changed.
  DELTA       how much the same statistic moved between round 0 and round 1,
              i.e. what a round of actual work bought.

If |DELTA| < DISPERSION the round is indistinguishable from re-rolling the
dice, and the loop is chasing noise rather than improving anything.

Every gate is scored on its WORST scenario (`gates.gates[].worst.value`), so
that is the statistic compared. Comparing medians would flatter the result:
the distribution is bimodal by construction and the median hides the tail.
"""
import json
import glob
import statistics
import sys

CONV = '/tmp/claude-0/-home-user-sphere-sim/b37221d0-dbb7-5aca-a9ab-085305f51107/scratchpad/conv'


def gates_of(path):
    d = json.load(open(path))
    out = {}
    for g in d['gates']['gates']:
        w = g.get('worst') or {}
        v = w.get('value')
        if v is not None:
            out[g['id']] = (v, g.get('max'), g.get('unit', ''))
    return out


seed_files = sorted(glob.glob(f'{CONV}/seed-*.json'))
if len(seed_files) < 3:
    sys.exit(f'need >=3 seed runs, found {len(seed_files)}')

runs = [gates_of(f) for f in seed_files]
ids = [i for i in runs[0] if all(i in r for r in runs)]

# Round 0 -> round 1 deltas, measured by the independent critic on the
# builder's own seed, before and after round 1's decode changes.
ROUND_DELTA = {
    'pose_position':     (392.33, 504.31),
    'pose_rotation':     (6.75, 4.70),
    'h_center_recovery': (43.17, 43.17),
    'grid_displacement': (12.91, 18.92),
}

print(f'Across-seed dispersion, code held fixed, {len(seed_files)} seeds x 6 scenarios')
print(f'Scored statistic: the WORST scenario per gate, which is what the gate judges.\n')
hdr = f"{'gate':22s} {'gate':>9s} {'min':>10s} {'median':>10s} {'max':>10s} {'spread':>10s} {'spread/med':>10s}"
print(hdr)
print('-' * len(hdr))

disp = {}
for i in ids:
    vals = [r[i][0] for r in runs]
    lim, unit = runs[0][i][1], runs[0][i][2]
    lo, hi = min(vals), max(vals)
    med = statistics.median(vals)
    spread = hi - lo
    disp[i] = spread
    rel = f'{spread/med:8.1%}' if med else '     n/a'
    print(f'{i:22s} {lim:>9g} {lo:>10.3f} {med:>10.3f} {hi:>10.3f} {spread:>10.3f} {rel:>10s}')

print('\n\nRound 0 -> round 1: did the work move a number further than the dice do?\n')
hdr2 = f"{'gate':22s} {'round0':>10s} {'round1':>10s} {'delta':>10s} {'dispersion':>11s}  verdict"
print(hdr2)
print('-' * len(hdr2))

verdicts = []
for gid, (before, after) in ROUND_DELTA.items():
    if gid not in disp:
        continue
    delta = after - before
    d = disp[gid]
    if abs(delta) < d:
        v = 'INDISTINGUISHABLE from seed noise'
    elif delta < 0:
        v = 'real improvement'
    else:
        v = 'real REGRESSION'
    verdicts.append((gid, v))
    print(f'{gid:22s} {before:>10.2f} {after:>10.2f} {delta:>+10.2f} {d:>11.3f}  {v}')

print()
noise = sum(1 for _, v in verdicts if v.startswith('INDIST'))
print(f'{noise} of {len(verdicts)} gate-facing metrics moved less than their own seed noise.')
