import { solveLinear } from "./matrix";
import { buildYbus } from "./ybus";
import type { Network } from "./model";

export interface IterationLog {
  /** Q-limit pass (0 unless a generator was switched at a limit and the case re-solved) */
  pass: number;
  iter: number;
  maxMismatch: number;
}
export interface BranchFlow {
  from: number;
  to: number;
  /** MW / MVAr leaving the "from" end and the "to" end */
  pFrom: number;
  qFrom: number;
  pTo: number;
  qTo: number;
  sFrom: number;
  sTo: number;
  lossMW: number;
}
/**
 * - slack: balances the system; its Q limits are reported but never enforced
 * - regulating: holding its voltage set-point, Q inside its limits
 * - at Qmax / at Qmin: out of reactive capability; Q is pinned and the bus voltage floats
 * - fixed Q: a generator on a PQ bus, injecting its scheduled Q
 */
export type GenState = "slack" | "regulating" | "at Qmax" | "at Qmin" | "fixed Q";
/** All generators at one bus, aggregated. */
export interface GenResult {
  bus: number;
  /** MW / MVAr */
  pg: number;
  qg: number;
  qmin: number;
  qmax: number;
  /** voltage set-point and the solved voltage, pu */
  vset: number;
  vm: number;
  state: GenState;
  withinLimits: boolean;
}
export interface Solution {
  converged: boolean;
  reason?: string;
  /** Newton iterations, summed over Q-limit passes */
  iterations: number;
  log: IterationLog[];
  /** Newton solves needed to settle which generators sit at a limit (1 when none do) */
  qLimitPasses: number;
  /** per-bus, in network order */
  vm: number[];
  /** radians */
  va: number[];
  pInj: number[];
  qInj: number[];
  flows: BranchFlow[];
  gens: GenResult[];
  totalLossMW: number;
  slackMW: number;
}

export interface Options {
  tol?: number;
  maxIter?: number;
  /**
   * Switch a PV bus to PQ at its Qmin/Qmax when its generator can't hold the set-point, and back
   * to PV once it can. Off by default, as in MATPOWER and pandapower.
   */
  enforceQLimits?: boolean;
}

/** MVAr: how far outside a limit Q must be before a generator is switched */
const Q_TOL = 1e-4;
/** pu: how far past the set-point a limited bus's voltage must be before it's released */
const V_TOL = 1e-6;
const MAX_PASSES = 20;

export function solvePowerFlow(net: Network, opts: Options = {}): Solution {
  const tol = opts.tol ?? 1e-8;
  const maxIter = opts.maxIter ?? 25;
  const n = net.buses.length;
  const { G, B } = buildYbus(net);
  const base = net.baseMVA;

  const busIdx = new Map(net.buses.map((b, i) => [b.id, i]));
  const types = net.buses.map((b) => b.type);
  const V = net.buses.map(() => 1);
  const T = net.buses.map(() => 0);
  const pSpec = net.buses.map((b) => -b.pd / base);
  const qSpec = net.buses.map((b) => -b.qd / base);

  const gens = new Map<number, GenResult>();
  for (const g of net.gens) {
    const i = busIdx.get(g.bus)!;
    pSpec[i]! += g.pg / base;
    qSpec[i]! += g.qg / base;
    const type = net.buses[i]!.type;
    if (type !== "PQ") V[i] = g.vg;
    const agg = gens.get(i);
    if (agg) {
      agg.pg += g.pg; agg.qmin += g.qmin; agg.qmax += g.qmax;
    } else {
      gens.set(i, {
        bus: g.bus, pg: g.pg, qg: 0, qmin: g.qmin, qmax: g.qmax, vset: g.vg, vm: 0,
        state: type === "slack" ? "slack" : type === "PV" ? "regulating" : "fixed Q", withinLimits: true,
      });
    }
  }

  const injections = () => {
    const P = new Array<number>(n).fill(0);
    const Q = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < n; k++) {
        const g = G[i]![k]!;
        const b = B[i]![k]!;
        if (g === 0 && b === 0) continue;
        const d = T[i]! - T[k]!;
        P[i]! += V[i]! * V[k]! * (g * Math.cos(d) + b * Math.sin(d));
        Q[i]! += V[i]! * V[k]! * (g * Math.sin(d) - b * Math.cos(d));
      }
    }
    return { P, Q };
  };

  const log: IterationLog[] = [];
  let P: number[] = [];
  let Q: number[] = [];

  /** One Newton solve with the current bus types, warm-started from V and T. */
  const newton = (pass: number): { converged: boolean; reason?: string } => {
    const pvpq = types.map((t, i) => (t !== "slack" ? i : -1)).filter((i) => i >= 0);
    const pq = types.map((t, i) => (t === "PQ" ? i : -1)).filter((i) => i >= 0);
    for (let it = 0; it <= maxIter; it++) {
      ({ P, Q } = injections());
      const f = [...pvpq.map((i) => pSpec[i]! - P[i]!), ...pq.map((i) => qSpec[i]! - Q[i]!)];
      const maxMis = Math.max(...f.map(Math.abs));
      log.push({ pass, iter: it, maxMismatch: maxMis });
      if (!Number.isFinite(maxMis)) return { converged: false, reason: "the mismatch overflowed" };
      if (maxMis < tol) return { converged: true };
      if (it === maxIter) return { converged: false, reason: `still not converged after ${maxIter} iterations` };
      if (it >= 4 && maxMis > 1e3) return { converged: false, reason: "the mismatch grew instead of getting smaller" };

      const m = pvpq.length + pq.length;
      const J = Array.from({ length: m }, () => new Array<number>(m).fill(0));
      pvpq.forEach((i, r) => {
        pvpq.forEach((k, c) => {
          const d = T[i]! - T[k]!;
          J[r]![c] = i === k
            ? -Q[i]! - B[i]![i]! * V[i]! * V[i]!
            : V[i]! * V[k]! * (G[i]![k]! * Math.sin(d) - B[i]![k]! * Math.cos(d));
        });
        pq.forEach((k, c) => {
          const d = T[i]! - T[k]!;
          J[r]![pvpq.length + c] = i === k
            ? P[i]! / V[i]! + G[i]![i]! * V[i]!
            : V[i]! * (G[i]![k]! * Math.cos(d) + B[i]![k]! * Math.sin(d));
        });
      });
      pq.forEach((i, r) => {
        pvpq.forEach((k, c) => {
          const d = T[i]! - T[k]!;
          J[pvpq.length + r]![c] = i === k
            ? P[i]! - G[i]![i]! * V[i]! * V[i]!
            : -V[i]! * V[k]! * (G[i]![k]! * Math.cos(d) + B[i]![k]! * Math.sin(d));
        });
        pq.forEach((k, c) => {
          const d = T[i]! - T[k]!;
          J[pvpq.length + r]![pvpq.length + c] = i === k
            ? Q[i]! / V[i]! - B[i]![i]! * V[i]!
            : V[i]! * (G[i]![k]! * Math.sin(d) - B[i]![k]! * Math.cos(d));
        });
      });

      const dx = solveLinear(J, f);
      if (!dx) return { converged: false, reason: "the Jacobian became singular" };
      pvpq.forEach((i, r) => { T[i]! += dx[r]!; });
      pq.forEach((i, r) => { V[i]! += dx[pvpq.length + r]!; });
      if (pq.some((i) => V[i]! <= 0.05)) {
        return { converged: false, reason: "a load bus voltage fell below 0.05 pu during the iterations" };
      }
    }
    return { converged: false, reason: "unreachable" };
  };

  const genQ = (i: number) => Q[i]! * base + net.buses[i]!.qd;
  let converged = false;
  let reason: string | undefined;
  let passes = 0;
  while (true) {
    ({ converged, reason } = newton(passes++));
    if (!converged || !opts.enforceQLimits) break;
    // Switch generators that can't hold their set-point to PQ at the limit; release limited ones
    // whose voltage has moved back past the set-point (they would now have Q to spare).
    let changed = false;
    for (const [i, g] of gens) {
      const q = genQ(i);
      const pinTo = (state: "at Qmax" | "at Qmin", lim: number) => {
        g.state = state; types[i] = "PQ"; qSpec[i] = (lim - net.buses[i]!.qd) / base; changed = true;
      };
      if (g.state === "regulating" && q > g.qmax + Q_TOL) pinTo("at Qmax", g.qmax);
      else if (g.state === "regulating" && q < g.qmin - Q_TOL) pinTo("at Qmin", g.qmin);
      else if ((g.state === "at Qmax" && V[i]! > g.vset + V_TOL) || (g.state === "at Qmin" && V[i]! < g.vset - V_TOL)) {
        g.state = "regulating"; types[i] = "PV"; V[i] = g.vset; changed = true;
      }
    }
    if (!changed) break;
    if (passes === MAX_PASSES) {
      converged = false;
      reason = `generators kept switching at their reactive limits for ${MAX_PASSES} passes`;
      break;
    }
  }
  if (!converged && opts.enforceQLimits) {
    const limited = [...gens.values()].filter((g) => g.state === "at Qmax" || g.state === "at Qmin").length;
    if (limited > 0) reason += ` (after ${limited} generator${limited > 1 ? "s" : ""} reached a reactive limit)`;
  }
  for (const [i, g] of gens) {
    g.qg = genQ(i);
    g.vm = V[i]!;
    g.withinLimits = g.qg >= g.qmin - Q_TOL && g.qg <= g.qmax + Q_TOL;
  }

  // Branch flows (MW / MVAr). Same pi model as the Ybus.
  const flows: BranchFlow[] = net.branches.map((br) => {
    const i = busIdx.get(br.from)!;
    const k = busIdx.get(br.to)!;
    const ysMag2 = br.r * br.r + br.x * br.x;
    const gs = br.r / ysMag2;
    const bs = -br.x / ysMag2;
    const t = br.tap;
    const vi = V[i]!, vk = V[k]!, d = T[i]! - T[k]!;
    const yff = { re: gs / (t * t), im: (bs + br.b / 2) / (t * t) };
    const ytt = { re: gs, im: bs + br.b / 2 };
    const yft = { re: -gs / t, im: -bs / t };
    const pF = vi * vi * yff.re + vi * vk * (yft.re * Math.cos(d) + yft.im * Math.sin(d));
    const qF = -vi * vi * yff.im + vi * vk * (yft.re * Math.sin(d) - yft.im * Math.cos(d));
    const pT = vk * vk * ytt.re + vk * vi * (yft.re * Math.cos(-d) + yft.im * Math.sin(-d));
    const qT = -vk * vk * ytt.im + vk * vi * (yft.re * Math.sin(-d) - yft.im * Math.cos(-d));
    return {
      from: br.from, to: br.to,
      pFrom: pF * base, qFrom: qF * base, pTo: pT * base, qTo: qT * base,
      sFrom: Math.hypot(pF, qF) * base, sTo: Math.hypot(pT, qT) * base,
      lossMW: (pF + pT) * base,
    };
  });

  const slackIdx = net.buses.findIndex((b) => b.type === "slack");
  return {
    converged, reason, iterations: log.length - passes, log, qLimitPasses: passes,
    vm: V, va: T, pInj: P.map((p) => p * base), qInj: Q.map((q) => q * base),
    flows, gens: [...gens.values()], totalLossMW: flows.reduce((s, f) => s + f.lossMW, 0),
    slackMW: P[slackIdx]! * base + net.buses[slackIdx]!.pd,
  };
}
