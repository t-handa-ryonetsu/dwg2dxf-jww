"""Generate the DXF test fixtures in test/fixtures/ (needs: pip install ezdxf)."""
import os, ezdxf, math
OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures') + os.sep
from ezdxf.enums import TextEntityAlignment
def build(ver, fn, enc=None):
    doc = ezdxf.new(ver, setup=True)
    if enc: doc.encoding = enc
    doc.header['$INSUNITS'] = 4
    msp = doc.modelspace()
    doc.layers.add('壁', color=1); doc.layers.add('設備-配管', color=5, linetype='DASHED'); l=doc.layers.add('HIDE', color=3); l.off()
    msp.add_line((0,0),(10000,0), dxfattribs={'layer':'壁'})
    msp.add_line((0,0),(0,7000), dxfattribs={'layer':'壁','color':3})
    msp.add_circle((2000,2000),500, dxfattribs={'layer':'設備-配管'})
    msp.add_arc((5000,2000),800,30,200)
    msp.add_ellipse((8000,2000),major_axis=(1000,500),ratio=0.4,start_param=0.3,end_param=4.0)
    msp.add_ellipse((8000,5000),major_axis=(0,900),ratio=0.5)
    lw = msp.add_lwpolyline([(1000,4000,0,0,0.5),(2500,4000,0,0,-1),(2500,5500,0,0,0),(1000,5500)], format='xyseb'); lw.closed=True
    msp.add_polyline2d([(3000,4000),(3500,4500),(4000,4000)])
    msp.add_spline(fit_points=[(5000,4000),(5500,5000),(6000,4200),(6500,5200)])
    msp.add_point((9000,6000)); msp.add_line((0,7000),(500,7000),dxfattribs={'layer':'HIDE'})
    msp.add_text('配管 ルート A-1', height=250, dxfattribs={'layer':'設備-配管'}).set_placement((1000,6500))
    msp.add_text('中央揃え', height=200).set_placement((5000,6500), align=TextEntityAlignment.MIDDLE_CENTER)
    msp.add_mtext('冷凍機室\\P2行目 φ50', dxfattribs={'char_height':180,'insert':(7000,6800),'attachment_point':1})
    msp.add_solid([(9000,100),(9800,100),(9000,900),(9800,900)])
    blk = doc.blocks.new('バルブ')
    blk.add_line((-100,0),(100,0)); blk.add_circle((0,0),60); blk.add_arc((0,0),120,0,90); blk.add_text('V', height=50).set_placement((0,80))
    msp.add_blockref('バルブ',(3000,1000), dxfattribs={'rotation':45,'xscale':2,'yscale':2})
    msp.add_blockref('バルブ',(4000,1000), dxfattribs={'xscale':-1.5,'yscale':1})  # mirrored
    msp.add_blockref('バルブ',(4600,1000), dxfattribs={'xscale':1,'yscale':0.5,'rotation':30})  # non-uniform
    dim = msp.add_linear_dim(base=(0,-800), p1=(0,0), p2=(10000,0)); dim.render()
    h = msp.add_hatch(color=2); h.paths.add_polyline_path([(6000,500),(7500,500),(7500,1500),(6000,1500)], is_closed=True); h.paths.add_polyline_path([(6500,800),(7000,800),(7000,1200),(6500,1200)], is_closed=True)
    h2 = msp.add_hatch(color=4); h2.set_pattern_fill('ANSI31', scale=20); h2.paths.add_polyline_path([(100,100),(1500,100),(1500,1500),(100,1500)], is_closed=True)
    a = msp.add_arc((2000,3000),300,0,120); a.dxf.extrusion=(0,0,-1)   # mirrored OCS arc
    doc.saveas(fn)
build('R2000', OUT + 'r2000_sjis.dxf', 'cp932')     # Japanese stored as Shift_JIS bytes
build('R2018', OUT + 'r2018_utf8.dxf')              # UTF-8 (AutoCAD 2007+)
build('R2000', OUT + 'r2000_escaped.dxf', 'cp1252') # Japanese stored as \\U+XXXX escapes

from ezdxf.render import mleader
doc = ezdxf.new('R2018', setup=True); doc.header['$INSUNITS'] = 4; msp = doc.modelspace()
msp.add_line((0, 0), (10000, 0))
b = msp.add_multileader_mtext('Standard'); b.set_content('冷水配管 50A', char_height=200)
b.add_leader_line(mleader.ConnectionSide.left, [ezdxf.math.Vec2(1000, 1000)])
b.build(insert=ezdxf.math.Vec2(3000, 2000))
doc.saveas(OUT + 'r2018_mleader.dxf')
print('ok')
