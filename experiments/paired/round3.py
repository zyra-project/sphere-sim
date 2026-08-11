"""
Paired analysis of round 3, on fresh seeds.

Design, unchanged from rounds 1 and 2 and for the same reason: capture ONCE per
(seed, scenario), then solve several ways with one knob moved. Scenario variance
— 69-182% of the metric across seeds with the code held fixed — cancels exactly,
so a ratio between two rows of the same cell measures the knob and not the draw.

Reads a log whose rows are

  <seed> <scenario> <variant> pos=.. rot=.. grid=.. camRot=.. camPos=.. hc=..

Ratios are baseline/variant, so >1 means the variant HELPED.

Usage:  python3 experiments/paired/round3.py <log> <baseline-variant>
"""
import re
import sys
import statistics
from collections import defaultdict

ROW = re.compile(
    r'^(\d+)\s+(\S+)\s+(\S+)\s+pos=\s*([-\d.]+)\s+rot=\s*([-\d.]+)\s+grid=\s*([-\d.]+)\s+'
    r'camRot=\s*([-\d.]+)\s+camPos=\s*([-\d.]+)\s+hc=\s*([-\d.]+)'
)

TRIPOD = ('s00-clean', 's01-nominal', 's02-sensor-noise', 's03-high-ambient')
METRICS = ('grid', 'pos', 'rot', 'camRot', 'hc')

log = sys.argv[1]
baseline = sys.argv[2] if len(sys.argv) > 2 else 'base'

rows = {}
variants = []
scenarios = []
for line in open(log):
    m = ROW.match(line.strip())
    if not m:
        continue
    seed, scen, var, pos, rot, grid, crot, cpos, hc = m.groups()
    rows[(int(seed), scen, var)] = {
        'pos': float(pos), 'rot': float(rot), 'grid': float(grid),
        'camRot': float(crot), 'camPos': float(cpos), 'hc': float(hc),
    }
    if var not in variants:
        variants.append(var)
    if scen not in scenarios:
        scenarios.append(scen)

seeds = sorted({k[0] for k in rows})
print(f'{len(rows)} solves, {len(seeds)} seeds, {len(scenarios)} scenarios, '
      f'{len(variants)} variants')
print()

# --- the guard the assignment names: the tripods must still pass -------------
print('=' * 96)
print('G2  THE FOUR TRIPOD SCENARIOS AGAINST THE 1.0 mm GRID GATE')
print('    absolute values, not ratios: a gate is an absolute question')
print('=' * 96)
print(f"{'scenario':22s} {'variant':12s} {'n':>3s} {'median':>9s} {'worst':>9s} {'PASS?':>8s}")
print('-' * 96)
for scen in scenarios:
    if scen not in TRIPOD:
        continue
    for var in variants:
        vs = [rows[(s, scen, var)]['grid'] for s in seeds if (s, scen, var) in rows]
        if not vs:
            continue
        worst = max(vs)
        print(f'{scen:22s} {var:12s} {len(vs):3d} {statistics.median(vs):9.4f} '
              f'{worst:9.4f} {"pass" if worst <= 1.0 else "FAIL":>8s}')
print()

# --- per-knob paired verdicts ------------------------------------------------
for var in variants:
    if var == baseline:
        continue
    for metric in METRICS:
        print()
        print('=' * 96)
        print(f'{var}  vs  {baseline}   —   metric: {metric}   (paired, ratio = base/variant)')
        print('=' * 96)
        print(f"{'scenario':22s} {'n':>4s} {'median':>8s} {'min':>8s} {'max':>8s}"
              f" {'helped':>7s} {'hurt':>6s}")
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
        allr = []
        tripodr = []
        for scen in scenarios:
            rs = per_scen[scen]
            if not rs:
                continue
            allr += rs
            if scen in TRIPOD:
                tripodr += rs
            helped = sum(1 for x in rs if x > 1.02)
            hurt = sum(1 for x in rs if x < 0.98)
            print(f'{scen:22s} {len(rs):4d} {statistics.median(rs):8.2f} {min(rs):8.2f}'
                  f' {max(rs):8.2f} {helped:7d} {hurt:6d}')
        for label, rs in (('TRIPOD ONLY', tripodr), ('ALL', allr)):
            if not rs:
                continue
            helped = sum(1 for x in rs if x > 1.02)
            hurt = sum(1 for x in rs if x < 0.98)
            print(f'{label:22s} {len(rs):4d} {statistics.median(rs):8.2f}'
                  f' {min(rs):8.2f} {max(rs):8.2f} {helped:7d} {hurt:6d}')

# --- the predictor, on this corpus -------------------------------------------
print()
print('=' * 96)
print('CAMERA ROTATION ERROR AGAINST GRID DISPLACEMENT, per variant')
print('  round 2\'s critic: perfect separation at <0.07 deg pass / >0.18 deg fail')
print('=' * 96)
for var in variants:
    xs = [(v['camRot'], v['grid']) for (s, scen, vv), v in rows.items() if vv == var]
    if len(xs) < 3:
        continue
    mx = statistics.mean(x for x, _ in xs)
    my = statistics.mean(y for _, y in xs)
    sxy = sum((x - mx) * (y - my) for x, y in xs)
    sxx = sum((x - mx) ** 2 for x, _ in xs)
    syy = sum((y - my) ** 2 for _, y in xs)
    r = sxy / (sxx * syy) ** 0.5 if sxx and syy else float('nan')
    slope = sxy / sxx if sxx else float('nan')
    passing = [x for x, y in xs if y <= 1.0]
    failing = [x for x, y in xs if y > 1.0]
    print(f'{var:12s} n={len(xs):3d}  r={r:6.3f}  slope={slope:8.1f} mm/deg  '
          f'max camRot among grid-PASS={max(passing) if passing else float("nan"):.4f}  '
          f'min camRot among grid-FAIL={min(failing) if failing else float("nan"):.4f}')
