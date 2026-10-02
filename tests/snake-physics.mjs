import assert from 'node:assert/strict';
import { buildSnakeGeometry } from '../web/js/snake/geometry.js';
import { simulateSnake, sweepSnake, fieldBalanceDiagnostics } from '../web/js/snake/physics.js';

const MU0 = 4e-7 * Math.PI;
const close = (actual, expected, relative, label) => assert.ok(Math.abs(actual - expected) <= relative * Math.max(Math.abs(expected), 1e-30), `${label}: ${actual} versus ${expected}`);
const config = { rows: 4, cols: 4, pitch: 10, pillarDiameter: 4, plateThickness: 1.2,
  boardThickness: 1.6, gap: .05, coreClearance: .35, traceWidth: .8, clearance: .3,
  copperOz: 2, primaryTurns: 1, secondaryTurns: 1, frequency: 800000, inputVoltage: 48,
  outputPower: 100, muR: 2000, fluxLimit: .18, ambient: 25, thermalResistance: 4,
  coreLossDensity: 0, drive: 'square' };

// Independent idealized loops for analytic network checks. No routed-geometry
// implementation is used to construct these magnetic reference cases.
function fixture(c, turns = [1, 1]) {
  const pillars = Array.from({ length: c.rows * c.cols }, (_, i) => ({ id: `leg${i}`, row: Math.floor(i / c.cols),
    col: i % c.cols, x: i % c.cols * c.pitch, y: Math.floor(i / c.cols) * c.pitch,
    sign: (Math.floor(i / c.cols) + i % c.cols) % 2 ? -1 : 1 }));
  return { pillars, windings: turns.map((n, i) => ({ name: i ? 'S' : 'P', turnsPerPillar: n,
    signs: pillars.map(p => p.sign), lengthMm: n * pillars.length * Math.PI * (c.pillarDiameter + 2),
    copperLengthMm: n * pillars.length * Math.PI * (c.pillarDiameter + 2), viaLengthMm: 0 })) };
}

const g = buildSnakeGeometry(config), result = simulateSnake(config, g);
assert.ok(result.metrics.Lm > 0 && result.metrics.leakage > 0 && result.metrics.coupling > 0 && result.metrics.coupling < 1);
assert.equal(result.metrics.coreLoss, null);
assert.equal(result.metrics.totalLoss, null);
assert.equal(result.metrics.temperature, null);
assert.equal(result.metrics.efficiency, null);
assert.ok(result.metrics.copperLoss >= result.metrics.copperDc);
assert.ok(result.metrics.outputPower < config.outputPower);
assert.ok(result.metrics.copperOnlyEfficiency > 0 && result.metrics.copperOnlyEfficiency < 1);
assert.ok(Math.abs(result.metrics.powerBalanceError) < 1e-9 * result.metrics.inputPower, 'Harmonic circuit conserves real power.');
assert.ok(result.metrics.conservationError < 1e-10, 'Every magnetic-potential node conserves flux.');

// A two-pillar assembly has one closed loop: two pillar/gap reluctances and
// one return branch in each plate, driven by two opposite signed turns.
const pair = { ...config, rows: 1, cols: 2, drive: 'sine', outputPower: 0 };
const pairResult = simulateSnake(pair, fixture(pair));
const area = Math.PI * (pair.pillarDiameter * 1e-3) ** 2 / 4;
const ferriteHeight = (pair.boardThickness + 2 * pair.coreClearance - pair.gap) * 1e-3;
const legReluctance = (ferriteHeight / pair.muR + pair.gap * 1e-3) / (MU0 * area);
const plateReluctance = pair.pitch * 1e-3 / (MU0 * pair.muR * pair.pitch * pair.plateThickness * 1e-6);
const expectedL = 4 / (2 * legReluctance + 2 * plateReluctance);
close(pairResult.metrics.Lm, expectedL, 1e-10, 'Two-pillar closed-loop reluctance');
close(pairResult.magnetizingMatrix[0][1], expectedL, 1e-10, 'Two-pillar mutual inductance');

// An independent energy identity checks both linkage sign and return-path
// participation: Iᵀ L I = sum(reluctance × flux²).
const net = result.magneticNetwork, excitation = [1.3, -.4];
const flux = net.edges.map((_, i) => net.unitFlux[0][i] * excitation[0] + net.unitFlux[1][i] * excitation[1]);
const magneticEnergyTwice = net.edges.reduce((s, e, i) => s + e.reluctance * flux[i] ** 2, 0);
const linkedEnergyTwice = excitation.reduce((s, current, i) => s + current * excitation.reduce((t, v, j) => t + result.magnetizingMatrix[i][j] * v, 0), 0);
close(magneticEnergyTwice, linkedEnergyTwice, 1e-10, 'Reluctance energy and terminal linkage agree');
const nodal = Array(net.nodes).fill(0);
net.edges.forEach((e, i) => { nodal[e.from] += flux[i]; nodal[e.to] -= flux[i]; });
assert.ok(Math.max(...nodal.map(Math.abs)) < 1e-15);

// Geometric permutations cannot change a physical network. This also catches
// accidental assumptions that an array index is a spatial neighbor.
const reference = fixture(config), reversed = { ...reference,
  pillars: reference.pillars.slice().reverse(),
  windings: reference.windings.map(w => ({ ...w, signs: w.signs.slice().reverse() })) };
close(simulateSnake(config, reference).metrics.Lm, simulateSnake(config, reversed).metrics.Lm, 1e-10, 'Pillar ordering invariance');
const pillarFlux = simulateSnake(config, reference).pillars.map(p => p.fluxDensity);
pillarFlux.forEach((v, i) => close(v, pillarFlux.at(-i - 1), 1e-9, '180-degree magnetic symmetry'));

const ratioCase = simulateSnake(pair, fixture(pair, [2, 1]));
close(ratioCase.magnetizingMatrix[0][0], 4 * expectedL, 1e-10, 'Turns-squared magnetizing inductance');
close(ratioCase.magnetizingMatrix[0][1], 2 * expectedL, 1e-10, 'Turns-product mutual inductance');
assert.equal(ratioCase.metrics.ratio, 2);
const reversedPolarity = fixture(pair);
reversedPolarity.windings[1].signs = reversedPolarity.windings[1].signs.map(s => -s);
close(simulateSnake(pair, reversedPolarity).magnetizingMatrix[0][1], -expectedL, 1e-10, 'Secondary reversal changes mutual polarity');
const reverseLoaded = simulateSnake({ ...pair, outputPower: 25 }, reversedPolarity);
const normalLoaded = simulateSnake({ ...pair, outputPower: 25 }, fixture(pair));
close(reverseLoaded.metrics.copperLoss, normalLoaded.metrics.copperLoss, 1e-10, 'Reversing terminals preserves physical copper loss');
close(reverseLoaded.metrics.outputVoltage, normalLoaded.metrics.outputVoltage, 1e-10, 'Reversing terminals preserves output RMS');
close(reverseLoaded.metrics.maxFlux, normalLoaded.metrics.maxFlux, 1e-10, 'Reversing terminals preserves core flux');

// Air gaps and plate returns are actual reluctance contributions.
const moreGap = { ...pair, gap: .2 };
assert.ok(simulateSnake(moreGap, fixture(moreGap)).metrics.Lm < pairResult.metrics.Lm);
const thicker = { ...pair, plateThickness: 2.4 };
assert.ok(simulateSnake(thicker, fixture(thicker)).metrics.Lm > pairResult.metrics.Lm);

// At very small current/voltage drop and large permeability, Faraday's law
// gives Bpk = Vrms√2/(ω n Ae) for sine and V/(4 f n Ae) for bipolar square.
const volts = { ...pair, inputVoltage: 1, frequency: 100000, muR: 50000, gap: 0,
  copperOz: 10, traceWidth: 2, plateThickness: 10, outputPower: 0 };
const sine = simulateSnake(volts, fixture(volts));
const sineB = volts.inputVoltage * Math.SQRT2 / (2 * Math.PI * volts.frequency * 2 * area);
close(sine.metrics.maxPillarFlux, sineB, .02, 'Sinusoidal volt-seconds');
const square = simulateSnake({ ...volts, drive: 'square' }, fixture(volts));
close(square.metrics.maxPillarFlux, volts.inputVoltage / (4 * volts.frequency * 2 * area), .03, 'Bipolar square volt-seconds including harmonic truncation');

// Positive-semidefinite resistance, including cross terms, is essential for
// arbitrary load currents; the circuit must never generate copper power.
const resistance = result.resistanceMatrix;
assert.ok(resistance[0][0] > 0 && resistance[1][1] > 0);
assert.ok(resistance[0][0] * resistance[1][1] - resistance[0][1] ** 2 > 0);
const cool = simulateSnake({ ...config, copperTemperature: 20 }, g);
const warm = simulateSnake({ ...config, copperTemperature: 100 }, g);
close(warm.metrics.primaryRdc / cool.metrics.primaryRdc, 1 + .00393 * 80, 1e-12, 'Copper temperature coefficient');
const low = simulateSnake({ ...config, frequency: 100, drive: 'sine' }, g);
close(low.metrics.primaryRac, low.metrics.primaryRdc, 1e-5, 'Low-frequency resistance limit');

// Zero is intentionally missing material data, not a magical lossless core.
const known = simulateSnake({ ...config, coreLossDensity: 100 }, g);
close(known.metrics.coreLoss, known.metrics.coreVolumeCm3 * .1, 1e-12, 'kW/m³ density to watts');
close(known.metrics.temperature, config.ambient + known.metrics.totalLoss * config.thermalResistance, 1e-12, 'Lumped assembly thermal estimate');
assert.ok(known.metrics.efficiency < known.metrics.copperOnlyEfficiency);
assert.equal(simulateSnake({ ...config, coreLossDensity: 100, thermalResistance: 0 }, g).metrics.temperature, null);
const sweep = sweepSnake({ ...config, coreLossDensity: 100 }, g, { min: config.frequency / 2, max: config.frequency * 2, points: 3 });
assert.equal(sweep.points[0].coreLoss, null);
assert.ok(sweep.points[1].coreLoss > 0);
assert.equal(sweep.points[2].temperature, null);
assert.ok(sweep.points[0].maxFlux > sweep.points[2].maxFlux, 'Frequency changes actual volt-seconds.');
assert.ok(sweep.points[0].primaryRac < sweep.points[2].primaryRac, 'Frequency changes foil losses.');
assert.equal(fieldBalanceDiagnostics(config, g).length, 4);
assert.ok(fieldBalanceDiagnostics(config, g).every(s => s.balanceError >= 0 && s.balanceError <= 1 + 1e-12));
assert.throws(() => simulateSnake({ ...config, muR: 0 }, g), /muR/);
assert.throws(() => simulateSnake({ ...config, gap: 4 }, g), /Air gap/);
assert.throws(() => sweepSnake(config, g, { min: 1, max: 1000, points: 3 }), /Sweep/);
assert.throws(() => simulateSnake({ ...config, copperTemperature: NaN }, g), /temperature/);
console.log('Snake physics: analytic reluctance, energy/flux conservation, symmetry, polarity, volt-seconds, passivity, units and unknown-data regressions passed.');
