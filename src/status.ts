import type { Network } from "./model";
import type { Solution } from "./newton";

// The IEEE 14-bus case's own voltage limits are 0.94–1.06 pu. The reference solution itself sits a hair over
// 1.06 at bus 7 (1.0615), so allow 0.005 before calling it a violation.
export const V_MIN = 0.94, V_MAX = 1.06, V_TOL = 0.005;
export const outside = (v: number) => Math.max(V_MIN - v, v - V_MAX, 0);

export interface Status {
  tone: "ok" | "warn" | "bad";
  text: string;
}

/**
 * Buses whose voltage the solver chose rather than held: load buses, and generator buses that ran out
 * of reactive power. Regulating generators sit at their set-points (1.06–1.09 pu in this case, above the
 * load-bus band), so judging them would make the base case look like a violation.
 */
export function floatingBuses(net: Network, sol: Solution): number[] {
  const limited = new Set(sol.gens.filter((g) => g.state === "at Qmax" || g.state === "at Qmin").map((g) => g.bus));
  return net.buses.flatMap((b, i) => (b.type === "PQ" || limited.has(b.id) ? [i] : []));
}

export function statusMessage(net: Network, sol: Solution): Status {
  if (!sol.converged) {
    return {
      tone: "bad",
      text: `Newton–Raphson did not converge: ${sol.reason}. No numbers are shown. This usually means the ` +
        `demand is beyond what the network can deliver (past the nose of its PV curve), but a failed solve ` +
        `is not proof that no solution exists, and a power flow on its own says nothing about dynamic stability.`,
    };
  }
  const head = `Converged in ${sol.iterations} iterations.`;
  const vs = floatingBuses(net, sol).map((i) => sol.vm[i]!);
  const vmin = Math.min(...vs), vmax = Math.max(...vs);
  const controllable = sol.gens.filter((g) => g.state !== "slack" && g.state !== "fixed Q");
  const limited = controllable.filter((g) => g.state === "at Qmax" || g.state === "at Qmin");
  const overdrawn = controllable.filter((g) => !g.withinLimits);
  const reserve = limited.length
    ? ` ${limited.length} of ${controllable.length} generators at their reactive limit (bus ${limited.map((g) => g.bus).join(", ")}).`
    : "";

  if (outside(vmin) > V_TOL || outside(vmax) > V_TOL) {
    return {
      tone: "bad",
      text: `${head} A bus voltage is outside the case's 0.94–1.06 pu limits (min ${vmin.toFixed(3)}, max ${vmax.toFixed(3)}).${reserve}`,
    };
  }
  if (overdrawn.length) {
    return {
      tone: "warn",
      text: `${head} Voltages look fine, but only because Q limits are off: ${overdrawn.length} generator` +
        `${overdrawn.length > 1 ? "s are" : " is"} producing more reactive power than ${overdrawn.length > 1 ? "they" : "it"} can ` +
        `(bus ${overdrawn.map((g) => g.bus).join(", ")}).`,
    };
  }
  if (limited.length) {
    return {
      tone: "warn",
      text: `${head} Voltages within the case's 0.94–1.06 pu limits, but ${limited.length} of ${controllable.length} ` +
        `generators at their reactive limit (bus ${limited.map((g) => g.bus).join(", ")}): little or no reactive reserve left.`,
    };
  }
  return {
    tone: "ok",
    text: `${head} All voltages within the case's 0.94–1.06 pu limits, and every generator inside its reactive range.`,
  };
}
