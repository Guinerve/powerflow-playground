import { describe, expect, it } from "vitest";
import case14 from "./case14.m?raw";
import { parseMatpower } from "./model";
import { maxLoadScale, runScenario } from "./scenario";

const base = parseMatpower(case14);

// These are the numbers quoted in the README and on the page. If the solver changes them, this fails.
describe("worked scenario: 140% load", () => {
  const r = runScenario(base);

  it("without limits the network looks healthy", () => {
    expect(r.unlimited.converged).toBe(true);
    expect(r.unlimited.lowest.v).toBeCloseTo(1.005, 3);
    expect(r.unlimited.lowest.bus).toBe(4);
  });

  it("but it relies on generators far past their reactive capability", () => {
    const over = Object.fromEntries(r.gens.map((g) => [g.bus, g.unlimitedQ / g.qmax]));
    expect(over[2]).toBeCloseTo(1.76, 2);
    expect(over[3]).toBeCloseTo(1.41, 2);
    expect(over[6]).toBeCloseTo(1.41, 2);
    expect(over[8]).toBeCloseTo(1.06, 2);
  });

  it("with limits, all four pin at Qmax and bus 14 sags to 0.949 pu", () => {
    expect(r.gens.map((g) => g.limitedState)).toEqual(["at Qmax", "at Qmax", "at Qmax", "at Qmax"]);
    expect(r.limited.lowest.v).toBeCloseTo(0.949, 3);
    expect(r.limited.lowest.bus).toBe(14);
    expect(r.limited.slackQ).toBeCloseTo(46.9, 1);
    expect(r.unlimited.slackQ).toBeCloseTo(-30.1, 1);
    expect(r.limited.lossMW - r.unlimited.lossMW).toBeCloseTo(1.44, 2);
  });

  it("agrees with pandapower bus for bus", () => {
    expect(r.agreement.maxDeltaV).toBeLessThan(1e-6);
    expect(r.agreement.maxDeltaDeg).toBeLessThan(1e-4);
    expect(r.agreement.maxDeltaQ).toBeLessThan(1e-3);
  });

  it("the next step, 150%, breaks the 0.94 pu floor", () => {
    expect(r.nextStep.lowest.v).toBeCloseTo(0.903, 3);
  });
});

describe("loadability", () => {
  it("Q limits cut the load scaling the solver can reach from ×4.00 to ×1.76", () => {
    expect(maxLoadScale(base, false)).toBeCloseTo(4.0, 2);
    expect(maxLoadScale(base, true)).toBeCloseTo(1.76, 2);
  });
});
