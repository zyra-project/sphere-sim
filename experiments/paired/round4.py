"""
Paired analysis of round 4, on fresh seeds.

Design, unchanged from rounds 1-3 and for the same reason: capture ONCE per
(seed, scenario), then solve several ways with one knob moved. Scenario variance
— 69-182% of the metric across seeds with the code held fixed — cancels exactly,
so a ratio between two rows of the same cell measures the knob and not the draw.

Reads a log whose rows are

  <seed> <scenario> <variant> pos=.. rot=.. grid=.. camRot=.. camRotS=.. floor=..
      camPos=.. hc=.. fovBias=.. fovRec=[..] fovTrue=[..] boxProj=.. boxAt=[..]

Ratios are baseline/variant, so >1 means the variant HELPED.

Usage:  python3 experiments/paired/round4.py <log> [baseline-variant]
"""
import re
import sys
import statistics
from collections import defaultdict

ROW = re.compile(
    r'^(\d+)\s+(\S+)\s+(\S+)\s+pos=\s*([-\d.]+)\s+rot=\s*([-\d.]+)\s+grid=\s*([-\d.]+)\s+'
    r'camRot=\s*([-\d.]+)\s+camRotS=\s*([-\d.]+)\s+floor=\s*([-\d.]+)\s+'
    r'camPos=\s*([-\d.]+)\s+hc=\s*([-\d.]+)\s+fovBias=\s*([-\d.]+)\s+'
    r'fovRec=\[([^\]]*)\]\s+fovTrue=\[([^\]]*)\]\s+boxProj=(\d+)\s+boxAt=\[([^\]]*)\]'
)

TRIPOD = ('s00-clean', 's01-nominal', 's02-sensor-noise', 's03-high-ambient')
METRICS = ('grid', 'pos', 'rot', 'camRot', 'hc', 'camPos')
# docs/AMENDMENTS.md A-35, from the BenQ LK935 manual's own distance table.
FOV_LO, FOV_HI = 25.84, 40.37

log = sys.argv[1]
baseline = sys.argv[2] if len(sys.argv) > 2 else 'base'

rows = {}
variants = []
scenarios = []
for line in open(log):
    m = ROW.match(line.strip())
    if not m:
        continue
    (seed, scen, var, pos, rot, grid, crot, crots, floor, cpos, hc, fovbias,
     fovrec, fovtrue, boxproj, boxat) = m.groups()
    rows[(int(seed), scen, var)] = {
        'pos': float(pos), 'rot': float(rot), 'grid': float(grid),
        'camRot': float(crot), 'camRotS': float(crots), 'floor': float(floor),
        'camPos': float(cpos), 'hc': float(hc), 'fovBias': float(fovbias),
        'fovRec': [float(x) for x in fovrec.split(',') if x],
        'fovTrue': [float(x) for x in fovtrue.split(',') if x],
        'boxProj': int(boxproj), 'boxAt': [x for x in boxat.split(';') if x],
    }
    if var not in variants:
        variants.append(var)
    if scen not in scenarios:
        scenarios.append(scen)

seeds = sorted({k[0] for k in rows})
print(f'{len(rows)} solves, {len(seeds)} seeds, {len(scenarios)} scenarios, '
      f'{len(variants)} variants')
print()

# --- the gate question: absolute tripod values --------------------------------
print('=' * 100)
print('G2  THE FOUR TRIPOD SCENARIOS AGAINST THE 1.0 mm GRID GATE')
print('    absolute values, not ratios: a gate is an absolute question')
print('=' * 100)
print(f"{'scenario':22s} {'variant':16s} {'n':>3s} {'median':>9s} {'worst':>9s} {'PASS?':>8s}")
for scen in [s for s in scenarios if s in TRIPOD]:
    for var in variants:
        vals = [rows[(s, scen, var)]['grid'] for s in seeds if (s, scen, var) in rows]
        if not vals:
            continue
        worst = max(vals)
        print(f'{scen:22s} {var:16s} {len(vals):3d} {statistics.median(vals):9.4f} '
              f'{worst:9.4f} {"pass" if worst <= 1.0 else "FAIL":>8s}')
print()

# --- paired ratios ------------------------------------------------------------
def ratios(var, metric, scen=None):
    out = []
    for (s, sc, v), row in rows.items():
        if v != var or (scen is not None and sc != scen):
            continue
        base = rows.get((s, sc, baseline))
        if base is None:
            continue
        a, b = base[metric], row[metric]
        if b == 0 and a == 0:
            out.append(1.0)
        elif b == 0:
            continue
        else:
            out.append(a / b)
    return out

for var in variants:
    if var == baseline:
        continue
    print('=' * 100)
    print(f'PAIRED  {baseline} / {var}   (>1 means {var} helped)')
    print('=' * 100)
    print(f"{'metric':12s} {'cells':>6s} {'median':>9s} {'helped':>7s} {'hurt':>6s} "
          f"{'tripod med':>11s} {'tripod h/h':>11s}")
    for metric in METRICS:
        r = ratios(var, metric)
        if not r:
            continue
        helped = sum(1 for x in r if x > 1.001)
        hurt = sum(1 for x in r if x < 0.999)
        tr = [x for (s, sc, v), row in rows.items() if v == var and sc in TRIPOD
              for x in [rows[(s, sc, baseline)][metric] / row[metric]]
              if (s, sc, baseline) in rows and row[metric] != 0]
        th = sum(1 for x in tr if x > 1.001)
        thh = sum(1 for x in tr if x < 0.999)
        print(f'{metric:12s} {len(r):6d} {statistics.median(r):9.3f} {helped:7d} {hurt:6d} '
              f'{(statistics.median(tr) if tr else float("nan")):11.3f} {f"{th}/{thh}":>11s}')
    print()
    print(f"{'archetype':24s} {'grid':>9s} {'helped':>7s} {'pos':>9s} {'helped':>7s} "
          f"{'rot':>9s} {'camRot':>9s}")
    for scen in scenarios:
        g = ratios(var, 'grid', scen)
        p = ratios(var, 'pos', scen)
        ro = ratios(var, 'rot', scen)
        c = ratios(var, 'camRot', scen)
        if not g:
            continue
        print(f'{scen:24s} {statistics.median(g):9.3f} '
              f'{sum(1 for x in g if x > 1.001):3d}/{len(g):<3d} '
              f'{statistics.median(p):9.3f} {sum(1 for x in p if x > 1.001):3d}/{len(p):<3d} '
              f'{statistics.median(ro):9.3f} {statistics.median(c):9.3f}')
    print()

# --- the hardware envelope ----------------------------------------------------
print('=' * 100)
print('THE HARDWARE ENVELOPE: recovered fov_h against the LK935 zoom range')
print(f'    A-35: {FOV_LO} to {FOV_HI} deg. Anything outside is a projector nobody can buy.')
print('=' * 100)
print(f"{'variant':16s} {'n fov':>7s} {'min':>8s} {'p05':>8s} {'median':>8s} {'p95':>8s} "
      f"{'max':>8s} {'outside':>8s} {'boxProj':>8s} {'atLimit':>8s}")
for var in variants:
    fovs = [f for (s, sc, v), row in rows.items() if v == var for f in row['fovRec']]
    if not fovs:
        continue
    fovs.sort()
    outside = sum(1 for f in fovs if f < FOV_LO or f > FOV_HI)
    proj = sum(row['boxProj'] for (s, sc, v), row in rows.items() if v == var)
    atlim = sum(len(row['boxAt']) for (s, sc, v), row in rows.items() if v == var)
    q = lambda p: fovs[min(len(fovs) - 1, int(p * len(fovs)))]
    print(f'{var:16s} {len(fovs):7d} {fovs[0]:8.3f} {q(0.05):8.3f} {q(0.5):8.3f} '
          f'{q(0.95):8.3f} {fovs[-1]:8.3f} {outside:8d} {proj:8d} {atlim:8d}')
print()
truth = [f for row in rows.values() for f in row['fovTrue']]
print(f'truth fov_h across the corpus: {min(truth):.3f} to {max(truth):.3f} deg — '
      f'{"inside" if min(truth) > FOV_LO and max(truth) < FOV_HI else "OUTSIDE"} the envelope')
worst = max(rows.values(), key=lambda r: max(abs(f - FOV_LO) * 0 + max(0, FOV_LO - f, f - FOV_HI)
                                             for f in r['fovRec']))
print(f'closest approach to a limit, any cell: '
      f'{min(min(f - FOV_LO for f in r["fovRec"]) for r in rows.values()):.3f} deg above the low '
      f'limit, {min(min(FOV_HI - f for f in r["fovRec"]) for r in rows.values()):.3f} deg below the high one')
print()

# --- the camera gate's definitional floor -------------------------------------
print('=' * 100)
print('THE camera_pose_rotation GATE: scored at the reference epoch vs against the static pose')
print('    `floor` is how far the truth pose MOVED by the reference epoch — the error a')
print('    perfect solver was charged under the old definition, against a 0.07 deg gate.')
print('=' * 100)
print(f"{'archetype':24s} {'floor med':>10s} {'floor max':>10s} {'camRot':>9s} {'camRotS':>9s} "
      f"{'pass@0.07':>10s}")
for scen in scenarios:
    fl = [rows[(s, scen, baseline)]['floor'] for s in seeds if (s, scen, baseline) in rows]
    cr = [rows[(s, scen, baseline)]['camRot'] for s in seeds if (s, scen, baseline) in rows]
    cs = [rows[(s, scen, baseline)]['camRotS'] for s in seeds if (s, scen, baseline) in rows]
    if not fl:
        continue
    print(f'{scen:24s} {statistics.median(fl):10.4f} {max(fl):10.4f} '
          f'{statistics.median(cr):9.4f} {statistics.median(cs):9.4f} '
          f'{sum(1 for x in cr if x <= 0.07):5d}/{len(cr):<4d}')
