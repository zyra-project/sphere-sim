"""
Paired analysis of round 2, on fresh seeds.

Design, unchanged from round 1 and for the same reason: capture ONCE per
(seed, scenario), then solve several ways with one knob moved. Scenario
variance — 69-182% of the metric across seeds with the code held fixed —
cancels exactly, so a ratio between two rows of the same cell measures the knob
and not the draw.

Reads a log whose rows are

  <seed> <scenario> <variant> pos=.. rot=.. grid=.. fovBias=.. fovSpr=.. ...

Ratios are baseline/variant, so >1 means the variant HELPED.

Usage:  python3 experiments/paired/round2.py <log> <baseline-variant>
"""
import re
import sys
import statistics
from collections import defaultdict

ROW = re.compile(
    r'^(\d+)\s+(\S+)\s+(\S+)\s+pos=\s*([-\d.]+)\s+rot=\s*([-\d.]+)\s+grid=\s*([-\d.]+)\s+'
    r'fovBias=\s*([-\d.]+)\s+fovSpr=\s*([-\d.]+)\s+sprRec=\s*([-\d.]+)\s+sprTru=\s*([-\d.]+)'
)

log = sys.argv[1]
baseline = sys.argv[2]

rows = {}
variants = []
scenarios = []
for line in open(log):
    m = ROW.match(line.strip())
    if not m:
        continue
    seed, scen, var, pos, rot, grid, fb, fs, sr, st = m.groups()
    rows[(int(seed), scen, var)] = {
        'pos': float(pos), 'rot': float(rot), 'grid': float(grid),
        'fovBias': float(fb), 'fovSpr': float(fs),
        'sprRec': float(sr), 'sprTru': float(st),
    }
    if var not in variants:
        variants.append(var)
    if scen not in scenarios:
        scenarios.append(scen)

seeds = sorted({k[0] for k in rows})
print(f'{len(rows)} solves, {len(seeds)} seeds, {len(scenarios)} scenarios, '
      f'{len(variants)} variants')
print()

# --- the fov error decomposition: common mode against differential -----------
print('=' * 96)
print('FOV ERROR DECOMPOSITION, baseline variant only')
print('  |bias| = |mean over projectors of (recovered - true) fov|   COMMON MODE')
print('  spread = sd over projectors of the same quantity            DIFFERENTIAL')
print('=' * 96)
print(f"{'scenario':22s} {'|bias| med':>11s} {'spread med':>11s} {'ratio':>8s}"
      f" {'true spread':>12s}")
print('-' * 96)
for scen in scenarios:
    b = [abs(rows[(s, scen, baseline)]['fovBias']) for s in seeds
         if (s, scen, baseline) in rows]
    sp = [rows[(s, scen, baseline)]['fovSpr'] for s in seeds if (s, scen, baseline) in rows]
    tr = [rows[(s, scen, baseline)]['sprTru'] for s in seeds if (s, scen, baseline) in rows]
    if not b:
        continue
    mb, ms = statistics.median(b), statistics.median(sp)
    print(f'{scen:22s} {mb:11.4f} {ms:11.4f} {mb / ms if ms else float("inf"):8.2f}'
          f' {statistics.median(tr):12.4f}')

# --- per-knob paired verdicts ------------------------------------------------
for var in variants:
    if var == baseline:
        continue
    for metric in ('grid', 'pos'):
        print()
        print('=' * 96)
        print(f'{var}  vs  {baseline}   —   metric: {metric}   (paired, ratio = base/variant)')
        print('=' * 96)
        print(f"{'scenario':22s} {'seed':>8s} {'base':>10s} {'variant':>10s} {'ratio':>8s}")
        print('-' * 96)
        per_scen = defaultdict(list)
        for scen in scenarios:
            for s in seeds:
                a = rows.get((s, scen, baseline))
                b = rows.get((s, scen, var))
                if a is None or b is None:
                    continue
                r = a[metric] / b[metric] if b[metric] else float('inf')
                per_scen[scen].append(r)
                flag = '' if r >= 0.98 else '   <-- WORSE'
                print(f'{scen:22s} {s:>8d} {a[metric]:10.4f} {b[metric]:10.4f} {r:8.2f}x{flag}')
        print('-' * 96)
        print(f"{'scenario':22s} {'n':>4s} {'median':>8s} {'min':>8s} {'max':>8s}"
              f" {'helped':>7s} {'hurt':>6s}")
        allr = []
        for scen in scenarios:
            rs = per_scen[scen]
            if not rs:
                continue
            allr += rs
            helped = sum(1 for x in rs if x > 1.02)
            hurt = sum(1 for x in rs if x < 0.98)
            print(f'{scen:22s} {len(rs):4d} {statistics.median(rs):8.2f} {min(rs):8.2f}'
                  f' {max(rs):8.2f} {helped:7d} {hurt:6d}')
        if allr:
            helped = sum(1 for x in allr if x > 1.02)
            hurt = sum(1 for x in allr if x < 0.98)
            print(f'{"ALL":22s} {len(allr):4d} {statistics.median(allr):8.2f}'
                  f' {min(allr):8.2f} {max(allr):8.2f} {helped:7d} {hurt:6d}')
