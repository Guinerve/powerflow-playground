import { describe, expect, it } from "vitest";
import case14 from "./case14.m?raw";
import reference from "./reference/case14.json";
import { parseMatpower, type Network } from "./model";
import { solvePowerFlow, type Solution } from "./newton";

const scaled = (k: number): Network => {
  const net = parseMatpower(case14);
  net.buses.forEach((b) => { b.pd *= k; b.qd *= k; });
  return net;
};
const gen = (s: Solution, bus: number) => s.gens.find((g) => g.bus === bus)!;

type RefCase = (typeof reference.cases)[keyof typeof reference.cases];

/** Every bus voltage, angle and generator Q against the independent pandapower solution. */
function expectMatchesReference(s: Solution, ref: RefCase) {
  expect(s.converged).toBe(true);
  ref.bus.forEach((id, i) => {
    expect(Math.abs(s.vm[i]! - ref.vm[i]!), `Vm bus ${id}`).toBeLessThan(1e-6);
    expect(Math.abs((s.va[i]! * 180) / Math.PI - ref.vaDeg[i]!), `Va bus ${id}`).toBeLessThan(1e-4);
  });
  for (const [bus, q] of Object.entries(ref.genQ)) {
    expect(Math.abs(gen(s, Number(bus)).qg - q), `Qg bus ${bus}`).toBeLessThan(1e-3);
  }
  expect(s.slackMW).toBeCloseTo(ref.slackMW, 3);
  expect(s.totalLossMW).toBeCloseTo(ref.lossMW, 3);
}

/**
 * The switching logic is right when the result is self-consistent: a regulating generator is inside
 * its band, a generator pinned at Qmax sits at or below its set-point (it couldn't hold it), and one
 * pinned at Qmin sits at or above it.
 */
function expectConsistentLimits(s: Solution) {
  for (const g of s.gens) {
    if (g.state === "regulating") {
      expect(g.qg, `bus ${g.bus} Qg`).toBeLessThanOrEqual(g.qmax + 1e-3);
      expect(g.qg, `bus ${g.bus} Qg`).toBeGreaterThanOrEqual(g.qmin - 1e-3);
      expect(g.vm).toBeCloseTo(g.vset, 9);
    } else if (g.state === "at Qmax") {
      expect(g.qg).toBeCloseTo(g.qmax, 6);
      expect(g.vm).toBeLessThanOrEqual(g.vset + 1e-9);
    } else if (g.state === "at Qmin") {
      expect(g.qg).toBeCloseTo(g.qmin, 6);
      expect(g.vm).toBeGreaterThanOrEqual(g.vset - 1e-9);
    }
  }
}

describe("generator reactive limits on the IEEE 14-bus case", () => {
  it("parses Qmin and Qmax from the case", () => {
    const g2 = parseMatpower(case14).gens.find((g) => g.bus === 2)!;
    expect(g2.qmax).toBe(50);
    expect(g2.qmin).toBe(-40);
  });

  it("base case: no generator reaches a limit, and the result still matches the reference", () => {
    const s = solvePowerFlow(scaled(1), { enforceQLimits: true });
    expectMatchesReference(s, reference.cases.base);
    expect(s.gens.filter((g) => g.state !== "slack").map((g) => g.state)).toEqual(
      ["regulating", "regulating", "regulating", "regulating"]);
    expect(s.qLimitPasses).toBe(1);
  });

  it("reports the slack's Q against its limits without enforcing them", () => {
    // The published case itself has bus 1 absorbing 16.5 MVAr against a Qmin of 0.
    const slack = gen(solvePowerFlow(scaled(1), { enforceQLimits: true }), 1);
    expect(slack.state).toBe("slack");
    expect(slack.qg).toBeCloseTo(-16.55, 2);
    expect(slack.withinLimits).toBe(false);
  });

  it("140% load without limits: matches the reference and shows the impossible Q it relies on", () => {
    const s = solvePowerFlow(scaled(1.4));
    expectMatchesReference(s, reference.cases.load140_unlimited);
    for (const bus of [2, 3, 6, 8]) {
      expect(gen(s, bus).qg, `bus ${bus}`).toBeGreaterThan(gen(s, bus).qmax);
      expect(gen(s, bus).withinLimits).toBe(false);
    }
  });

  it("140% load with limits: all four generators pin at Qmax and match the reference", () => {
    const s = solvePowerFlow(scaled(1.4), { enforceQLimits: true });
    expectMatchesReference(s, reference.cases.load140);
    for (const bus of [2, 3, 6, 8]) {
      expect(gen(s, bus).state, `bus ${bus}`).toBe("at Qmax");
      expect(gen(s, bus).vm, `bus ${bus}`).toBeLessThan(gen(s, bus).vset);
    }
    expectConsistentLimits(s);
  });

  it("150% load with limits: matches the reference", () => {
    const s = solvePowerFlow(scaled(1.5), { enforceQLimits: true });
    expectMatchesReference(s, reference.cases.load150);
    expectConsistentLimits(s);
  });

  it("limits are self-consistent across a sweep of load levels", () => {
    for (let j = 10; j <= 32; j++) {
      const k = j / 20; // 0.50 to 1.60
      const s = solvePowerFlow(scaled(k), { enforceQLimits: true });
      expect(s.converged, `load ×${k.toFixed(2)}`).toBe(true);
      expectConsistentLimits(s);
    }
  });

  it("enforcing limits collapses the loadability margin", () => {
    // Without limits the generators hold their set-points with however much Q it takes.
    expect(solvePowerFlow(scaled(2.5)).converged).toBe(true);
    expect(solvePowerFlow(scaled(2.5), { enforceQLimits: true }).converged).toBe(false);
  });
});

describe("two-bus reactive limits, checked by hand", () => {
  // Slack at 1.0 pu feeding a PV bus over x = 0.1 pu. The PV bus wants vset; holding it takes
  // Q ≈ V(V − V1)/x, so a set-point above 1.0 needs injection and one below needs absorption.
  const two = (vset: number, qmin: number, qmax: number) =>
    parseMatpower(`
mpc.baseMVA = 100;
mpc.bus = [
 1 3 0 0 0 0 1 1.0 0 0 1 1.1 0.9;
 2 2 0 0 0 0 1 1.0 0 0 1 1.1 0.9;
];
mpc.gen = [
 1 0 0 999 -999 1.0 100 1 200 0;
 2 0 0 ${qmax} ${qmin} ${vset} 100 1 200 0;
];
mpc.branch = [ 1 2 0.0 0.1 0 0 0 0 0 0 1 -360 360; ];
`);

  it("unlimited: holding 1.05 pu takes 1.05 × 0.05 / 0.1 = 0.525 pu = 52.5 MVAr", () => {
    const s = solvePowerFlow(two(1.05, -100, 100), { enforceQLimits: true });
    expect(gen(s, 2).state).toBe("regulating");
    expect(gen(s, 2).qg).toBeCloseTo(52.5, 6);
  });

  it("Qmax = 20 MVAr: pinned at 20, voltage falls to the root of V² − V − 0.2·0.1 = 0", () => {
    const s = solvePowerFlow(two(1.05, -100, 20), { enforceQLimits: true });
    expect(gen(s, 2).state).toBe("at Qmax");
    expect(gen(s, 2).qg).toBeCloseTo(20, 6);
    expect(s.vm[1]).toBeCloseTo((1 + Math.sqrt(1 + 4 * 0.02)) / 2, 9);
  });

  it("Qmin = −10 MVAr: pinned at −10, voltage stays above a 0.9 pu set-point it can't pull down to", () => {
    const s = solvePowerFlow(two(0.9, -10, 100), { enforceQLimits: true });
    expect(gen(s, 2).state).toBe("at Qmin");
    expect(gen(s, 2).qg).toBeCloseTo(-10, 6);
    expect(s.vm[1]).toBeCloseTo((1 + Math.sqrt(1 - 4 * 0.01)) / 2, 9);
    expect(s.vm[1]).toBeGreaterThan(0.9);
  });

  it("limits are ignored unless asked for", () => {
    const s = solvePowerFlow(two(1.05, -100, 20));
    expect(gen(s, 2).state).toBe("regulating");
    expect(gen(s, 2).qg).toBeCloseTo(52.5, 6);
    expect(gen(s, 2).withinLimits).toBe(false);
  });
});
