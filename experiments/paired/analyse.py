"""
Paired analysis of round 1's two changes.

Design: capture ONCE per (seed, scenario), then solve four ways — the two knobs
round 1 actually moved, crossed. Same rig, same photons, same correspondences
where the decode is unchanged. Scenario variance, which swamped the unpaired
comparison at 69-182% of the metric, cancels exactly.

  noiseBins=16  round 1's POOLED decode noise estimate
  noiseBins=0   round 0's per-pixel estimate
  varComp       round 1's per-camera variance components

Each row is one solve. A pair is two rows differing in exactly one knob.
Ratios are old/new, so >1 means round 1's change HELPED.

Usage: analyse.py [log]   default: round1-paired.log, committed beside this file.
"""
import os
import re
import sys
import statistics
from collections import defaultdict

# The log this analysis was run on is committed next to it, so the default
# reproduces the published numbers from any checkout. It used to name the
# scratch directory of the session that produced it, which reproduced nowhere.
HERE = os.path.dirname(os.path.abspath(__file__))
LOG = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'round1-paired.log')

ROW = re.compile(
    r'^(\S+)\s+noiseBins=\s*(\d+)\s+varComp=(on|off)\s+pos=\s*([\d.]+)\s+rot=\s*([\d.]+)\s+'
    r'dFov=\s*([\d.]+)\s+rms=([\d.]+)\s+used=(\d+)\s+rej=(\d+)'
)

rows = []
seen = defaultdict(int)
for line in open(LOG):
    m = ROW.match(line.strip())
    if not m:
        continue
    scen, nb, vc, pos, rot, dfov, rms, used, rej = m.groups()
    # The log repeats scenarios across seeds with no seed column; the Nth
    # occurrence of a (scenario, knobs) combination is the Nth seed.
    key = (scen, nb, vc)
    seen[key] += 1
    rows.append({
        'scen': scen, 'seed': seen[key], 'nb': int(nb), 'vc': vc == 'on',
        'pos': float(pos), 'rot': float(rot), 'dfov': float(dfov),
        'rms': float(rms), 'used': int(used), 'rej': int(rej),
    })

by = {(r['scen'], r['seed'], r['nb'], r['vc']): r for r in rows}
cells = sorted({(r['scen'], r['seed']) for r in rows})

print(f'{len(rows)} solves, {len(cells)} (scenario, seed) cells\n')

# ---- Knob 1: pooled decode noise estimate --------------------------------
print('=' * 78)
print('KNOB 1  pooled decode noise estimate (round 1)  vs  per-pixel (round 0)')
print('=' * 78)
print(f"{'scenario':22s} {'seed':>4s} {'varComp':>7s} {'round0':>9s} {'round1':>9s} {'ratio':>7s} {'rej r0':>8s} {'rej r1':>8s}")
print('-' * 78)
ratios1 = []
for scen, seed in cells:
    for vc in (True, False):
        old, new = by.get((scen, seed, 0, vc)), by.get((scen, seed, 16, vc))
        if not old or not new:
            continue
        r = old['pos'] / new['pos'] if new['pos'] else float('inf')
        ratios1.append((scen, r))
        flag = '' if r >= 1 else '   <-- WORSE'
        print(f"{scen:22s} {seed:>4d} {'on' if vc else 'off':>7s} "
              f"{old['pos']:>9.2f} {new['pos']:>9.2f} {r:>7.2f}x "
              f"{old['rej']:>8d} {new['rej']:>8d}{flag}")

# ---- Knob 2: per-camera variance components ------------------------------
print()
print('=' * 78)
print('KNOB 2  per-camera variance components ON (round 1)  vs  OFF')
print('=' * 78)
print(f"{'scenario':22s} {'seed':>4s} {'noiseBins':>9s} {'off':>9s} {'on':>9s} {'ratio':>7s}")
print('-' * 78)
ratios2 = []
for scen, seed in cells:
    for nb in (16, 0):
        off, on = by.get((scen, seed, nb, False)), by.get((scen, seed, nb, True))
        if not off or not on:
            continue
        r = off['pos'] / on['pos'] if on['pos'] else float('inf')
        ratios2.append((scen, r))
        flag = '' if r >= 0.995 else '   <-- WORSE'
        print(f"{scen:22s} {seed:>4d} {nb:>9d} {off['pos']:>9.2f} {on['pos']:>9.2f} {r:>7.2f}x{flag}")


def verdict(name, ratios):
    if not ratios:
        return
    vals = [r for _, r in ratios]
    helped = sum(1 for v in vals if v > 1.02)
    hurt = sum(1 for v in vals if v < 0.98)
    print(f'\n{name}')
    print(f'  pairs: {len(vals)}   median ratio: {statistics.median(vals):.2f}x   '
          f'range: {min(vals):.2f}x - {max(vals):.2f}x')
    print(f'  helped {helped}, hurt {hurt}, neutral {len(vals) - helped - hurt}')
    worst = min(ratios, key=lambda x: x[1])
    if worst[1] < 0.98:
        print(f'  worst case: {worst[0]} at {worst[1]:.2f}x')


print('\n' + '=' * 78)
verdict('KNOB 1 — pooled decode noise estimate', ratios1)
verdict('KNOB 2 — per-camera variance components', ratios2)
