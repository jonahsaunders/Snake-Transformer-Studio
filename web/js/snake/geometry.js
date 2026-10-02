/* A bounded, electrically continuous paired snake winding.
 * Each outward path passes halfway around every pillar; its complementary
 * return on another layer completes alternating signed turns. All coordinates
 * are millimetres in artwork's +Y-up frame. This is not a repeated spiral.
 */
import { artwork, track, via, pad, label, rect, bounds as artworkBounds } from '../engine/artwork.js';

const TAU = Math.PI * 2;
const LAYERS = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
const DEFAULTS = { name: 'Snake matrix', rows: 4, cols: 4, pitch: 10, pillarDiameter: 4,
  plateThickness: 1.2, boardThickness: 1.6, gap: .05, coreClearance: .35,
  traceWidth: .8, clearance: .3, copperOz: 2, primaryTurns: 1, secondaryTurns: 1,
  primaryNet: 'PRIMARY', secondaryNet: 'SECONDARY' };
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const pointSegment = (p, a, b) => {
  const x = b[0] - a[0], y = b[1] - a[1];
  const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * x + (p[1] - a[1]) * y) / (x*x + y*y || 1)));
  return Math.hypot(p[0] - a[0] - u*x, p[1] - a[1] - u*y);
};
function intersects(a, b, c, d) {
  if (Math.max(a[0],b[0]) < Math.min(c[0],d[0])-1e-9 || Math.max(c[0],d[0]) < Math.min(a[0],b[0])-1e-9
    || Math.max(a[1],b[1]) < Math.min(c[1],d[1])-1e-9 || Math.max(c[1],d[1]) < Math.min(a[1],b[1])-1e-9) return false;
  return cross(a,b,c)*cross(a,b,d) <= 1e-14 && cross(c,d,a)*cross(c,d,b) <= 1e-14;
}
function segmentDistance(a,b,c,d) {
  return intersects(a,b,c,d) ? 0 : Math.min(pointSegment(a,c,d),pointSegment(b,c,d),pointSegment(c,a,b),pointSegment(d,a,b));
}
function append(pts, p) { if (!pts.length || distance(pts.at(-1),p)>1e-10) pts.push(p); }
function pathLength(pts) { return pts.slice(1).reduce((sum,p,i)=>sum+distance(p,pts[i]),0); }
function finiteRange(c, key, low, high) {
  if (!Number.isFinite(c[key]) || c[key]<low || c[key]>high) throw new Error(`${key} must be between ${low} and ${high}.`);
}
function bounding(b) { return { minX:b.x0,minY:b.y0,maxX:b.x1,maxY:b.y1,width:b.w,height:b.h }; }
function circle(x,y,r,segments=128) {
  return Array.from({length:segments+1},(_,i)=>[x+r*Math.cos(TAU*i/segments),y+r*Math.sin(TAU*i/segments)]);
}

/** Signed winding number of a closed projected electrical loop about a pillar.
 * Vertically connected layer endpoints have identical XY coordinates. The
 * caller closes the external terminal pair outside the core array.
 */
export function signedTurns(pts, pillar) {
  let angle = 0;
  for(let i=0;i<pts.length;i++) {
    const a=pts[i],b=pts[(i+1)%pts.length];
    const ax=a[0]-pillar.x,ay=a[1]-pillar.y,bx=b[0]-pillar.x,by=b[1]-pillar.y;
    angle+=Math.atan2(ax*by-ay*bx,ax*bx+ay*by);
  }
  return angle/TAU;
}

function weave(c,pillars,radius,complement,turnX) {
  const pts=[];
  for(let row=0;row<c.rows;row++) {
    const direction=row%2?-1:1;
    for(let position=0;position<c.cols;position++) {
      const col=direction===1?position:c.cols-1-position;
      const p=pillars[row*c.cols+col];
      // A positive angular sweep is a positive half-turn. The return path is
      // traversed backward, so its opposite sweep adds the other half-turn.
      const start=direction===1?Math.PI:0;
      const sweep=p.sign*(complement?-1:1)*Math.PI;
      for(let i=0;i<=48;i++) {
        const angle=start+sweep*i/48;
        append(pts,[p.x+radius*Math.cos(angle),p.y+radius*Math.sin(angle)]);
      }
    }
    if(row<c.rows-1) {
      const end=pts.at(-1),nextY=pillars[(row+1)*c.cols].y;
      append(pts,[direction*turnX,end[1]]);
      append(pts,[direction*turnX,nextY]);
    }
  }
  return pts;
}

function validateCopper(art,pillars,holeRadius,clearance) {
  let minHole=Infinity,minRemoteCopper=Infinity,minBarrel=Infinity;
  for(const t of art.tracks) {
    const cumulative=[0];
    for(let i=1;i<t.pts.length;i++) cumulative.push(cumulative.at(-1)+distance(t.pts[i-1],t.pts[i]));
    for(let i=1;i<t.pts.length;i++) {
      const a=t.pts[i-1],b=t.pts[i];
      for(const p of pillars) minHole=Math.min(minHole,pointSegment([p.x,p.y],a,b)-holeRadius-t.width/2);
      for(let j=i+2;j<t.pts.length;j++) {
        const d=segmentDistance(a,b,t.pts[j-1],t.pts[j]);
        if(d<1e-8) throw new Error(`The ${t.winding} snake crosses itself on ${t.layer}.`);
        // Immediate neighbours along a continuous trace naturally touch.
        if(cumulative[j-1]-cumulative[i] > 2*(t.width+clearance)) minRemoteCopper=Math.min(minRemoteCopper,d-t.width);
      }
    }
  }
  if(minHole<clearance-1e-7) throw new Error('Copper clearance to a pillar opening is too small. Increase pitch or reduce the conductor width.');
  if(minRemoteCopper<clearance-1e-7) throw new Error('The snake approaches another part of itself too closely. Increase pitch or reduce conductor width.');
  const barrels=[...art.pads,...art.vias];
  for(let i=0;i<barrels.length;i++) {
    const v=barrels[i],r=(v.w||v.diameter)/2;
    for(let j=0;j<i;j++) minBarrel=Math.min(minBarrel,Math.hypot(v.x-barrels[j].x,v.y-barrels[j].y)-r-(barrels[j].w||barrels[j].diameter)/2);
    for(const p of pillars) if(Math.hypot(v.x-p.x,v.y-p.y)-r-holeRadius<clearance) throw new Error('A through-hole connection intersects a core opening.');
    for(const t of art.tracks) for(let j=1;j<t.pts.length;j++) {
      if(v.nodeId===t.startNode && j===1 || v.nodeId===t.endNode && j===t.pts.length-1) continue;
      minBarrel=Math.min(minBarrel,pointSegment([v.x,v.y],t.pts[j-1],t.pts[j])-r-t.width/2);
    }
  }
  if(minBarrel<clearance-1e-7) throw new Error('A through-hole connection would touch or bypass another winding section.');
  return {coreClearanceMm:minHole,copperClearanceMm:minRemoteCopper,barrelClearanceMm:minBarrel};
}

export function buildSnakeGeometry(input={}) {
  const c={...DEFAULTS,...input};
  if(![2,4].includes(c.rows)||![2,4].includes(c.cols)) throw new Error('This paired snake supports 2 × 2, 2 × 4, 4 × 2, and 4 × 4 pillar grids.');
  if(c.primaryTurns!==1||c.secondaryTurns!==1) throw new Error('This release supports exactly one complete turn per pillar for each winding (1:1).');
  for(const [key,lo,hi] of [['pitch',4,60],['pillarDiameter',1,30],['plateThickness',.2,10],['boardThickness',.3,5],
    ['gap',0,2],['coreClearance',.1,3],['traceWidth',.15,3],['clearance',.15,3],['copperOz',.5,4]]) finiteRange(c,key,lo,hi);
  const nets=[c.primaryNet,c.secondaryNet];
  if(nets.some(n=>typeof n!=='string'||!n.trim()||/["\\\r\n\t]/.test(n)||n.length>80)||nets[0]===nets[1]) throw new Error('Use distinct primary and secondary net names without quotes, backslashes or control characters.');
  const windowHeightMm=c.boardThickness+2*c.coreClearance;
  if(c.gap>=windowHeightMm-.1) throw new Error('The pillar gap must leave at least 0.1 mm of ferrite between the plates.');
  const copperThicknessMm=c.copperOz*.035,dielectricThicknessMm=(c.boardThickness-4*copperThicknessMm)/3;
  if(dielectricThicknessMm<.05) throw new Error('The four-layer board is too thin for this copper weight and dielectric spacing.');
  const holeRadius=c.pillarDiameter/2+c.coreClearance;
  // Chord error is explicitly covered by 0.02 mm so the emitted polygon and
  // its actual wide track, not only ideal circular centrelines, clear holes.
  const radii=[holeRadius+c.clearance+c.traceWidth/2+.02];
  radii.push(radii[0]+c.traceWidth+c.clearance);
  if(c.pitch<2*radii[1]+c.traceWidth+c.clearance+.05) throw new Error(`Pitch must be at least ${(2*radii[1]+c.traceWidth+c.clearance+.05).toFixed(2)} mm for these pillars and winding clearances.`);
  const halfX=(c.cols-1)*c.pitch/2,halfY=(c.rows-1)*c.pitch/2;
  const pillars=Array.from({length:c.rows*c.cols},(_,i)=>{
    const row=Math.floor(i/c.cols),col=i%c.cols;
    return {id:`R${row+1}C${col+1}`,row,col,x:col*c.pitch-halfX,y:halfY-row*c.pitch,sign:(row+col)%2?-1:1};
  });
  const diameter=Math.max(1.2,c.traceWidth+.4),drill=Math.min(.8,diameter-.5);
  const corridorStep=diameter+c.clearance+.35;
  const turnX=halfX+radii[1]+c.traceWidth+c.clearance+1;
  const terminalY=halfY+radii[1]+diameter+c.clearance+1;
  const viaY=-terminalY;
  const stack=LAYERS.map((layer,i)=>({layer,winding:i%2?'S':'P',z:copperThicknessMm/2+i*(copperThicknessMm+dielectricThicknessMm),thickness:copperThicknessMm}));
  const art=artwork({name:String(c.name||'Snake matrix'),kind:'transformer',family:'snake-matrix',exactPaths:true,
    boardLayers:LAYERS.slice(),stack,turnsPerPillar:1,ratio:1,topology:'paired-complementary-snake',grid:[c.rows,c.cols]});
  const windings=[];
  for(let wi=0;wi<2;wi++) {
    const name=wi?'S':'P',net=nets[wi],layers=[LAYERS[wi],LAYERS[wi+2]];
    const xPlus=-turnX-corridorStep*(wi*2+1),xMinus=-turnX-corridorStep*(wi*2+2),xVia=-turnX-corridorStep*(wi+1);
    const plus=[xPlus,terminalY],minus=[xMinus,terminalY],join=[xVia,viaY];
    const outward=weave(c,pillars,radii[wi],false,turnX),complement=weave(c,pillars,radii[wi],true,turnX);
    const a=[plus,[xPlus,halfY],...outward,[xVia,-halfY],join];
    const b=[join,[xVia,-halfY],...complement.slice().reverse(),[xMinus,halfY],minus];
    const paths=[{layer:layers[0],pts:a,width:c.traceWidth},{layer:layers[1],pts:b,width:c.traceWidth}];
    const nodeIds=[`${name}+`,`${name}:join`,`${name}-`];
    for(let i=0;i<2;i++) art.tracks.push(track(paths[i].layer,c.traceWidth,paths[i].pts,{net,role:'winding',winding:name,section:i,startNode:nodeIds[i],endNode:nodeIds[i+1]}));
    for(const [i,xy] of [plus,minus].entries()) {
      const nodeId=i?nodeIds[2]:nodeIds[0];
      art.pads.push({...pad(xy[0],xy[1],{w:diameter,drill,number:String(wi*2+i+1),net,role:'terminal'}),nodeId,winding:name});
      art.ports.push({x:xy[0],y:xy[1],name:`${name}${i?'−':'+ (dot)'}`,net,winding:name,nodeId});
      art.labels.push(label(xy[0],xy[1]+1.6,`${name}${i?'-':'+'}`,{size:.85}));
    }
    art.vias.push({...via(join[0],join[1],{diameter,drill,net,role:'transition',from:layers[0],to:layers[1]}),nodeId:nodeIds[1],winding:name});
    const loop=[...a,...b.slice(1)];
    const measuredTurns=pillars.map(p=>signedTurns(loop,p));
    if(measuredTurns.some((n,i)=>Math.abs(n-pillars[i].sign)>1e-8)) throw new Error(`${name} paired winding does not complete the intended signed turn around every pillar.`);
    const copperLengthMm=paths.reduce((sum,p)=>sum+pathLength(p.pts),0),viaLengthMm=stack[wi+2].z-stack[wi].z;
    windings.push({name,net,turnsPerPillar:1,signs:measuredTurns.map(Math.round),measuredTurns,
      lengthMm:copperLengthMm+viaLengthMm,copperLengthMm,viaLengthMm,layers,paths,radiusMm:radii[wi],terminals:[plus,minus],transition:join,
      conductorWidthMm:c.traceWidth,copperThicknessMm,viaDrillMm:drill,viaPlatingMm:.025});
  }
  const clearances=validateCopper(art,pillars,holeRadius,c.clearance);
  // Include the terminal legends and their stroke in the board envelope, with
  // enough edge clearance for KiCad's default 0.5 mm silk constraint.
  const copperBounds=artworkBounds(art),edgeMargin=Math.max(2.5,c.clearance+.5);
  const minX=copperBounds.x0-edgeMargin,maxX=copperBounds.x1+edgeMargin,minY=copperBounds.y0-edgeMargin,maxY=copperBounds.y1+edgeMargin;
  art.outline.push({layer:'Edge.Cuts',pts:rect(minX,minY,maxX,maxY),role:'board-boundary'});
  for(const p of pillars) art.outline.push({layer:'Edge.Cuts',pts:circle(p.x,p.y,holeRadius),role:'core-opening',pillarId:p.id});
  const edge=c.pillarDiameter/2+Math.max(c.plateThickness,c.coreClearance);
  const coreBounds={minX:-halfX-edge,maxX:halfX+edge,minY:-halfY-edge,maxY:halfY+edge,width:2*(halfX+edge),height:2*(halfY+edge)};
  const checks=[
    {level:'pass',title:'Every pillar has one complete turn',detail:`Both independently traced electrical paths link all ${pillars.length} pillars with the required alternating +1 / −1 turns.`},
    {level:'pass',title:'Copper and through-hole clearances',detail:`No same-layer crossings or bypass connections. Minimum core-opening clearance ${clearances.coreClearanceMm.toFixed(2)} mm; connection clearance ${clearances.barrelClearanceMm.toFixed(2)} mm.`},
    {level:'pass',title:'Four-layer 1:1 winding',detail:'P: F.Cu → In2.Cu. S: In1.Cu → B.Cu. Each pair contains complementary half-turns connected by one through-via.'},
    {level:'warning',title:'Custom core assembly',detail:'The pillar grid and plates require a separately manufactured core assembly. Their dimensions do not identify a catalog part.'},
    {level:'warning',title:'Board holes and isolation',detail:'The PCB export includes every pillar opening. Live KiCad placement inserts copper only; provide matching cutouts in the destination board. Geometry clearance is not an electrical isolation rating.'},
  ];
  art.notes=checks.map(q=>({level:q.level==='pass'?'info':'warn',text:`${q.title}: ${q.detail}`}));
  return {art,pillars,windings,bounds:bounding(artworkBounds(art)),coreBounds,stack,checks,clearances,
    config:c,holeDiameterMm:2*holeRadius,windowHeightMm,coreHeightMm:2*c.plateThickness+windowHeightMm,
    ferritePillarHeightMm:windowHeightMm-c.gap,copperThicknessMm,dielectricThicknessMm,viaDiameterMm:diameter,viaDrillMm:drill};
}
