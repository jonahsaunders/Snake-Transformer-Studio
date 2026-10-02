import {escapeHtml as e,format} from './config.js';
export const COLORS={'F.Cu':'#eeaa69','In1.Cu':'#79cfc6','In2.Cu':'#c9874b','B.Cu':'#4ba59f'};
const path=pts=>pts.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ');
export function renderGeometry(g,c,{mode='3d',yaw=-.65,tilt=.7,explode=0,primary=true,secondary=true,showCore=true,zoom=1}={}){
 const b=g.bounds,cb=g.coreBounds||b,pc=c.plateThickness,h=g.windowHeightMm||c.boardThickness+2*c.coreClearance;
 const stack=g.stack||[];let shapes=[];
 const proj=(x,y,z)=>{if(mode==='top')return [x,-y];const u=x*Math.cos(yaw)-y*Math.sin(yaw),v=x*Math.sin(yaw)+y*Math.cos(yaw);return [u,v*Math.sin(tilt)-z*Math.cos(tilt)];};
 const polygon=(pts,fill,stroke='#57727c',op=1)=>`<path d="${path(pts.map(p=>proj(...p)))}Z" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width=".08"/>`;
 const box=(x0,y0,x1,y1,z0,z1,color,op=1)=>{
 shapes.push(polygon([[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1]],color,'#49616b',op));
 shapes.push(polygon([[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1]],color,'#49616b',op));
 shapes.push(polygon([[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]],color,'#71848b',op));
 };
 if(mode==='3d'&&showCore)box(cb.minX,cb.minY,cb.maxX,cb.maxY,0,pc,'#34454e');
 if(mode==='top')shapes.push(polygon([[b.minX,b.minY,0],[b.maxX,b.minY,0],[b.maxX,b.maxY,0],[b.minX,b.maxY,0]],'#163b3e','#426367',.75));
 else box(b.minX,b.minY,b.maxX,b.maxY,pc+c.coreClearance+explode,pc+c.coreClearance+c.boardThickness+explode,'#1c4b48',.65);
 for(const t of [...g.art.tracks].reverse()){
  const isP=t.winding?t.winding==='P':t.net===c.primaryNet;if(isP&&!primary||!isP&&!secondary)continue;
  const layerIndex=stack.findIndex(s=>s.layer===t.layer),z=pc+c.coreClearance+(stack[layerIndex]?.z??c.boardThickness/2)+explode+Math.max(0,3-layerIndex)*explode*.18;
  shapes.push(`<path d="${path(t.pts.map(([x,y])=>proj(x,y,z)))}" stroke="${COLORS[t.layer]||COLORS[isP?'F.Cu':'B.Cu']}" stroke-width="${t.width}" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${mode==='top'&&layerIndex>1?.55:.95}"/>`);
 }
 for(const p of g.pillars){
  const r=c.pillarDiameter/2,z0=pc,z1=pc+h-c.gap;
  const circle=z=>Array.from({length:33},(_,i)=>[p.x+r*Math.cos(i*Math.PI/16),p.y+r*Math.sin(i*Math.PI/16),z]);
  if(mode==='3d'&&showCore){const bottom=circle(z0),top=circle(z1);for(let k=0;k<32;k++)shapes.push(polygon([bottom[k],bottom[k+1],top[k+1],top[k]],'#495a63','#455d63',.93));shapes.push(polygon(top,'#879293','#a1b1b0'));}
  if(mode==='top'){shapes.push(polygon(circle(0),'#122028','#587681'));const [x,y]=proj(p.x,p.y,0);shapes.push(`<text x="${x}" y="${y+.55}" text-anchor="middle" font-size="1.5" fill="${p.sign>0?'#b0d9cc':'#e4b2aa'}">${p.sign>0?'↑':'↓'}</text>`);}
 }
 if(mode==='3d'&&showCore)box(cb.minX,cb.minY,cb.maxX,cb.maxY,pc+h+explode*1.8,pc+h+pc+explode*1.8,'#74928b',.2);
 for(const p of g.art.pads){const [x,y]=proj(p.x,p.y,pc+c.coreClearance+c.boardThickness+explode);shapes.push(`<circle cx="${x}" cy="${y}" r="${p.w/2}" fill="#c4a26a" stroke="#dcd2a7" stroke-width=".1"/><circle cx="${x}" cy="${y}" r="${(p.drill||.5)/2}" fill="#0e161c"/>`);}
 const corners=[];for(const x of [b.minX-4,b.maxX+4])for(const y of [b.minY-4,b.maxY+4])for(const z of [0,pc*2+h+explode*2+6])corners.push(proj(x,y,z));
 const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);const w=(x1-x0)/zoom,hh=(y1-y0)/zoom;
 return `<svg id="geometry-svg" role="img" aria-label="${mode==='3d'?'Three-dimensional core and winding preview. Drag to rotate.':'Copper paths and checkerboard core pillars'}" viewBox="${(x0+x1-w)/2} ${(y0+y1-hh)/2} ${w} ${hh}">${shapes.join('')}</svg>`;
}
export function metric(label,value,sub='',accent=false,bar=null){return `<div class="metric${accent?' accent':''}"><div class="label">${e(label)}</div><div class="value">${e(value)}</div><div class="sub">${e(sub)}</div>${bar==null?'':`<div class="bar"><i style="background:${bar>=100?'var(--error)':'var(--teal)'};width:${Math.min(100,Math.max(0,bar))}%"></i></div>`}</div>`;}
export function checksHtml(checks){return checks.map(q=>`<div class="check ${e(q.level)}"><span class="check-mark">${q.level==='error'?'×':q.level==='warning'?'!':q.level==='info'?'i':'✓'}</span><div><strong>${e(q.title)}</strong><span class="detail">${e(q.detail||'')}</span></div></div>`).join('');}
export function notesHtml(notes){return `<details class="model-notes"><summary>Model assumptions & limits</summary><ul>${notes.map(s=>`<li>${e(s)}</li>`).join('')}</ul><div class="source-link">Design concept: <a target="_blank" rel="noopener" href="https://lirias.kuleuven.be/4432772">Hans Wouters, KU Leuven, 2026</a>. This tool is an independent analytical implementation; its examples are not reproductions of the measured research prototype.</div></details>`;}
export function lineChart(series,{xlabel='Frequency (kHz)',ylabel='',logx=false,height=250}={}){
 const W=620,H=height,L=57,R=20,T=25,B=44,all=series.flatMap(s=>s.data.filter(p=>p.every(Number.isFinite)));if(!all.length)return `<div class="empty"><p>No valid samples at these conditions.</p></div>`;
 const tx=x=>logx?Math.log10(Math.max(x,1e-12)):x,xs=all.map(p=>tx(p[0])),ys=all.map(p=>p[1]);let xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(0,...ys),ymax=Math.max(...ys);if(xmax===xmin)xmax+=1;if(ymax===ymin)ymax=ymin+1;ymax+=(ymax-ymin)*.1;
 const X=x=>L+(tx(x)-xmin)/(xmax-xmin)*(W-L-R),Y=y=>H-B-(y-ymin)/(ymax-ymin)*(H-T-B);let svg='';
 for(let i=0;i<=4;i++){const y=ymin+(ymax-ymin)*i/4,py=Y(y);svg+=`<line class="grid" x1="${L}" y1="${py}" x2="${W-R}" y2="${py}"/><text x="${L-8}" y="${py+4}" text-anchor="end">${Number(y.toPrecision(3))}</text>`;const xx=xmin+(xmax-xmin)*i/4,x=logx?10**xx:xx;svg+=`<text x="${X(x)}" y="${H-B+18}" text-anchor="middle">${Number(x.toPrecision(3))}</text>`;}
 for(const s of series){const data=s.data.filter(p=>p.every(Number.isFinite));svg+=`<path d="${path(data.map(([x,y])=>[X(x),Y(y)]))}" fill="none" stroke="${s.color||'#e4a063'}" stroke-width="2.5"${s.dash?' stroke-dasharray="5 4"':''}/>`;}
 return `<svg class="plot" role="img" aria-label="${e(ylabel)} versus ${e(xlabel)}" viewBox="0 0 ${W} ${H}">${svg}<text x="${(L+W-R)/2}" y="${H-4}" text-anchor="middle">${e(xlabel)}</text><text x="${L}" y="15">${e(ylabel)}</text></svg>`;
}
export function fluxGrid(sim,c){const arr=sim.pillars||[];return `<div class="heatmap" style="grid-template-columns:repeat(${c.cols},1fr)">${arr.map((p,i)=>{const B=Math.abs(p.fluxDensity??p.B??0),fraction=Math.min(1,B/c.fluxLimit),r=Math.round(31+140*fraction),g=Math.round(90-25*fraction);return `<div class="flux-cell" style="background:rgb(${r},${g},76)" title="Pillar ${e(p.id??i+1)}: peak flux density"><b>${(p.sign??(i%2?-1:1))>0?'↑':'↓'} ${format(B*1000,'',3)}</b><small>${e(p.id??i+1)} · mT</small></div>`;}).join('')}</div>`;}
