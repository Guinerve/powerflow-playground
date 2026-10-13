import type { Network } from "./model";
import type { GenResult, Solution } from "./newton";

// The IEEE 14-bus case's own voltage limits are 0.94 to 1.06 pu. The reference solution itself sits a hair
// over 1.06 at bus 7 (1.0615), so allow 0.005 before calling it a violation.
export const V_MIN = 0.94, V_MAX = 1.06, V_TOL = 0.005;
export const outside = (v: number) => Math.max(V_MIN - v, v - V_MAX, 0);

export interface Status {
  tone: "ok" | "warn" | "bad";
  text: string;
}

/**
 * Buses whose voltage the solver chose rather than held: load buses, and generator buses that ran out
 * of reactive power. Regulating generators sit at their set-points (up to 1.09 pu in this case, above the
 * load-bus band), so judging them would make the base case look like a violation.
 */
export function floatingBuses(net: Network, sol: Solution): number[] {
  const limited = new Set(sol.gens.filter((g) => g.state === "at Qmax" || g.state === "at Qmin").map((g) => g.bus));
  return net.buses.flatMap((b, i) => (b.type === "PQ" || limited.has(b.id) ? [i] : []));
}

/** Which side of its reactive range a generator is on, or null when it is inside it. */
export function qBreach(g: GenResult): "above Qmax" | "below Qmin" | null {
  if (g.withinLimits) return null;
  return g.qg > g.qmax ? "above Qmax" : "below Qmin";
}

/** Short state text for a generator, as shown beside its reactive power bar. */
export function genStateLabel(g: GenResult): string {
  const breach = qBreach(g);
  if (g.state === "slack") return breach ? `slack, ${breach}` : "slack";
  if (breach === "above Qmax") return `over Qmax ×${(g.qg / g.qmax).toFixed(2)}`;
  if (breach === "below Qmin") return `below Qmin by ${(g.qmin - g.qg).toFixed(1)} MVAr`;
  return g.state;
}

export function statusMessage(net: Network, sol: Solution): Status {
  if (!sol.converged) {
    return {
      tone: "bad",
      text: `The solver did not converge: ${sol.reason}. No numbers are shown. Often this means the demand is ` +
        `more than the network can deliver (past the nose of its PV curve). But a failed solve is not proof ` +
        `that no solution exists. A power flow also tells you nothing about dynamic stability.`,
    };
  }
  const head = `Converged in ${sol.iterations} iterations.`;
  const vs = floatingBuses(net, sol).map((i) => sol.vm[i]!);
  const vmin = vs.length ? Math.min(...vs) : V_MIN, vmax = vs.length ? Math.max(...vs) : V_MAX;
  const controllable = sol.gens.filter((g) => g.state !== "slack" && g.state !== "fixed Q");
  const limited = controllable.filter((g) => g.state === "at Qmax" || g.state === "at Qmin");
  const overdrawn = controllable.filter((g) => !g.withinLimits);
  const reserve = limited.length
    ? ` ${limited.length} of ${controllable.length} generators are at their reactive limit (bus ${limited.map((g) => g.bus).join(", ")}).`
    : "";

  if (outside(vmin) > V_TOL || outside(vmax) > V_TOL) {
    return {
      tone: "bad",
      text: `${head} A bus voltage is outside the case limits of 0.94 to 1.06 pu (min ${vmin.toFixed(3)}, max ${vmax.toFixed(3)}).${reserve}`,
    };
  }
  if (overdrawn.length) {
    return {
      tone: "warn",
      text: `${head} Voltages look fine, but only because Q limits are off. ${overdrawn.length} generator` +
        `${overdrawn.length > 1 ? "s are" : " is"} outside ${overdrawn.length > 1 ? "their" : "its"} reactive range ` +
        `(${overdrawn.map((g) => `bus ${g.bus} ${qBreach(g)}`).join(", ")}).`,
    };
  }
  if (limited.length) {
    return {
      tone: "warn",
      text: `${head} Voltages are inside the case limits of 0.94 to 1.06 pu. But ${limited.length} of ${controllable.length} ` +
        `generators are at their reactive limit (bus ${limited.map((g) => g.bus).join(", ")}), so little or no reactive reserve is left.`,
    };
  }
  return {
    tone: "ok",
    text: `${head} All voltages are inside the case limits of 0.94 to 1.06 pu. Every generator that controls voltage is inside its reactive range.`,
  };
}
