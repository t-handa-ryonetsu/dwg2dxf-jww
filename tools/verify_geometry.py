"""Check converted JWW geometry against the source DXF, using independent libraries.

For every line and arc in each JWW file (read with ezjww), sample points and measure the
distance to the reference geometry of the DXF (blocks and dimensions exploded by ezdxf).

  node scripts/cli.mjs --info --out out test/fixtures
  python tools/verify_geometry.py out            # each out/X.jww is compared with out/X.dxf or test/fixtures/X.dxf

Exit code 1 if any element is further than TOLERANCE (relative to the drawing size) from the reference.
"""
import sys, math, json, pathlib
import numpy as np
import ezdxf, ezjww
from scipy.spatial import cKDTree
from ezdxf import disassemble, path as ezpath
from ezdxf.render import hatching

REL_TOL = 2e-4   # 0.02 % of the drawing extent
SKIP = {'TEXT', 'MTEXT', 'ATTRIB', 'POINT'}

def reference_points(dxf_path):
    doc = ezdxf.readfile(dxf_path)
    segs = []
    for e in disassemble.recursive_decompose(doc.modelspace()):
        t = e.dxftype()
        if t in SKIP: continue
        if t in ('MULTILEADER', 'MLEADER') or (t == 'POLYLINE' and e.is_poly_face_mesh):
            # leader lines up to the arrow tip / visible mesh edges
            if t == 'POLYLINE':
                for f in e.virtual_entities():
                    v = [f.dxf.vtx0, f.dxf.vtx1, f.dxf.vtx2, f.dxf.vtx3]
                    for i in range(4):
                        if not f.is_invisible_edge(i): segs.append((v[i].x, v[i].y, v[(i + 1) % 4].x, v[(i + 1) % 4].y))
            else:
                for ld in e.context.leaders:
                    for ln in ld.lines:
                        pts = list(ln.vertices) + [ld.last_leader_point]
                        segs += [(a.x, a.y, b.x, b.y) for a, b in zip(pts, pts[1:])]
            continue
        if t in ('SOLID', 'TRACE'):  # e.g. arrowheads: the outline counts as reference
            v = [e.dxf.vtx0, e.dxf.vtx1, e.dxf.vtx3, e.dxf.vtx2]
            segs += [(v[i].x, v[i].y, v[(i + 1) % 4].x, v[(i + 1) % 4].y) for i in range(4)]
            continue
        if t == 'HATCH':
            if not e.dxf.solid_fill:
                try:
                    for a, b in hatching.hatch_entity(e): segs.append((a.x, a.y, b.x, b.y))
                except Exception: pass
            continue
        try: p = ezpath.make_path(e)
        except Exception: continue
        fl = [(v.x, v.y) for v in p.flattening(0.01, segments=16)]
        segs += [(a[0], a[1], b[0], b[1]) for a, b in zip(fl, fl[1:])]
    S = np.array(segs)
    ext = max(np.ptp(S[:, [0, 2]]), np.ptp(S[:, [1, 3]]))
    step = ext / 20000
    pts = [np.c_[ax + (bx - ax) * t, ay + (by - ay) * t]
           for ax, ay, bx, by in segs
           for t in [np.linspace(0, 1, max(1, int(math.hypot(bx - ax, by - ay) / step)) + 1)]]
    return cKDTree(np.vstack(pts)), ext, step

def check(jww_path, dxf_path):
    info = json.loads(pathlib.Path(jww_path).with_suffix('.info.json').read_text())
    d = ezjww.read_document(str(jww_path))
    k = d['header']['layer_groups'][0]['scale'] / info['unitMM']
    ox, oy = info['origin']
    tree, ext, step = reference_points(str(dxf_path))
    tol = ext * REL_TOL + step
    bad, n, worst = 0, 0, 0.0
    for e in d['entities']:
        t = e['type']
        if t == 'LINE':
            s = np.linspace(0, 1, 9)
            P = np.c_[e['start_x'] + (e['end_x'] - e['start_x']) * s, e['start_y'] + (e['end_y'] - e['start_y']) * s]
        elif t in ('ARC', 'CIRCLE'):
            a = e['start_angle'] + e['arc_angle'] * np.linspace(0, 1, 17)
            x, y, ti = e['radius'] * np.cos(a), e['radius'] * e['flatness'] * np.sin(a), e['tilt_angle']
            P = np.c_[e['center_x'] + x * math.cos(ti) - y * math.sin(ti), e['center_y'] + x * math.sin(ti) + y * math.cos(ti)]
        else: continue
        n += 1
        dist, _ = tree.query(P * k + [ox, oy])
        m = float(dist.max()); worst = max(worst, m)
        if m > tol: bad += 1
    print(f'{jww_path.name}: {n} lines/arcs, {bad} off by more than {tol:.3g} (worst {worst:.3g}, drawing units)')
    return bad

def main():
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'out')
    fixtures = pathlib.Path(__file__).resolve().parent.parent / 'test' / 'fixtures'
    total = 0
    for jww in sorted(out.rglob('*.jww')):
        dxf = jww.with_suffix('.dxf')
        if not dxf.exists(): dxf = fixtures / (jww.stem + '.dxf')
        if not dxf.exists(): print(f'{jww.name}: no source DXF, skipped'); continue
        total += check(jww, dxf)
    sys.exit(1 if total else 0)

if __name__ == '__main__':
    main()
