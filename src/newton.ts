import { solveLinear } from "./matrix";
import { buildYbus } from "./ybus";
import type { Network } from "./model";

export interface IterationLog {
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
export interface Solution {
  converged: boolean;
  reason?: string;
  iterations: number;
  log: IterationLog[];
  /** per-bus, in network order */
  vm: number[];
  /** radians */
  va: number[];
  pInj: number[];
  qInj: number[];
  flows: BranchFlow[];
  totalLossMW: number;
  slackMW: number;
}

export interface Options {
  tol?: number;
  maxIter?: number;
}

export function solvePowerFlow(net: Network, opts: Options = {}): Solution {
  const tol = opts.tol ?? 1e-8;
  const maxIter = opts.maxIter ?? 25;
  const n = net.buses.length;
  const { G, B } = buildYbus(net);
  const base = net.baseMVA;

  const busIdx = new Map(net.buses.map((b, i) => [b.id, i]));
  const V = net.buses.map(() => 1);
  const T = net.buses.map(() => 0);
  const pSpec = net.buses.map((b) => -b.pd / base);
  const qSpec = net.buses.map((b) => -b.qd / base);
  for (const g of net.gens) {
    const i = busIdx.get(g.bus)!;
    pSpec[i]! += g.pg / base;
    qSpec[i]! += g.qg / base;
    if (net.buses[i]!.type !== "PQ") V[i] = g.vg;
  }

  const pvpq = net.buses.map((b, i) => (b.type !== "slack" ? i : -1)).filter((i) => i >= 0);
  const pq = net.buses.map((b, i) => (b.type === "PQ" ? i : -1)).filter((i) => i >= 0);

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
  let converged = false;
  let reason: string | undefined;
  let { P, Q } = injections();

  for (let it = 0; it <= maxIter; it++) {
    ({ P, Q } = injections());
    const f = [...pvpq.map((i) => pSpec[i]! - P[i]!), ...pq.map((i) => qSpec[i]! - Q[i]!)];
    const maxMis = Math.max(...f.map(Math.abs));
    log.push({ iter: it, maxMismatch: maxMis });
    if (!Number.isFinite(maxMis)) { reason = "numerical blow-up"; break; }
    if (maxMis < tol) { converged = true; break; }
    if (it === maxIter) { reason = `no convergence in ${maxIter} iterations`; break; }
    if (it >= 4 && maxMis > 1e3) { reason = "mismatch diverging"; break; }

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
    if (!dx) { reason = "singular Jacobian"; break; }
    pvpq.forEach((i, r) => { T[i]! += dx[r]!; });
    pq.forEach((i, r) => { V[i]! += dx[pvpq.length + r]!; });
    if (pq.some((i) => V[i]! <= 0.05)) { reason = "voltage collapse"; break; }
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
    converged, reason, iterations: log.length - 1, log,
    vm: V, va: T, pInj: P.map((p) => p * base), qInj: Q.map((q) => q * base),
    flows, totalLossMW: flows.reduce((s, f) => s + f.lossMW, 0),
    slackMW: P[slackIdx]! * base + net.buses[slackIdx]!.pd,
  };
}
