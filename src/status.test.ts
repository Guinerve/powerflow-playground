import { describe, expect, it } from "vitest";
import case14 from "./case14.m?raw";
import { parseMatpower } from "./model";
import { solvePowerFlow } from "./newton";
import { statusMessage } from "./status";

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
    expect(m.text).toMatch(/0\.94–1\.06 pu/);
  });

  it("140% load: warns that every generator is at its reactive ceiling", () => {
    const net = scaled(1.4);
    const m = statusMessage(net, solvePowerFlow(net, { enforceQLimits: true }));
    expect(m.tone).toBe("warn");
    expect(m.text).toMatch(/4 of 4 generators at their reactive limit/);
  });

  it("150% load: a load-bus voltage is out of limits", () => {
    const net = scaled(1.5);
    const m = statusMessage(net, solvePowerFlow(net, { enforceQLimits: true }));
    expect(m.tone).toBe("bad");
    expect(m.text).toMatch(/min 0\.903/);
  });
});
