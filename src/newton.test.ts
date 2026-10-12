import { describe, expect, it } from "vitest";
import case14 from "./case14.m?raw";
import { parseMatpower } from "./model";
import { solvePowerFlow } from "./newton";

const net = () => parseMatpower(case14);

describe("IEEE 14-bus base case", () => {
  it("parses the case", () => {
    const n = net();
    expect(n.buses).toHaveLength(14);
    expect(n.branches).toHaveLength(20);
    expect(n.gens).toHaveLength(5);
  });

  it("converges in a handful of iterations", () => {
    const s = solvePowerFlow(net());
    expect(s.converged).toBe(true);
    expect(s.iterations).toBeLessThanOrEqual(6);
    // quadratic convergence: final steps shrink dramatically
    const m = s.log.map((l) => l.maxMismatch);
    expect(m[m.length - 1]!).toBeLessThan(1e-8);
  });

  it("matches the published MATPOWER solution (voltages and angles)", () => {
    const n = net();
    const s = solvePowerFlow(n);
    n.buses.forEach((b, i) => {
      expect(Math.abs(s.vm[i]! - b.vm), `Vm bus ${b.id}`).toBeLessThan(1.5e-3);
      expect(Math.abs((s.va[i]! * 180) / Math.PI - b.va), `Va bus ${b.id}`).toBeLessThan(0.02);
    });
  });

  it("slack generation and total losses match the published case", () => {
    const s = solvePowerFlow(net());
    expect(s.slackMW).toBeCloseTo(232.4, 0); // published Pg at bus 1
    expect(s.totalLossMW).toBeCloseTo(13.39, 1); // published total loss ≈ 13.393 MW
  });

  it("branch flows balance: sum of terminal flows equals losses, all ends consistent", () => {
    const s = solvePowerFlow(net());
    for (const f of s.flows) expect(f.lossMW).toBeGreaterThanOrEqual(-1e-9);
    expect(s.flows[0]!.pFrom).toBeCloseTo(156.9, 0); // bus 1→2 published flow
  });
});

describe("two-bus hand calculation", () => {
  const two = (loadMW: number) =>
    parseMatpower(`
mpc.baseMVA = 100;
mpc.bus = [
 1 3 0 0 0 0 1 1.0 0 0 1 1.1 0.9;
 2 1 ${loadMW} 0 0 0 1 1.0 0 0 1 1.1 0.9;
];
mpc.gen = [ 1 0 0 100 -100 1.0 100 1 200 0; ];
mpc.branch = [ 1 2 0.0 0.1 0 0 0 0 0 0 1 -360 360; ];
`);

  it("lossless line: P = V1·V2·sinδ / x", () => {
    // 50 MW over x = 0.1 pu, V1 = 1.0: solve sinδ = P·x / (V1·V2)
    const s = solvePowerFlow(two(50));
    expect(s.converged).toBe(true);
    const delta = s.va[0]! - s.va[1]!;
    // P = V1 V2 sinδ / x exactly with the solved V2
    expect((s.vm[0]! * s.vm[1]! * Math.sin(delta)) / 0.1).toBeCloseTo(0.5, 6);
    expect(s.totalLossMW).toBeCloseTo(0, 6);
  });

  it("reports divergence instead of nonsense when the load exceeds the nose point", () => {
    const s = solvePowerFlow(two(1000)); // 10 pu through x = 0.1 pu: no solution
    expect(s.converged).toBe(false);
    expect(s.reason).toBeTruthy();
  });
});
