export const VERSION = '0.1.0';
export const DEFAULTS = Object.freeze({name:'Matrix 16',rows:4,cols:4,pitch:10,pillarDiameter:4,plateThickness:1.2,boardThickness:1.6,gap:0.05,coreClearance:0.35,traceWidth:0.8,clearance:0.3,copperOz:2,primaryTurns:1,secondaryTurns:1,frequency:800000,inputVoltage:48,outputPower:100,muR:2000,fluxLimit:0.18,ambient:25,thermalResistance:4,coreLossDensity:0,drive:'square',primaryNet:'PRIMARY',secondaryNet:'SECONDARY'});
export const PRESETS = [
 {name:'Matrix 16',description:'4 × 4 pillars · 48 V · 800 kHz',patch:{...DEFAULTS}},
 {name:'Bench 4',description:'2 × 2 pillars · 12 V · 500 kHz',patch:{...DEFAULTS,name:'Bench 4',rows:2,cols:2,frequency:500000,inputVoltage:12,outputPower:20}},
 {name:'Slim 8',description:'2 × 4 pillars · 24 V · 500 kHz',patch:{...DEFAULTS,name:'Slim 8',rows:2,cols:4,frequency:500000,inputVoltage:24,outputPower:50,plateThickness:1}}
];
export const FIELDS = [
 {title:'Core geometry',items:[['rows','Rows','select',[[2,'2'],[4,'4']]],['cols','Columns','select',[[2,'2'],[4,'4']]],['pitch','Pillar pitch','mm',7,30,.5],['pillarDiameter','Pillar diameter','mm',2,12,.1],['plateThickness','Plate thickness','mm',.5,5,.1],['gap','Total gap per pillar','mm',0,1,.01],['coreClearance','Core assembly clearance','mm',.15,2,.05]]},
 {title:'Copper & board',items:[['traceWidth','Trace width','mm',.25,2,.05],['clearance','Copper clearance','mm',.15,1,.05],['copperOz','Copper weight','oz',.5,4,.5],['boardThickness','Board thickness','mm',.8,3.2,.1]]},
 {title:'Operating point',items:[['inputVoltage','Primary voltage','V',1,800,1],['frequency','Frequency','kHz',10,2000,10,1000],['outputPower','Target load power','W',1,10000,5],['drive','Drive waveform','select',[['square','Bipolar square'],['sine','Sinusoidal']]]]},
 {title:'Material & cooling',items:[['muR','Relative permeability','',50,10000,50],['fluxLimit','Peak flux limit','T',.03,.5,.01],['coreLossDensity','Core loss at this point','kW/m³',0,5000,1],['ambient','Ambient temperature','°C',-20,100,1],['thermalResistance','Assembly thermal resistance','K/W',0,50,.5]]}
];
export function normalizeConfig(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected a project configuration.');
 const c={...DEFAULTS};
 for(const key of Object.keys(DEFAULTS))if(Object.hasOwn(input,key))c[key]=input[key];
 c.name=String(c.name).trim().slice(0,64)||'Snake transformer';
 for(const [key,value] of Object.entries(DEFAULTS))if(typeof value==='number'&&(!Number.isFinite(c[key])||typeof c[key]!=='number'))throw new Error(`Invalid number: ${key}.`);
 for(const key of ['primaryNet','secondaryNet'])if(typeof c[key]!=='string'||!/^[A-Za-z0-9_+./-]{1,64}$/.test(c[key]))throw new Error('Net names may use letters, numbers, underscores, +, dots, slashes and hyphens (64 characters maximum).');
 if(c.primaryNet===c.secondaryNet)throw new Error('Primary and secondary need different net names.');
 if(!['square','sine'].includes(c.drive))throw new Error('Choose square or sinusoidal drive.');
 for(const group of FIELDS)for(const [key,,unit,min,max] of group.items){if(unit==='select'){if(!min.some(([v])=>v===c[key]))throw new Error(`Unsupported ${key}.`);}else if(c[key]<min*(group.items.find(x=>x[0]===key)?.[6]||1)||c[key]>max*(group.items.find(x=>x[0]===key)?.[6]||1))throw new Error(`${key} is outside its supported range.`);}
 if(c.primaryTurns!==1||c.secondaryTurns!==1)throw new Error('This version supports one turn per pillar in each winding (1:1 ratio).');
 return c;
}
export const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
export function format(v,unit='',digits=3){if(v==null||!Number.isFinite(v))return 'Unknown';if(v===0)return `0${unit?' '+unit:''}`;const abs=Math.abs(v);if(['H','Ω','F'].includes(unit)){const scales=[[1e6,'M'],[1e3,'k'],[1,''],[1e-3,'m'],[1e-6,'µ'],[1e-9,'n'],[1e-12,'p']];const [scale,prefix]=scales.find(([scale])=>abs>=scale)||scales.at(-1);return `${Number((v/scale).toPrecision(digits))} ${prefix}${unit}`;}return `${Number(v.toPrecision(digits))}${unit?' '+unit:''}`;}
