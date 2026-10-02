# Snake matrix transformer: model, units and validation

The standalone Snake Matrix Studio generates a bounded paired snake layout and
evaluates an **experimental first-order transformer model**. It does not reproduce
the published prototype's material, dimensions, cooling, or measured performance.
The intended use is to compare layouts, inspect magnetic paths and produce a
reviewable PCB design for subsequent field simulation and prototype testing.

## Geometry and electrical interpretation

The initial routed family uses four PCB layers in `P, S, P, S` order. Each primary
or secondary follows a semicircular passage around every pillar on its outward
layer and returns on the complementary layer. Together these passages make one
signed turn per pillar. Adjacent pillar signs alternate. The geometry generator
checks the winding number of the complete projected route about every pillar;
the external connection between its terminals is assumed to remain outside the
core array. General multi-turn routing is not implied by the analytical model's
ability to accept turns in a mathematical reference case.

`inputVoltage` is the RMS voltage for sine drive, or the amplitude of a symmetric
bipolar square wave: a value of 48 means switching between +48 V and −48 V. The
square wave has zero DC and 50% duty cycle. `outputPower` selects a resistive load
using the **ideal** output voltage:

\[
n=N_p/N_s,\qquad R_L=(V_{in}/n)^2/P_{target}.
\]

The actual predicted output power will usually be lower because of winding
resistance and leakage. Setting output power to zero opens the secondary.
Output voltage and current are AC RMS values. There is no rectifier, resonant
capacitor, switch, controller, output filter, or converter efficiency model.

## Multi-pillar magnetic circuit

Every pillar has a bottom node and a top node representing magnetic potential.
There is a vertical pillar/gap branch between them, and each plate has branches
between horizontal and vertical neighboring pillar nodes. A 4 × 4 assembly has
32 nodes, 16 pillar branches and 48 plate branches. Flux can split between
several return routes; it is not forced through one common flux path.

The entered core clearance is used both radially in the geometry and axially:

\[
h_w=t_{PCB}+2c_{assembly},\quad l_p=h_w-g,\quad
h_{core}=h_w+2t_{plate}.
\]

The gap `g` is the total series air-gap length per pillar, including both
interfaces if the physical assembly has a gap at both ends. It is inside the
window height, not added to the assembly height. A circular pillar of area
\(A_p=\pi d^2/4\) has reluctance

\[
\mathcal R_p=\frac{l_p/\mu_r+g}{\mu_0 A_p}.
\]

A plate branch uses the actual center-to-center pillar distance \(l_y\), plate
thickness \(t_y\), and pitch \(p\) as an effective branch width:

\[
\mathcal R_y=\frac{l_y}{\mu_0\mu_r t_y p}.
\]

This rectangular plate-branch approximation is not calibrated for the real
three-dimensional junction, corner crowding, or edge return area. A plate value
is an average branch flux density, not a prediction of the local maximum.

Let \(A\) be the oriented node/branch incidence matrix, \(G\) the diagonal
branch permeance matrix, and \(N\) the signed winding/branch linkage matrix.
`N` is nonzero only on pillar branches, and comes from the generated winding's
verified per-pillar sign and turn count. For winding currents \(i\):

\[
F=Ni,\quad AGA^T u=AGF,\quad
\phi=G(F-A^T u),\quad \lambda=N^T\phi.
\]

One potential node is grounded to remove the arbitrary potential offset. Unit
current in each winding gives each column of the magnetizing inductance matrix.
The numerical checks verify flux conservation at every node, reciprocity, and
the energy identity \(i^T L_m i=\sum_e\mathcal R_e\phi_e^2\).

All ferrite has the entered constant relative permeability. There is no built-in
claim about a specific ferrite grade. Nonlinear permeability, hysteresis, DC
bias, external air return paths and gap fringing are omitted. The displayed
maximum flux compares pillar values and plate-branch values against the entered
limit, and identifies an exceeded limit as an error. Remaining below that
limit does not validate the omitted effects.

## Leakage and AC copper loss

Leakage is estimated with a **local foil/current-sheet approximation** in every
pillar window. The physical board thickness includes four copper foils and
three equal dielectric spacers. With copper thickness \(t_c\), each dielectric
spacer has thickness \(d=(t_{PCB}-4t_c)/3\), and layer-center heights are
\(t_c/2+i(d+t_c)\), \(i=0,1,2,3\). The calculation uses these heights from
the generated stack metadata. Each complementary layer contributes half
of its winding's local signed turn. Starting with half the total ampere-turns
on either side, the model integrates field energy through the dielectric and
copper thickness. With the local winding build \(b\) and average turn length
\(l\), the leakage matrix follows

\[
L_{\sigma}=\frac{\mu_0 l}{b}\int h(z)h(z)^T\,dz,
\]

where \(h(z)i\) is the local ampere-turn field coefficient. Contributions
from all pillar windows add. This produces a symmetric nonnegative energy
matrix. Local build is half the free inter-pillar spacing after trace clearance;
average turn length comes from the routed winding lengths. Conductor lengths
are distributed equally across the local windows. These are approximations for
the nonconcentric snake winding, and need comparison with a 3-D field solver.

DC trace resistance uses actual routed copper centerline length, trace width,
and copper thickness. The active transition barrel is calculated separately
using the generated drill size and 25 µm plating. One ounce of copper is taken
as 35 µm. Copper resistivity is 1.724 × 10⁻⁸ Ω m at 20 °C with temperature
coefficient 0.00393 /°C. Unless a copper temperature is explicitly supplied, the
entered ambient temperature is used; the thermal estimate is not iterated back
into resistance.

At each harmonic, symmetric foil skin loss and average-field proximity loss
use the same Dowell-type formulation as Planar Studio's existing transformer
engine, with copper fill correction \(w/(w+s)\). The proximity terms form a
full resistance matrix, so loss is \(i^H R i\), including cross terms. Via
skin/proximity loss, connection spreading, sharp-bend crowding, terminal-bus
impedance and fringing-induced copper loss are not included.

The displayed primary and secondary `Rac` are the **fundamental-frequency
resistance-matrix diagonal**, evaluated with the other winding's current zero.
Multiplying both displayed `Rac` values by loaded RMS currents and adding does
not reproduce the loaded copper loss: cross terms and square-wave harmonics
must also be included. The displayed copper-loss result uses those terms.

The field-balance view reports the fundamental-frequency fields at both faces
of each local foil. Its imbalance index is

\[
\epsilon_H=\frac{|H_{above}+H_{below}|}{|H_{above}|+|H_{below}|}.
\]

Zero indicates opposite, equal phasor fields in this local approximation; one
can indicate fully unbalanced faces. The view reports the maximum over pillar
windows per layer and keeps the individual regional data. It is not a map of
the actual 3-D current density or proof of the paper's field-balanced benefit.

## Circuit, harmonics and flux

The winding circuit solves

\[
\begin{bmatrix}V_{in}\\0\end{bmatrix}=
\left(R(f)+j2\pi f(L_m+L_{\sigma})+
\begin{bmatrix}0&0\\0&R_L\end{bmatrix}\right)
\begin{bmatrix}I_p\\I_s\end{bmatrix}.
\]

Currents enter dotted terminals, so the load current is \(-I_s\). A sine
uses one RMS phasor. The square-wave estimate uses the first 16 odd harmonics,
through the 31st, with RMS source amplitude
\(4V_{in}/(\pi k\sqrt2)\). Resistance is recalculated at every harmonic;
the linear inductance matrix is held fixed. Copper loss and RMS values add by
harmonic power. Peak regional flux is reconstructed at 256 equally spaced
points in one fundamental period. The finite harmonic sum slightly understates
the ideal square-wave RMS and flux peaks. It also omits capacitive resonances,
frequency-dependent permeability and dielectric loss, which can matter at the
higher retained harmonics. This is a bounded harmonic circuit approximation,
not a switching time-domain simulation.

## Core loss, thermal results and frequency studies

`coreLossDensity` is an entered **operating-point average** in kW/m³. The model
multiplies it by physical ferrite volume: both complete plates plus all ferrite
pillars. It must already reflect the selected material, excitation waveform,
flux distribution, frequency and temperature. A zero density means **unknown**,
not a lossless core. Consequently total loss, full transformer efficiency and
temperature remain unknown until a positive density is entered.
Core loss is evaluated after the winding circuit; it does not change the solved
currents, transferred voltage or magnetic flux.

The N87 fit in Planar Studio's existing transformer tool is bounded to 25–500
kHz, 50–200 mT and 100 °C. It is deliberately not reused or extrapolated for
this matrix design. In particular, an 800 kHz design needs separate material
evidence; the published prototype's exact grade is not established here.

When total loss and a positive user-supplied assembly thermal resistance are
known, temperature is \(T_{ambient}+P_{loss}R_\theta\). A zero thermal
resistance disables this estimate. This is one assembly temperature, not a
hotspot, plate heat-spreading, or cooling simulation.

Frequency sweeps reuse geometry and constant permeability, and recompute the
harmonic circuit and AC resistance. Entered loss density is valid only at its
nominal frequency; at other sweep frequencies core loss, total efficiency and
temperature become unknown. Copper loss and flux remain available. The load
resistance and copper temperature remain fixed.

Efficiency is transformer-only. Power density uses predicted AC output power
divided by the nominal rectangular core envelope, in W/cm³ (numerically equal
to kW/L). It excludes the PCB's protruding terminals, connector space, housing,
cooling, converter switches, capacitors and control. It cannot be directly
compared to the talk's complete-converter power density.

## Validation and next evidence

Run `node tests/snake-physics.mjs`. The numerical regression suite covers:

- An independent two-pillar closed-loop reluctance formula.
- Magnetic energy, node flux conservation, reciprocity and ordering invariance.
- Rotational symmetry, signed winding polarity and turns scaling.
- Air-gap and return-plate reluctance trends.
- Sinusoidal and bipolar-square Faraday volt-second limits.
- Passive resistance matrices, circuit real-power balance, copper temperature
  dependence and the DC resistance limit.
- Density/volume units, unknown-data propagation and sweep boundaries.

These checks establish numerical consistency and analytical limits, not
measured model accuracy. The next validation should compare the same routed
geometry and core assembly with an independent electromagnetic field model,
including plate junctions, gaps, current sharing, winding loss and flux extrema.
Then measure open/short impedance, loaded transfer, AC loss and thermal rise on
a physical sample at the intended conditions. Exported geometry also requires
KiCad DRC and assembly/insulation review for its intended use.

## Sources

- [Hans Wouters, *Miniaturized High-Frequency Matrix Transformers for Electric
  Vehicle Onboard Chargers*, KU Leuven thesis record](https://lirias.kuleuven.be/4432772)
  describes the snake-winding concept, thin plates, many pillars and distributed
  gaps. The full thesis was not publicly accessible during this implementation;
  this software does not claim to replicate its detailed model or prototype.
- [Author's KU Leuven publication list and thesis abstract](https://www.esat.kuleuven.be/electa/research-assistants/00150229/view?pubsonpage=50&pubtype=&sortby=popularity)
  distinguishes field-balanced windings from the snake-winding matrix concept.
- [Luong et al., 2023, general foil field formulation, equations 1–3](https://wvvw.easychair.org/publications/preprint/XXth/open)
  is also the field-formulation reference used by the existing transformer engine.
- [TDK N87 material data](https://www.tdk-electronics.tdk.com/blob/528882/download/3/pdf-n87.pdf)
  underlies the bounded fit in the existing tool; it is not evidence of the
  snake prototype's material.
- [Existing transformer model boundaries](transformer-design.md#models-and-measured-overrides)
  explain the related conventional planar-transformer estimates.
