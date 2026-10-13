# Powerflow Playground

[![CI](https://github.com/Guinerve/powerflow-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/Guinerve/powerflow-playground/actions/workflows/ci.yml)
[![Deploy](https://github.com/Guinerve/powerflow-playground/actions/workflows/pages.yml/badge.svg)](https://guinerve.github.io/powerflow-playground/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Newton–Raphson AC power-flow solver written from scratch in TypeScript, with generator reactive-power limits. It solves the IEEE 14-bus network in your browser every time you move a control.

**[Open the live demo](https://guinerve.github.io/powerflow-playground/)** or run it locally with `npm install && npm run dev`.

![Load sweep from 100% to 175% with reactive limits on, then the same 140% case with limits switched off](assets/demo.gif)

The solver doesn't use a power-systems library. It has its own Ybus (π-model lines, off-nominal transformer taps, shunts), a full polar Jacobian, Gaussian elimination with partial pivoting, and an outer loop that switches generator buses between PV and PQ at their reactive limits. A test suite checks it against an independent solver, pandapower, at every bus.

## Worked scenario: 140% load and generator reactive limits

Scale every load in the case to 140% (P and Q, generator MW unchanged, slack picks up the rest) and solve twice: once letting generators produce whatever reactive power it takes to hold their voltage set-points, and once holding them to their real Qmin–Qmax. Then solve the second case again in [pandapower](https://www.pandapower.org/) from the same `case14.m`.

![The worked scenario section of the page: comparison table and interpretation](assets/scenario.png)

| | Q limits off | Q limits on (this solver) | pandapower, limits on |
|---|---:|---:|---:|
| Lowest bus voltage | 1.005 pu (bus 4) | **0.949 pu (bus 14)** | 0.949 pu (bus 14) |
| Bus 2 generator Q (Qmax 50 MVAr) | 88.2 ▲ | 50.0, at Qmax | 50.0 |
| Bus 3 generator Q (Qmax 40) | 56.5 ▲ | 40.0, at Qmax | 40.0 |
| Bus 6 generator Q (Qmax 24) | 33.9 ▲ | 24.0, at Qmax | 24.0 |
| Bus 8 generator Q (Qmax 24) | 25.5 ▲ | 24.0, at Qmax | 24.0 |
| Slack Q, bus 1 | −30.1 | 46.9 | 46.9 |
| Losses | 28.97 MW | 30.42 MW | 30.42 MW |
| Highest load the solver can still solve | ×4.00 | **×1.76** | |

▲ is output beyond the machine's rating. The largest gap to pandapower over all 14 buses is 4.7e-9 pu in voltage, 5.2e-7° in angle and 2.5e-7 MVAr in generator output.

**What it shows.** With limits off the network looks healthy: the lowest voltage is 1.005 pu. But it gets there by asking the bus 2 generator for 88 MVAr from a 50 MVAr machine, and buses 3 and 6 for 41% more than they can give. Enforce the limits and all four voltage-controlling generators pin at Qmax. Only the slack is still regulating, so voltages sag across the network to 0.949 pu at bus 14, just inside the case's 0.94 pu floor. The slack swings from absorbing 30 MVAr to supplying 47 MVAr, and losses rise by 1.44 MW.

**Engineering reading.** At higher load this network runs short of reactive power first. At 150% bus 14 drops to 0.903 pu, a violation. With limits on, the solver finds no solution past ×1.76 load; with limits off it goes to ×4.00. A study that ignored Q limits would report a +300% load margin where this one finds about +76%. The remedy to study is reactive support near the load (switched capacitors or a STATCOM around buses 9–14), not just more generation.

**What this leaves out.** At 140% the slack produces 353 MW against a 332.4 MW Pmax, so a real study would also redispatch real power. Line ratings are illustrative (see [Limits](#limits)), so a line near 100% on the diagram is not a finding. The "highest load" figures come from bisection on flat-start convergence. Near the nose of the PV curve that is how far the solver reaches, not a certified loadability limit.

The page's **140% load** button loads this case into the diagram. Untick *Enforce generator reactive limits* to see the optimistic answer.

## How it works

| File | What it does |
|---|---|
| [`src/model.ts`](src/model.ts) | Parses the MATPOWER case format (bus, gen, branch) into typed records |
| [`src/ybus.ts`](src/ybus.ts) | Bus admittance matrix: π-model lines, off-nominal taps, bus shunts |
| [`src/newton.ts`](src/newton.ts) | Newton–Raphson in polar form, branch flows, and the reactive-limit outer loop |
| [`src/status.ts`](src/status.ts) | Turns a solution into the status banner |
| [`src/scenario.ts`](src/scenario.ts) | The worked scenario and the loadability bisection |
| [`src/main.ts`](src/main.ts) | One-line diagram (SVG), controls and charts |
| [`reference/generate.py`](reference/generate.py) | Builds the pandapower reference in `src/reference/case14.json` |

**Reactive limits.** Pass `enforceQLimits: true` (the app's default; off by default in the API, as in MATPOWER and pandapower). After each converged solve, a PV bus whose generator needs more than Qmax or less than Qmin becomes a PQ bus with Q fixed at that limit, and the case is re-solved warm-started from the last answer. A limited bus goes back to PV if its voltage moves past its set-point in the direction that means it would have reactive power to spare. The loop stops when nothing changes, or after 20 passes, which counts as non-convergence. Several generators at one bus are pooled. The slack's Q is reported against its limits but never enforced, because something has to balance the system. The published base case itself has bus 1 absorbing 16.5 MVAr against a Qmin of 0.

**When it doesn't converge.** The page says the solver failed and shows no numbers, and it says what failed: the mismatch grew, the Jacobian went singular, a voltage fell below 0.05 pu mid-iteration, or the iteration limit ran out. It doesn't claim more than that. A failed Newton solve from a flat start usually means the demand is past the nose of the PV curve, but it is not proof that no solution exists. A power flow also says nothing about dynamic stability, so the page never calls an operating point "stable" or "unstable".

## How I know it's right

`npm test` runs 29 tests in four files.

- **Published case.** The base case converges in 4 iterations, with max mismatch 9.2e-1 → 1.0e-1 → 7.1e-4 → 6.0e-8 → 7.1e-15 (quadratic). Total loss is 13.393 MW and slack output 232.39 MW, matching the published 13.393 and 232.4. Voltages are within 1.3e-3 pu of the solution column stored in the case file; the largest gap is bus 4, where the file holds the older IEEE value 1.019 and the converged answer is 1.0177 (MATPOWER prints 1.018).
- **Independent solver.** Base case, 140% without limits, 140% with limits and 150% with limits each match pandapower 3.5.6 to 1e-6 pu at every bus. The measured gap is about 5e-9 pu. Angles match to 1e-4°, generator Q to 1e-3 MVAr, and slack power and losses to 1e-3 MW. The reference comes from the same `case14.m`, read by a separate parser in `reference/generate.py`.
- **Hand calculations.** On a lossless two-bus line, P = V₁V₂ sin δ / x holds to 6 decimals. A PV bus holding 1.05 pu over x = 0.1 pu needs exactly 52.5 MVAr. Cap it at 20 MVAr and the voltage lands on the root of V² − V − 0.02 = 0. Cap a 0.9 pu set-point at −10 MVAr absorption and it lands on V² − V + 0.01 = 0, above the set-point it can't pull down to.
- **Self-consistency.** Across a sweep from 50% to 160% load, every regulating generator is inside its band, every generator at Qmax sits at or below its set-point, and every one at Qmin at or above it.
- **The numbers in this README.** `src/scenario.test.ts` asserts the scenario figures above, so if the solver changes them the build fails.

To regenerate the reference: `uv run --python 3.12 --with pandapower==3.5.6 python reference/generate.py`.

## Run it

```bash
npm install
npm run dev      # http://0.0.0.0:5192 (bound to all interfaces, so reachable over Tailscale)
npm test
npm run build    # static site in dist/
```

Pushes to `main` run the tests and deploy `dist/` to GitHub Pages.

## Limits

- **Line ratings are illustrative**: 1.5× the base-case flow, at least 50 MVA, because the public case ships without ratings.
- Generator real-power limits (Pmin/Pmax) are not enforced. Extra load goes to the slack.
- Balanced, positive-sequence steady state only. No dynamics, faults, protection, tap changers or switched shunts.
- Dense matrices and Gaussian elimination. That's fine for 14 buses but wouldn't scale to large networks.
- Educational, not a planning tool.

## Next

- Contingency mode: click a line to trip it.
- IEEE 30-bus case.
- Continuation power flow, to trace the PV curve through the nose instead of bisecting on convergence.

## Licence

MIT. See [LICENSE](LICENSE).
