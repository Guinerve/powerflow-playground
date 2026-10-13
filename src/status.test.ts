import { describe, expect, it } from "vitest";
import case14 from "./case14.m?raw";
import { parseMatpower } from "./model";
import { solvePowerFlow } from "./newton";
import { genStateLabel, qBreach, statusMessage } from "./status";

const scaled = (k: number) => {
  const net = parseMatpower(case14);
  net.buses.forEach((b) => { b.pd *= k; b.qd *= k; });
  return net;
};

describe("status banner", () => {
  it("non-convergence is reported as a solver result, not as proof about the system", () => {
    const net = scaled(6);
    const s = solvePowerFlow(net, { enforceQLimits: true });
    expect(s.converged).toBe(false);
    const m = statusMessage(net, s);
    expect(m.tone).toBe("bad");
    expect(m.text).toMatch(/did not converge/);
    // A failed Newton solve does not prove no solution exists, and power flow says nothing about stability.
    expect(m.text).not.toMatch(/no stable operating point/i);
    expect(m.text).not.toMatch(/\bstable\b/i);
    expect(m.text).toMatch(/not proof/i);
  });

  it("base case is ok and names the limits it judged against", () => {
    const net = scaled(1);
    const m = statusMessage(net, solvePowerFlow(net, { enforceQLimits: true }));
    expect(m.tone).toBe("ok");
    expect(m.text).toMatch(/0\.94 to 1\.06 pu/);
  });

  it("140% load: warns that every generator is at its reactive ceiling", () => {
    const net = scaled(1.4);
    const m = statusMessage(net, solvePowerFlow(net, { enforceQLimits: true }));
    expect(m.tone).toBe("warn");
    expect(m.text).toMatch(/4 of 4 generators are at their reactive limit/);
  });

  it("150% load: a load-bus voltage is out of limits", () => {
    const net = scaled(1.5);
    const m = statusMessage(net, solvePowerFlow(net, { enforceQLimits: true }));
    expect(m.tone).toBe("bad");
    expect(m.text).toMatch(/min 0\.903/);
  });
});

describe("generators outside their reactive range with limits off", () => {
  // At 50% load the bus 3 and bus 6 generators must absorb more than their Qmin allows.
  const net = scaled(0.5);
  const s = solvePowerFlow(net);
  const g = (bus: number) => s.gens.find((x) => x.bus === bus)!;

  it("names the side of the range that was crossed", () => {
    expect(qBreach(g(3))).toBe("below Qmin");
    expect(qBreach(g(6))).toBe("below Qmin");
    expect(qBreach(g(2))).toBeNull();
    const high = solvePowerFlow(scaled(1.4)).gens.find((x) => x.bus === 2)!;
    expect(qBreach(high)).toBe("above Qmax");
  });

  it("labels a generator below Qmin as below Qmin, not over Qmax", () => {
    expect(genStateLabel(g(3))).toBe("below Qmin by 9.2 MVAr");
    expect(genStateLabel(g(3))).not.toMatch(/Qmax/);
    const high = solvePowerFlow(scaled(1.4)).gens.find((x) => x.bus === 2)!;
    expect(genStateLabel(high)).toBe("over Qmax ×1.76");
    expect(genStateLabel(g(2))).toBe("regulating");
  });

  it("the banner names the direction for each generator outside its range", () => {
    // Three buses: the slack, a PV bus told to hold 0.98 pu (it must absorb about 20 MVAr) and a small load.
    const three = parseMatpower(`
mpc.baseMVA = 100;
mpc.bus = [
 1 3 0 0 0 0 1 1.0 0 0 1 1.1 0.9;
 2 2 0 0 0 0 1 1.0 0 0 1 1.1 0.9;
 3 1 1 0 0 0 1 1.0 0 0 1 1.1 0.9;
];
mpc.gen = [
 1 0 0 999 -999 1.0 100 1 200 0;
 2 0 0 50 -5 0.98 100 1 200 0;
];
mpc.branch = [ 1 2 0.0 0.1 0 0 0 0 0 0 1 -360 360; 1 3 0.0 0.1 0 0 0 0 0 0 1 -360 360; ];
`);
    const sol = solvePowerFlow(three);
    expect(sol.converged).toBe(true);
    const m = statusMessage(three, sol);
    expect(m.tone).toBe("warn");
    expect(m.text).toMatch(/bus 2 below Qmin/);
    expect(m.text).not.toMatch(/more reactive power/);
  });
});
