import assert from 'node:assert/strict';
import { buildSnakeGeometry, signedTurns } from '../web/js/snake/geometry.js';
import { toKicad } from '../web/js/engine/artwork.js';
import { exportKicadPcb, exportSvg, exportDxf } from '../web/js/engine/exporters.js';
import { parseBoard, sexpr } from '../web/js/engine/boardcheck.js';

const near=(a,b,tol=1e-8)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
const xy=p=>p.map(n=>n.toFixed(8)).join(',');
const length=pts=>pts.slice(1).reduce((s,p,i)=>s+Math.hypot(p[0]-pts[i][0],p[1]-pts[i][1]),0);
const members=(node,key)=>node.filter(n=>Array.isArray(n)&&n[0]===key);
// An independent horizontal-ray crossing count, rather than the generator's
// angle summation, verifies the complete electrical loop's actual topology.
function rayTurns(pts,p) {
  let n=0;
  for(let i=0;i<pts.length;i++) {
    const a=pts[i],b=pts[(i+1)%pts.length];
    const cross=(b[0]-a[0])*(p.y-a[1])-(p.x-a[0])*(b[1]-a[1]);
    if(a[1]<=p.y && b[1]>p.y && cross>0) n++;
    if(a[1]>p.y && b[1]<=p.y && cross<0) n--;
  }
  return n;
}
function copperNodeGraph(w) {
  const degrees=new Map();
  for(const path of w.paths) {
    for(let i=1;i<path.pts.length;i++) {
      assert.ok(length(path.pts.slice(i-1,i+1))>1e-8,'No zero-length copper segments');
      for(const p of [path.pts[i-1],path.pts[i]]) {
        const key=`${path.layer}:${xy(p)}`;degrees.set(key,(degrees.get(key)||0)+1);
      }
    }
  }
  // The one copper barrel bridges the only two degree-one transition points.
  for(const layer of w.layers) {
    const key=`${layer}:${xy(w.transition)}`;degrees.set(key,degrees.get(key)+1);
  }
  const ends=[`${w.layers[0]}:${xy(w.terminals[0])}`,`${w.layers[1]}:${xy(w.terminals[1])}`];
  assert.deepEqual([...degrees].filter(([,d])=>d===1).map(([k])=>k).sort(),ends.sort());
  assert.ok([...degrees].every(([k,d])=>d===(ends.includes(k)?1:2)),'No branches, dead ends or same-layer vertex shorts');
}

let cases=0;
for(const rows of [2,4]) for(const cols of [2,4]) for(const variant of [
  {},{pitch:14,pillarDiameter:5,traceWidth:1.2,clearance:.4},
  {pitch:7,pillarDiameter:2,traceWidth:.4,clearance:.2,boardThickness:.8,copperOz:1},
]) {
  const g=buildSnakeGeometry({rows,cols,...variant});cases++;
  assert.equal(g.pillars.length,rows*cols);assert.equal(g.art.tracks.length,4);
  assert.equal(g.art.outline.length,rows*cols+1);assert.equal(g.art.vias.length,2);assert.equal(g.art.pads.length,4);
  assert.deepEqual(g.stack.map(x=>x.winding),['P','S','P','S']);
  assert.equal(g.art.outline[0].role,'board-boundary');
  assert.ok(g.clearances.coreClearanceMm>=g.config.clearance-1e-8);
  assert.ok(g.clearances.copperClearanceMm>=g.config.clearance-1e-8);
  assert.ok(g.clearances.barrelClearanceMm>=g.config.clearance-1e-8);
  for(const w of g.windings) {
    copperNodeGraph(w);
    const [a,b]=w.paths,loop=[...a.pts,...b.pts.slice(1)];
    assert.equal(xy(a.pts.at(-1)),xy(b.pts[0]),'Complementary layers share one actual via');
    assert.deepEqual(g.pillars.map(p=>rayTurns(loop,p)),g.pillars.map(p=>p.sign));
    assert.deepEqual(w.signs,g.pillars.map(p=>p.sign));
    g.pillars.forEach(p=>near(signedTurns(loop,p),p.sign));
    assert.deepEqual(g.pillars.map(p=>rayTurns(loop.slice().reverse(),p)),w.signs.map(n=>-n),'Reversed current reverses every local ampere-turn');
    assert.equal(rayTurns(loop,{x:g.bounds.maxX+10,y:g.bounds.maxY+10}),0,'No external pillar linkage');
    near(w.copperLengthMm,length(a.pts)+length(b.pts));
    near(w.viaLengthMm,2*(g.config.boardThickness-g.copperThicknessMm)/3);
    near(w.lengthMm,w.copperLengthMm+w.viaLengthMm);
    // Retracing the same half layer would yield zero turns, not a snake coil.
    const cancelled=[...a.pts,...a.pts.slice().reverse()];
    assert.ok(g.pillars.every(p=>rayTurns(cancelled,p)===0));
  }
  near(g.windowHeightMm,g.config.boardThickness+2*g.config.coreClearance);
  near(g.coreHeightMm,g.windowHeightMm+2*g.config.plateThickness);
  near(g.ferritePillarHeightMm+g.config.gap,g.windowHeightMm);
  near(4*g.copperThicknessMm+3*g.dielectricThicknessMm,g.config.boardThickness);
  near(g.stack[0].z-g.copperThicknessMm/2,0);
  near(g.stack.at(-1).z+g.copperThicknessMm/2,g.config.boardThickness);
  assert.ok(g.art.labels.every(l=>g.bounds.maxY-l.y-l.size*.6>=.5),'Silkscreen legends clear the board edge');
  assert.ok(g.coreBounds.width>=(cols-1)*g.config.pitch+g.config.pillarDiameter);
  assert.ok(g.coreBounds.height>=(rows-1)*g.config.pitch+g.config.pillarDiameter);
  for(const output of [exportKicadPcb(g.art,{boardThickness:g.config.boardThickness}),exportSvg(g.art),exportDxf(g.art)]) assert.ok(!/NaN|Infinity|undefined/.test(output));
  const pcb=exportKicadPcb(g.art,{boardThickness:g.config.boardThickness,copperThicknessMm:g.copperThicknessMm,dielectricThicknessMm:g.dielectricThicknessMm}),board=parseBoard(pcb);
  assert.equal(board.loops.length,rows*cols+1,'Board export round-trip retains all closed core cutouts');
  const root=sexpr(pcb),stack=members(members(root,'setup')[0],'stackup')[0],stackLayers=members(stack,'layer');
  assert.equal(stackLayers.length,7,'Four copper layers and three dielectrics are explicit');
  assert.deepEqual(stackLayers.filter(l=>l[1].endsWith('.Cu')).map(l=>l[1]),g.stack.map(l=>l.layer));
  const thickness=l=>Number(members(l,'thickness')[0][1]);
  near(stackLayers.reduce((sum,l)=>sum+thickness(l),0),g.config.boardThickness,2e-6);
  stackLayers.forEach(l=>near(thickness(l),l[1].endsWith('.Cu')?g.copperThicknessMm:g.dielectricThicknessMm,1e-6));
  const exportedPads=members(root,'footprint').flatMap(fp=>members(fp,'pad'));
  assert.equal(exportedPads.length,4,'Terminals remain numbered component pads');
  assert.equal(members(root,'via').length,2,'Only the two layer transitions are routing vias');
  for(const [i,p] of exportedPads.entries()) {
    assert.equal(p[1],String(i+1));assert.equal(p[2],'thru_hole');
    assert.deepEqual(members(p,'layers')[0].slice(1),['*.Cu','*.Mask']);
    assert.equal(members(p,'net')[0][2],g.art.pads[i].net);
    near(Number(members(p,'drill')[0][1]),g.art.pads[i].drill);
  }
  const placement=toKicad(g.art);
  assert.equal(placement.tracks.length,4);assert.equal(placement.vias.length,6);
  assert.equal(placement.outline,undefined,'Live placement explicitly omits board edges');
  for(let i=0;i<4;i++) near(placement.tracks[i].pts[0][1],-g.art.tracks[i].pts[0][1]);
  assert.deepEqual(buildSnakeGeometry(JSON.parse(JSON.stringify(g.config))).art,g.art,'Saved configuration exactly rebuilds copper');
}

for(const invalid of [
  {rows:3},{cols:1},{rows:8},{primaryTurns:2},{secondaryTurns:2},{primaryTurns:0},
  {pitch:5},{pillarDiameter:20},{traceWidth:3},{clearance:2},
  {pitch:NaN},{traceWidth:Infinity},{gap:-1},{gap:2,boardThickness:.4,coreClearance:.1},
  {boardThickness:.3,copperOz:4},{primaryNet:'SAME',secondaryNet:'SAME'},
  {primaryNet:'bad"name'},{secondaryNet:'bad\nname'},{primaryNet:''},
]) assert.throws(()=>buildSnakeGeometry(invalid),undefined,JSON.stringify(invalid));

const base=buildSnakeGeometry(),large=buildSnakeGeometry({pitch:14});
assert.ok(!exportKicadPcb(base.art).includes('(stackup'),'Legacy calls do not invent a physical copper weight');
assert.throws(()=>exportKicadPcb(base.art,{boardThickness:1.6,copperThicknessMm:.07,dielectricThicknessMm:.5}),/sum/);
assert.throws(()=>exportKicadPcb(base.art,{boardThickness:1.6,copperThicknessMm:-.07}),/positive/);
assert.throws(()=>exportKicadPcb(base.art,{boardThickness:1.6,dielectricThicknessMm:.44}),/positive/);
assert.ok(large.windings.every((w,i)=>w.lengthMm>base.windings[i].lengthMm));
near(base.windings[0].lengthMm,549.3649788554831);
near(base.windings[1].lengthMm,600.6293035268356);
console.log(`${cases} snake geometry scenarios passed: independent signed turns, electrical continuity, clearance, mechanical dimensions and export round-trips.`);
