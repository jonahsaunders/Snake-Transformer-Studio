import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, escapeHtml, format } from '../web/js/snake/config.js';
import { buildSnakeGeometry } from '../web/js/snake/geometry.js';
import { simulateSnake } from '../web/js/snake/physics.js';
import { projectText, readProject, readMeasurements, exportFiles, buildZip, reportHtml, fileStem } from '../web/js/snake/io.js';
import { metric, checksHtml, notesHtml, lineChart, renderGeometry } from '../web/js/snake/view.js';

const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const c = normalizeConfig(DEFAULTS), g = buildSnakeGeometry(c), s = simulateSnake(c, g);
const serialized = projectText(c);
assert.deepEqual(readProject(serialized), c, 'Saved project restores every normalized input.');
assert.equal(JSON.parse(serialized).application, 'Snake Transformer Studio');
assert.equal(JSON.parse(serialized).schema, 1);
for (const bad of ['null', '[]', '{}', '{broken', JSON.stringify({ application: 'Planar Studio', schema: 1, config: c }),
  JSON.stringify({ application: 'Snake Transformer Studio', schema: 99, config: c }),
  JSON.stringify({ application: 'Snake Transformer Studio', schema: 1 })]) assert.throws(() => readProject(bad));
assert.throws(() => readProject(' '.repeat(1000001)), /1 MB/);
for (const value of [NaN, Infinity, -Infinity, null, '800000', -1, 1e20]) assert.throws(() => normalizeConfig({ ...c, frequency: value }), /frequency/);
for (const bad of [{ rows: 3 }, { cols: 0 }, { primaryTurns: 2 }, { secondaryTurns: 2 }, { drive: 'dc' },
  { primaryNet: 'same', secondaryNet: 'same' }, { primaryNet: 'bad"net' }, { secondaryNet: 'x\nnet' }]) assert.throws(() => normalizeConfig({ ...c, ...bad }));
const pollution = readProject(JSON.stringify({ application: 'Snake Transformer Studio', schema: 1,
  config: JSON.parse('{"__proto__":{"polluted":true},"unexpected":"discarded"}') }));
assert.equal(({}).polluted, undefined);
assert.equal(Object.getPrototypeOf(pollution), Object.prototype);
assert.equal(Object.hasOwn(pollution, 'unexpected'), false);

const measurements = readMeasurements('RAC_OHM,Frequency_Hz\r\n0.3,800000\r\n0,100000\r\n0.15,400000\r\n');
assert.deepEqual(measurements, [[100000, 0], [400000, .15], [800000, .3]]);
for (const [label, csv] of [
  ['missing required header', 'frequency_hz,impedance\n100,1\n200,2'],
  ['one point', 'frequency_hz,rac_ohm\n100,1'],
  ['missing resistance', 'frequency_hz,rac_ohm\n100,\n200,2'],
  ['whitespace resistance', 'frequency_hz,rac_ohm\n100, \n200,2'],
  ['negative resistance', 'frequency_hz,rac_ohm\n100,-1\n200,2'],
  ['zero frequency', 'frequency_hz,rac_ohm\n0,1\n200,2'],
  ['nonfinite resistance', 'frequency_hz,rac_ohm\n100,Infinity\n200,2'],
  ['nonnumeric resistance', 'frequency_hz,rac_ohm\n100,foo\n200,2'],
  ['duplicate frequency', 'frequency_hz,rac_ohm\n100,1\n100,2'],
  ['duplicate required header', 'frequency_hz,rac_ohm,rac_ohm\n100,1,2\n200,2,3'],
  ['malformed quoted value', 'frequency_hz,rac_ohm\n"100,000",1\n200,2'],
]) assert.throws(() => readMeasurements(csv), undefined, label);
assert.throws(() => readMeasurements('x'.repeat(2000001)), /2 MB/);

// Names remain editable text but must not become markup, executable attributes,
// path traversal, or injected net-name syntax in an exported artifact.
const payload = '<img src=x onerror="boom()"><script>boom()</script>&';
const hostile = normalizeConfig({ ...c, name: payload }), hostileG = buildSnakeGeometry(hostile), hostileS = simulateSnake(hostile, hostileG);
const safeFragments = [reportHtml(hostile, hostileG, hostileS), metric(payload, payload, payload),
  checksHtml([{ level: 'warning', title: payload, detail: payload }]), notesHtml([payload]),
  lineChart([{ data: [[1, 2], [2, 3]] }], { xlabel: payload, ylabel: payload })];
for (const html of safeFragments) {
  assert.ok(!/<(?:script|img)\b/i.test(html), 'User text cannot add active markup.');
  assert.ok(!/\s(?:onload|onerror)\s*=\s*["']/i.test(html), 'User text cannot add event-handler attributes.');
  assert.ok(html.includes('&lt;'), 'User text is escaped rather than inserted raw.');
}
assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
assert.match(fileStem('../../..'), /^[A-Za-z0-9_-]+$/);
assert.match(fileStem(payload), /^[A-Za-z0-9_-]+$/);
assert.equal(fileStem(''), 'snake-transformer');
assert.equal(format(null, 'W'), 'Unknown');
assert.equal(format(NaN, 'W'), 'Unknown');
assert.equal(format(0, 'W'), '0 W');
assert.ok(!/NaN|Infinity/.test(renderGeometry(g, c)), 'Default view has finite projected geometry.');

const files = exportFiles(c, g, s), stem = fileStem(c.name);
const suffixes = ['.snake.json', '.kicad_pcb', '.kicad_mod', '.kicad_dru', '.svg', '.dxf', '-report.html', '-analysis.json',
  '-core-plate.stl', '-core-pillar.stl', '-core-assembly.json'];
assert.deepEqual(Object.keys(files).sort(), [...suffixes.map(t => stem + t), 'READ-ME.txt'].sort());
assert.deepEqual(readProject(files[stem + '.snake.json']), c);
const analysis = JSON.parse(files[stem + '-analysis.json']);
assert.deepEqual(analysis.config, c);
close(analysis.simulation.metrics.Lm, s.metrics.Lm);
assert.equal(analysis.simulation.metrics.coreLoss, null);
const report = files[stem + '-report.html'];
for (const label of ['Core loss', 'Total transformer loss', 'Transformer efficiency', 'Assembly temperature']) {
  assert.ok(report.includes(`<th>${label}</th><td>Unknown</td>`), `${label} remains explicitly unknown in the report.`);
}
const known = simulateSnake({ ...c, coreLossDensity: 100 }, g);
const knownReport = reportHtml({ ...c, coreLossDensity: 100 }, g, known);
assert.ok(!knownReport.includes('<th>Core loss</th><td>Unknown</td>'));
assert.ok(knownReport.includes('<th>Transformer efficiency</th><td>') && knownReport.includes('%</td>'));
assert.ok(report.includes('Unknown values are not verified passes'));
assert.ok(files[stem + '.kicad_pcb'].includes('(generator "snake-transformer-studio")'));
assert.ok(files[stem + '.kicad_pcb'].includes('In1.Cu') && files[stem + '.kicad_pcb'].includes('In2.Cu'));
assert.ok(files[stem + '.kicad_pcb'].includes(c.primaryNet) && files[stem + '.kicad_pcb'].includes(c.secondaryNet));

// Independent ASCII-STL topology and dimensional checks. Coincident vertices
// are quantized only for floating-point sin(2π) closure of the circular mesh.
function inspectStl(text) {
  assert.match(text, /^solid /);
  assert.match(text, /endsolid [^\n]+\s*$/);
  const vertices = [...text.matchAll(/vertex\s+([^\n]+)/g)].map(m => m[1].trim().split(/\s+/).map(Number));
  assert.equal(vertices.length % 3, 0);
  assert.ok(vertices.every(p => p.length === 3 && p.every(Number.isFinite)));
  const key = p => p.map(v => Math.round(v * 1e8)).join(','), edgeCounts = new Map(), unique = new Set(vertices.map(key));
  let signedVolume = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const [a, b, d] = vertices.slice(i, i + 3), u = b.map((v, j) => v - a[j]), v = d.map((x, j) => x - a[j]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(Math.hypot(...cross) > 1e-12, 'Every STL facet has positive area.');
    signedVolume += (a[0] * (b[1] * d[2] - b[2] * d[1]) + a[1] * (b[2] * d[0] - b[0] * d[2]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
    for (const [from, to] of [[a, b], [b, d], [d, a]]) {
      const f = key(from), t = key(to), id = [f, t].sort().join('|'), record = edgeCounts.get(id) || { count: 0, direction: 0 };
      record.count++; record.direction += f < t ? 1 : -1; edgeCounts.set(id, record);
    }
  }
  assert.ok([...edgeCounts.values()].every(e => e.count === 2 && e.direction === 0), 'STL is a closed consistently oriented two-manifold.');
  assert.equal(unique.size - edgeCounts.size + vertices.length / 3, 2, 'STL topology is one closed genus-zero solid.');
  assert.ok(signedVolume > 0, 'Facet winding points outward.');
  return { dimensions: [0, 1, 2].map(i => Math.max(...vertices.map(p => p[i])) - Math.min(...vertices.map(p => p[i]))), volume: signedVolume };
}
const assembly = JSON.parse(files[stem + '-core-assembly.json']);
assert.equal(assembly.units, 'mm');
assert.equal(assembly.plates.quantity, 2);
assert.equal(assembly.pillars.quantity, c.rows * c.cols);
assert.equal(assembly.pillars.positions.length, g.pillars.length);
close(assembly.totalHeight, s.metrics.heightMm);
close(assembly.windowHeight, c.boardThickness + 2 * c.coreClearance);
close(assembly.pillars.height + assembly.totalGapPerPillar, assembly.windowHeight);
const plate = inspectStl(files[stem + '-core-plate.stl']), pillar = inspectStl(files[stem + '-core-pillar.stl']);
plate.dimensions.forEach((v, i) => close(v, [assembly.plates.width, assembly.plates.depth, assembly.plates.thickness][i]));
pillar.dimensions.forEach((v, i) => close(v, [assembly.pillars.diameter, assembly.pillars.diameter, assembly.pillars.height][i]));
close(plate.volume, assembly.plates.width * assembly.plates.depth * assembly.plates.thickness);
close(pillar.volume, Math.PI * (c.pillarDiameter / 2) ** 2 * assembly.pillars.height, .002);

// Parse the independently specified ZIP records, verify their stored CRCs and
// central-directory offsets, and ensure the complete handoff is readable.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let v = n; for (let i = 0; i < 8; i++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; return v >>> 0;
});
const crc = bytes => (bytes.reduce((c, b) => crcTable[(c ^ b) & 255] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
assert.equal(crc(new TextEncoder().encode('123456789')), 0xcbf43926, 'Standard CRC-32 reference vector.');
const zip = buildZip(c, g, s), dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength), decoder = new TextDecoder(), entries = new Map();
let offset = 0;
while (dv.getUint32(offset, true) === 0x04034b50) {
  assert.equal(dv.getUint16(offset + 8, true), 0, 'ZIP entries use the portable store method.');
  const size = dv.getUint32(offset + 18, true), nameLength = dv.getUint16(offset + 26, true), extra = dv.getUint16(offset + 28, true);
  const name = decoder.decode(zip.slice(offset + 30, offset + 30 + nameLength));
  assert.ok(!/[\\/]/.test(name) && !name.includes('..'), 'Archive entry is a flat safe filename.');
  const start = offset + 30 + nameLength + extra, data = zip.slice(start, start + size);
  assert.equal(crc(data), dv.getUint32(offset + 14, true), `${name} CRC`);
  assert.equal(decoder.decode(data), files[name], `${name} content`);
  entries.set(name, offset); offset = start + size;
}
const centralStart = offset; let centralCount = 0;
while (dv.getUint32(offset, true) === 0x02014b50) {
  const nameLength = dv.getUint16(offset + 28, true), extra = dv.getUint16(offset + 30, true), comment = dv.getUint16(offset + 32, true);
  const name = decoder.decode(zip.slice(offset + 46, offset + 46 + nameLength));
  assert.equal(dv.getUint32(offset + 42, true), entries.get(name), `${name} central-directory offset`);
  centralCount++; offset += 46 + nameLength + extra + comment;
}
assert.equal(dv.getUint32(offset, true), 0x06054b50);
assert.equal(dv.getUint16(offset + 10, true), entries.size);
assert.equal(dv.getUint32(offset + 16, true), centralStart);
assert.equal(centralCount, entries.size);
assert.equal(offset + 22, zip.length);
assert.deepEqual([...entries.keys()].sort(), Object.keys(files).sort());
console.log('Snake IO: project validation, measurement rejection, HTML escaping, report unknowns, ZIP CRC/inventory and watertight mechanical dimensions passed.');
