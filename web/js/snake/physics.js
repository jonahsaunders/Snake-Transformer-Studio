/* Experimental, linear multi-pillar magnetic circuit. Dimensions entering this
 * module are mm; calculations use SI. See docs/snake-models.md for boundaries.
 * This is a reluctance-network and local foil estimate, not a field solver. */
import { C } from '../engine/complex.js';

const MU0 = 4e-7 * Math.PI, RHO = 1.724e-8, OZ = 35e-6;
const zero2 = () => [[0, 0], [0, 0]];
const sum = a => a.reduce((s, x) => s + x, 0);
const magnitude2 = a => a[0] ** 2 + a[1] ** 2;
const mm = x => x * 1e-3;
const defaults = { rows: 4, cols: 4, pitch: 10, pillarDiameter: 4, plateThickness: 1.2,
  boardThickness: 1.6, gap: .05, coreClearance: .35, traceWidth: .8, clearance: .3,
  copperOz: 2, primaryTurns: 1, secondaryTurns: 1, frequency: 800000,
  inputVoltage: 48, outputPower: 100, muR: 2000, fluxLimit: .18, ambient: 25,
  thermalResistance: 4, coreLossDensity: 0, drive: 'square' };

function configuration(input, geometry) {
  const c = { ...defaults, ...input };
  const limits = { rows: [1, 8], cols: [1, 8], pitch: [1, 200], pillarDiameter: [.1, 100],
    plateThickness: [.05, 30], boardThickness: [.1, 10], gap: [0, 10], traceWidth: [.05, 30],
    clearance: [.05, 10], coreClearance: [0, 10], copperOz: [.25, 10], primaryTurns: [1, 100], secondaryTurns: [1, 100],
    frequency: [100, 1e7], inputVoltage: [.001, 2000], outputPower: [0, 1e6],
    muR: [1, 50000], fluxLimit: [.001, 2], ambient: [-40, 150], thermalResistance: [0, 1e5],
    coreLossDensity: [0, 1e6] };
  for (const [key, [lo, hi]] of Object.entries(limits)) {
    if (!Number.isFinite(c[key]) || c[key] < lo || c[key] > hi) throw new Error(`${key} must be between ${lo} and ${hi}.`);
  }
  if (!Number.isInteger(c.rows) || !Number.isInteger(c.cols)) throw new Error('Pillar row and column counts must be integers.');
  if (!['sine', 'square'].includes(c.drive)) throw new Error('Drive must be sine or square.');
  if (c.copperTemperature != null && (!Number.isFinite(c.copperTemperature) || c.copperTemperature < -40 || c.copperTemperature > 200)) throw new Error('Copper temperature must be between −40 and 200 °C.');
  if (c.gap >= c.boardThickness + 2 * c.coreClearance) throw new Error('Air gap must be smaller than the core window height.');
  if (!(c.pitch > c.pillarDiameter + 2 * c.clearance)) throw new Error('Pillar pitch leaves no positive winding window.');
  if (!geometry?.pillars?.length || geometry.pillars.length !== c.rows * c.cols || geometry.windings?.length !== 2) throw new Error('Simulation needs the generated pillar grid and two routed windings.');
  if (geometry.pillars.length < 2) throw new Error('The magnetic circuit needs at least two pillars to close a return path.');
  geometry.windings.forEach(w => {
    if (!(w.turnsPerPillar > 0) || w.signs?.length !== geometry.pillars.length || w.signs.some(s => ![-1, 1].includes(s))) throw new Error('Every winding needs a verified signed turn around every pillar.');
    if (!(w.lengthMm > 0)) throw new Error('Winding copper length is missing.');
  });
  return c;
}

// Gaussian elimination with pivoting; one grounded magnetic-potential node
// removes only the potential gauge, never a physical return path.
function solveReal(matrix, rhs) {
  const n = rhs.length, a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i][k]) > Math.abs(a[p][k])) p = i;
    if (!(Math.abs(a[p][k]) > 1e-30)) throw new Error('The magnetic return network is disconnected.');
    [a[k], a[p]] = [a[p], a[k]];
    for (let i = k + 1; i < n; i++) {
      const f = a[i][k] / a[k][k];
      for (let j = k + 1; j <= n; j++) a[i][j] -= f * a[k][j];
      a[i][k] = 0;
    }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) x[i] = (a[i][n] - sum(a[i].slice(i + 1, n).map((v, j) => v * x[i + 1 + j]))) / a[i][i];
  return x;
}

function magneticCircuit(c, geometry) {
  const count = geometry.pillars.length, nodes = 2 * count, area = Math.PI * mm(c.pillarDiameter) ** 2 / 4;
  const plateArea = mm(c.plateThickness) * mm(c.pitch), edges = [];
  const ferritePillarHeight = c.boardThickness + 2 * c.coreClearance - c.gap;
  const pillarR = (mm(ferritePillarHeight) / c.muR + mm(c.gap)) / (MU0 * area);
  const byCell = new Map(geometry.pillars.map((p, i) => [`${p.row},${p.col}`, i]));
  const linkage = geometry.windings.map(w => w.signs.map(s => s * w.turnsPerPillar));
  for (let i = 0; i < count; i++) edges.push({ from: i, to: count + i, reluctance: pillarR, area, kind: 'pillar', pillar: i,
    turns: linkage.map(row => row[i]) });
  for (const [i, p] of geometry.pillars.entries()) {
    for (const [dr, dc] of [[0, 1], [1, 0]]) {
      const j = byCell.get(`${p.row + dr},${p.col + dc}`);
      if (j == null) continue;
      const length = mm(Math.hypot(geometry.pillars[j].x - p.x, geometry.pillars[j].y - p.y));
      for (const offset of [0, count]) edges.push({ from: offset + i, to: offset + j, area: plateArea,
        reluctance: length / (MU0 * c.muR * plateArea), kind: 'plate', turns: [0, 0] });
    }
  }
  const k = Array.from({ length: nodes - 1 }, () => Array(nodes - 1).fill(0));
  for (const e of edges) {
    const g = 1 / e.reluctance;
    if (e.from < nodes - 1) k[e.from][e.from] += g;
    if (e.to < nodes - 1) k[e.to][e.to] += g;
    if (e.from < nodes - 1 && e.to < nodes - 1) { k[e.from][e.to] -= g; k[e.to][e.from] -= g; }
  }
  const responses = [0, 1].map(w => {
    const rhs = Array(nodes - 1).fill(0);
    for (const e of edges) {
      const q = e.turns[w] / e.reluctance;
      if (e.from < nodes - 1) rhs[e.from] += q;
      if (e.to < nodes - 1) rhs[e.to] -= q;
    }
    const potential = [...solveReal(k, rhs), 0];
    return edges.map(e => (e.turns[w] - potential[e.from] + potential[e.to]) / e.reluctance);
  });
  const matrix = [0, 1].map(i => [0, 1].map(j => sum(edges.map((e, n) => e.turns[i] * responses[j][n]))));
  // Roundoff can make the two evaluations differ in their last few bits.
  matrix[0][1] = matrix[1][0] = (matrix[0][1] + matrix[1][0]) / 2;
  const residual = responses.map(flux => {
    const balance = Array(nodes).fill(0);
    edges.forEach((e, i) => { balance[e.from] += flux[i]; balance[e.to] -= flux[i]; });
    return Math.max(...balance.map(Math.abs)) / Math.max(1e-30, ...flux.map(Math.abs));
  });
  return { matrix, edges, responses, linkage, nodes, conservationError: Math.max(...residual), area, plateArea };
}

function localSheet(c, geometry) {
  const winding = geometry.windings, copperT = mm(winding[0].copperThicknessMm ?? c.copperOz * OZ * 1000);
  // The two complementary layers each carry half the local linked turn. This
  // approximation is used only for a local window's leakage and foil losses.
  const copperMm = copperT * 1000, dielectricMm = (c.boardThickness - 4 * copperMm) / 3;
  if (!(dielectricMm > 0)) throw new Error('Board thickness must exceed the total copper thickness.');
  const stack = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'].map((layer, i) => ({
    winding: i % 2, layer, z: geometry.stack?.find(s => s.layer === layer)?.z ?? copperMm / 2 + i * (dielectricMm + copperMm) }));
  const build = mm((c.pitch - c.pillarDiameter - 2 * c.clearance) / 2);
  const meanLength = sum(winding.map(w => mm(w.copperLengthMm ?? w.lengthMm) / (geometry.pillars.length * w.turnsPerPillar))) / 2;
  const coefficient = MU0 * meanLength / build;
  const matrix = zero2(), fields = [];
  const integrate = (a, b, dz) => {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) matrix[i][j] += coefficient * dz *
      (2 * a[i] * a[j] + a[i] * b[j] + b[i] * a[j] + 2 * b[i] * b[j]) / 6;
  };
  for (const [pillarIndex, pillar] of geometry.pillars.entries()) {
    const turns = winding.map(w => w.turnsPerPillar * w.signs[pillarIndex]);
    let field = turns.map(n => -n / 2), previous = mm(stack[0].z) - copperT / 2;
    for (const s of stack) {
      const start = mm(s.z) - copperT / 2;
      if (start < previous - 1e-15) throw new Error('Copper layers overlap in the entered board thickness.');
      integrate(field, field, start - previous);
      const next = [...field]; next[s.winding] += turns[s.winding] / 2;
      integrate(field, next, copperT);
      fields.push({ ...s, pillarId: pillar.id, dcWeight: 1 / geometry.pillars.length,
        before: [...field], after: next, average: field.map((v, i) => (v + next[i]) / 2), turns: turns[s.winding] / 2 });
      field = next; previous = start + copperT;
    }
  }
  const rho = RHO * (1 + .00393 * ((c.copperTemperature ?? c.ambient) - 20));
  const dc = winding.map(w => {
    const length = mm(w.copperLengthMm ?? w.lengthMm), barrel = mm(w.viaLengthMm ?? 0);
    const diameter = mm(w.viaDrillMm ?? .4), plating = mm(w.viaPlatingMm ?? .025);
    return { copper: rho * length / (mm(w.conductorWidthMm ?? c.traceWidth) * copperT), barrel: rho * barrel / (Math.PI * diameter * plating) };
  });
  return { matrix, fields, build, copperT, rho, dc };
}

function resistanceAt(c, sheet, frequency) {
  const skinDepth = Math.sqrt(sheet.rho / (Math.PI * frequency * MU0));
  const fill = c.traceWidth / (c.traceWidth + c.clearance), x = sheet.copperT / skinDepth * Math.sqrt(fill);
  let skin, proximity;
  if (x < .01) { skin = 1 + x ** 4 / 180; proximity = x ** 4 / 3; }
  else if (x > 30) { skin = x / 2; proximity = 2 * x; }
  else {
    skin = x / 2 * (Math.sinh(x) + Math.sin(x)) / (Math.cosh(x) - Math.cos(x));
    proximity = 2 * x * (Math.sinh(x) - Math.sin(x)) / (Math.cosh(x) + Math.cos(x));
  }
  const matrix = [[sheet.dc[0].barrel + skin * sheet.dc[0].copper, 0], [0, sheet.dc[1].barrel + skin * sheet.dc[1].copper]];
  for (const s of sheet.fields) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    matrix[i][j] += sheet.dc[s.winding].copper / 2 * s.dcWeight * proximity * s.average[i] * s.average[j] / s.turns ** 2;
  }
  return { matrix, skinDepth, skin, proximity };
}

function prepare(c, geometry) {
  const magnetic = magneticCircuit(c, geometry), sheet = localSheet(c, geometry);
  const matrix = magnetic.matrix.map((row, i) => row.map((v, j) => v + sheet.matrix[i][j]));
  if (!(matrix[0][0] > 0 && matrix[1][1] > 0 && matrix[0][0] * matrix[1][1] - matrix[0][1] ** 2 > 0)) throw new Error('Inductance matrix is not passive. Check linked turns and winding geometry.');
  return { magnetic, sheet, matrix };
}

function harmonic(c, model, order, loadResistance) {
  const frequency = c.frequency * order, omega = 2 * Math.PI * frequency;
  const rmsVoltage = c.drive === 'square' ? 4 * c.inputVoltage / (Math.PI * order * Math.SQRT2) : c.inputVoltage;
  const resistance = resistanceAt(c, model.sheet, frequency), R = resistance.matrix, L = model.matrix;
  const z11 = [R[0][0], omega * L[0][0]], z12 = [R[0][1], omega * L[0][1]], z22 = [R[1][1], omega * L[1][1]];
  let currents;
  if (loadResistance === Infinity) currents = [C.div([rmsVoltage, 0], z11), [0, 0]];
  else {
    const terminated = C.add(z22, [loadResistance, 0]);
    const i1 = C.div([rmsVoltage, 0], C.sub(z11, C.div(C.mul(z12, z12), terminated)));
    currents = [i1, C.neg(C.div(C.mul(z12, i1), terminated))];
  }
  const output = loadResistance === Infinity ? C.mul(z12, currents[0]) : C.scale(currents[1], -loadResistance);
  const copperLoss = sum(currents.map((i, row) => sum(currents.map((j, col) => R[row][col] * (i[0] * j[0] + i[1] * j[1])))));
  const inputPower = rmsVoltage * currents[0][0], outputPower = loadResistance === Infinity ? 0 : magnitude2(output) / loadResistance;
  const flux = model.magnetic.edges.map((_, e) => C.add(C.scale(currents[0], model.magnetic.responses[0][e]), C.scale(currents[1], model.magnetic.responses[1][e])));
  return { order, frequency, rmsVoltage, currents, output, copperLoss, inputPower, outputPower, flux, resistance };
}

function peakOf(phasors, orders) {
  // Sine-reference RMS phasors. Samples include the exact triangle peaks of
  // ideal bipolar-square voltage. Loss and current RMS use harmonic sums.
  let peak = 0;
  for (let sample = 0; sample < 256; sample++) {
    const theta = 2 * Math.PI * sample / 256;
    const v = sum(phasors.map((p, i) => Math.SQRT2 * (p[0] * Math.sin(orders[i] * theta) + p[1] * Math.cos(orders[i] * theta))));
    peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

export function fieldBalanceDiagnostics(config, geometry, currents = [[1, 0], [-1, 0]]) {
  const c = configuration(config, geometry), sheet = localSheet(c, geometry);
  const regions = sheet.fields.map(s => {
    const field = coefficients => coefficients.reduce((acc, v, i) => C.add(acc, C.scale(currents[i], v / sheet.build)), [0, 0]);
    const below = field(s.before), above = field(s.after), average = C.scale(C.add(below, above), .5);
    const denominator = C.abs(below) + C.abs(above);
    return { layer: s.layer, pillarId: s.pillarId, winding: geometry.windings[s.winding].name, below: C.abs(below), above: C.abs(above),
      average: C.abs(average), balanceError: denominator > 1e-15 ? C.abs(C.add(below, above)) / denominator : 0,
      source: 'Local foil approximation at the fundamental; excludes bends, edge fields and gap fringing' };
  });
  return ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'].map(layer => {
    const local = regions.filter(r => r.layer === layer);
    return { layer, winding: local[0].winding,
      ...Object.fromEntries(['below', 'above', 'average', 'balanceError'].map(key => [key, Math.max(...local.map(r => r[key]))])),
      regions: local, source: 'Maximum over local pillar-window foil estimates at the fundamental; excludes bends, edge fields and gap fringing' };
  });
}

function operatingPoint(c, geometry, model, options = {}) {
  const ratio = geometry.windings[0].turnsPerPillar / geometry.windings[1].turnsPerPillar;
  const loadResistance = c.outputPower > 0 ? (c.inputVoltage / ratio) ** 2 / c.outputPower : Infinity;
  const orders = c.drive === 'square' ? Array.from({ length: 16 }, (_, i) => 2 * i + 1) : [1];
  const harmonics = orders.map(order => harmonic(c, model, order, loadResistance));
  const outputPower = sum(harmonics.map(h => h.outputPower)), copperLoss = sum(harmonics.map(h => h.copperLoss));
  const current = [0, 1].map(i => Math.sqrt(sum(harmonics.map(h => magnitude2(h.currents[i])))));
  const copperDc = sum(current.map((i, n) => i ** 2 * (model.sheet.dc[n].copper + model.sheet.dc[n].barrel)));
  const edgePeaks = model.magnetic.edges.map((e, i) => peakOf(harmonics.map(h => h.flux[i]), orders));
  const pillars = geometry.pillars.map((p, i) => ({ ...p, flux: edgePeaks[i], fluxDensity: edgePeaks[i] / model.magnetic.area,
    sign: p.sign, fundamentalFlux: harmonics[0].flux[i] }));
  const maxPillarFlux = Math.max(...pillars.map(p => p.fluxDensity));
  const maxPlateFlux = Math.max(0, ...model.magnetic.edges.map((e, i) => e.kind === 'plate' ? edgePeaks[i] / e.area : 0));
  const maxFlux = Math.max(maxPillarFlux, maxPlateFlux);
  const width = geometry.coreBounds?.width ?? c.cols * c.pitch, depth = geometry.coreBounds?.height ?? c.rows * c.pitch;
  const windowHeight = c.boardThickness + 2 * c.coreClearance;
  const coreVolume = 2 * mm(width) * mm(depth) * mm(c.plateThickness) + geometry.pillars.length * model.magnetic.area * mm(windowHeight - c.gap);
  const heightMm = 2 * c.plateThickness + windowHeight;
  const volumeCm3 = width * depth * heightMm / 1000;
  const coreLoss = c.coreLossDensity > 0 ? c.coreLossDensity * 1000 * coreVolume : null;
  const totalLoss = coreLoss == null ? null : coreLoss + copperLoss;
  const temperature = totalLoss != null && c.thermalResistance > 0 ? c.ambient + totalLoss * c.thermalResistance : null;
  const resistance = harmonics[0].resistance, L = model.matrix;
  const checks = [
    { level: 'info', title: 'Experimental magnetic model', detail: 'A separate top and bottom magnetic-potential node at each pillar solves shared return paths. Plate crowding and fringing require independent field-solver validation.' },
    { level: maxFlux > c.fluxLimit ? 'error' : 'info', title: maxFlux > c.fluxLimit ? 'Flux limit exceeded' : 'Flux below entered limit', detail: `${(maxFlux * 1000).toFixed(1)} mT maximum regional estimate; entered limit ${(c.fluxLimit * 1000).toFixed(0)} mT. Linear permeability does not model saturation.` },
    { level: 'warning', title: 'AC copper loss is approximate', detail: 'Local four-layer foil fields use routed copper length. Snake bends, terminal spreading, gap fringing and 3-D eddy currents are excluded.' },
  ];
  if (coreLoss == null) checks.push({ level: 'warning', title: 'Core loss is unknown', detail: 'Enter measured or manufacturer-supported operating-point loss density for this material, waveform, flux and frequency. Zero means unavailable.' });
  else checks.push({ level: 'warning', title: 'Core loss uses entered density', detail: 'A uniform operating-point loss density is multiplied by physical core volume. It does not automatically scale with frequency or regional flux.' });
  if (temperature == null) checks.push({ level: 'warning', title: 'Temperature is unknown', detail: 'Known core loss and a positive assembly thermal resistance are both required.' });
  if (c.frequency > 500000) checks.push({ level: 'info', title: 'High-frequency material data required', detail: 'No N87 fit is extrapolated here. The existing Planar Studio N87 fit ends at 500 kHz; this design needs its own operating-point material evidence.' });
  if (c.drive === 'square') checks.push({ level: 'info', title: 'Square-wave harmonic approximation', detail: 'Uses 16 odd harmonics through the 31st. Input voltage is bipolar amplitude; flux is reconstructed in time. No rectifier or converter switching loss is included.' });
  const metrics = { Lm: model.magnetic.matrix[0][0], leakage: L[0][0] - L[0][1] ** 2 / L[1][1],
    coupling: L[0][1] / Math.sqrt(L[0][0] * L[1][1]), ratio,
    outputVoltage: Math.sqrt(sum(harmonics.map(h => magnitude2(h.output)))), outputPower,
    primaryCurrent: current[0], secondaryCurrent: current[1], primaryRdc: model.sheet.dc[0].copper + model.sheet.dc[0].barrel,
    secondaryRdc: model.sheet.dc[1].copper + model.sheet.dc[1].barrel,
    primaryRac: resistance.matrix[0][0], secondaryRac: resistance.matrix[1][1],
    copperLoss, copperDc, copperAcExcess: Math.max(0, copperLoss - copperDc), coreLoss, totalLoss,
    efficiency: totalLoss == null ? null : outputPower / (outputPower + totalLoss),
    copperOnlyEfficiency: outputPower / (outputPower + copperLoss), temperature, maxFlux, maxPillarFlux, maxPlateFlux,
    volumeCm3, heightMm, powerDensity: outputPower / volumeCm3, coreVolumeCm3: coreVolume * 1e6,
    skinDepth: resistance.skinDepth, loadResistance, fundamentalPhase: C.arg(harmonics[0].output) * 180 / Math.PI,
    powerBalanceError: sum(harmonics.map(h => h.inputPower - h.outputPower - h.copperLoss)),
    inputPower: sum(harmonics.map(h => h.inputPower)), conservationError: model.magnetic.conservationError };
  const assumptions = [
    'Linear constant permeability; one pillar/gap edge and nearest-neighbor grid edges in both return plates. No nonlinear B-H curve, DC bias or temperature-dependent permeability.',
    'Each plate branch uses pitch × plate thickness cross-section and center-to-center path length. Effective junction/spreading corrections are not calibrated.',
    'The core window is PCB thickness plus twice the assembly clearance. Entered gap is total series air gap per pillar, within that window; ferrite pillar height is window height minus gap. Fringing is excluded.',
    'Four layers are P, S, P, S at the generated physical copper-center heights, including copper thickness. Each complementary layer contributes half a local linked turn; current-sheet fields are an approximation for these nonconcentric paths.',
    'Rac values are the fundamental-frequency resistance-matrix diagonal, with the other winding current zero. Loaded copper loss uses the full matrix including cross terms and all retained harmonics.',
    'Output power input defines a resistor at the ideal turns-ratio voltage. Predicted output is loaded RMS AC; neither rectification nor voltage regulation is modeled.',
    'Core-loss density is an entered operating-point average in kW/m³; zero means unknown. Thermal resistance is a user-supplied lumped assembly value, not a predicted hotspot model.',
    'Core loss is added after the winding circuit solve; it does not alter magnetizing current, transfer voltage or core flux in this model.',
    'Efficiency and W/cm³ describe this estimated transformer and its nominal core envelope, excluding converter semiconductors, capacitors, cooling and connectors.',
    `Copper resistivity is evaluated at ${c.copperTemperature ?? c.ambient} °C without thermal iteration. Via plating is assumed 25 µm; high-frequency via loss is excluded.`,
  ];
  return { metrics, pillars, checks, assumptions, matrix: model.matrix, magnetizingMatrix: model.magnetic.matrix,
    leakageMatrix: model.sheet.matrix, resistanceMatrix: resistance.matrix,
    magneticNetwork: { nodes: model.magnetic.nodes, edges: model.magnetic.edges, unitFlux: model.magnetic.responses, conservationError: model.magnetic.conservationError },
    fieldBalance: options.compact ? [] : fieldBalanceDiagnostics(c, geometry, harmonics[0].currents),
    harmonics: options.compact ? [] : harmonics.map(h => ({ order: h.order, frequency: h.frequency, inputRms: h.rmsVoltage,
      primaryCurrent: C.abs(h.currents[0]), secondaryCurrent: C.abs(h.currents[1]), outputRms: C.abs(h.output), copperLoss: h.copperLoss })),
    schema: 1, model: 'Experimental multi-pillar reluctance network + local foil approximation' };
}

export function simulateSnake(config, geometry) {
  const c = configuration(config, geometry);
  return operatingPoint(c, geometry, prepare(c, geometry));
}

export function sweepSnake(config, geometry, options = {}) {
  const c = configuration(config, geometry), model = prepare(c, geometry);
  const min = options.min ?? Math.max(100, c.frequency / 4), max = options.max ?? Math.min(1e7, c.frequency * 2), points = options.points ?? 25;
  if (!(min >= 100 && max <= 1e7 && max > min && Number.isInteger(points) && points >= 2 && points <= 121)) throw new Error('Sweep requires 100 Hz ≤ min < max ≤ 10 MHz and 2–121 points.');
  const results = Array.from({ length: points }, (_, i) => {
    const frequency = min * (max / min) ** (i / (points - 1));
    // A measured density at one operating point cannot predict another one.
    const lossKnown = Math.abs(frequency / c.frequency - 1) < 1e-10;
    const r = operatingPoint({ ...c, frequency, coreLossDensity: lossKnown ? c.coreLossDensity : 0 }, geometry, model, { compact: true });
    return { frequency, ...r.metrics };
  });
  return { points: results, frequencies: results.map(r => r.frequency),
    assumptions: ['Geometry, permeability, load resistance and copper temperature are fixed. AC copper loss and harmonic circuit are recomputed at each frequency.',
      'Entered core-loss density applies only at its nominal frequency. Core loss, total efficiency and temperature remain unknown at other sweep frequencies.'], schema: 1 };
}
