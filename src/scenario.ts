import type { Network } from "./model";
import { solvePowerFlow, type GenState, type Solution } from "./newton";
import reference from "./reference/case14.json";

/** Multiply every bus's P and Q demand by k. Generator MW is unchanged, so the slack covers the difference. */
export function scaleLoads(base: Network, k: number): Network {
  const net: Network = structuredClone(base);
  net.buses.forEach((b) => { b.pd *= k; b.qd *= k; });
  return net;
}

/**
 * Scale every load by k, then add generation (mw > 0) or load (mw < 0) at one bus. Added load draws
 * Q at about 0.95 power factor. Added generation is modelled as negative load, so demandMW is
 * reported separately: it counts the loads and any added load, never the added generation.
 */
export function applyInjection(base: Network, k: number, busId: number, mw: number): { net: Network; demandMW: number } {
  const net = scaleLoads(base, k);
  const demandMW = net.buses.reduce((a, b) => a + b.pd, 0) + Math.max(-mw, 0);
  const bus = net.buses.find((b) => b.id === busId);
  if (!bus) throw new Error(`no bus ${busId}`);
  bus.pd -= mw;
  if (mw < 0) bus.qd += -mw * 0.33;
  return { net, demandMW };
}

/**
 * Largest load scaling at which the solver still converges from a flat start, found by bisection.
 * Near the nose of the PV curve this is the solver's reach, not a certified loadability limit.
 */
export function maxLoadScale(base: Network, enforceQLimits: boolean): number {
  let lo = 1, hi = 8;
  for (let i = 0; i < 24; i++) {
    const k = (lo + hi) / 2;
    if (solvePowerFlow(scaleLoads(base, k), { enforceQLimits }).converged) lo = k; else hi = k;
  }
  return lo;
}

export const SCENARIO_SCALE = 1.4;

interface Summary {
  converged: boolean;
  lowest: { bus: number; v: number };
  slackMW: number;
  slackQ: number;
  lossMW: number;
}
function summarise(net: Network, s: Solution): Summary {
  const i = s.vm.indexOf(Math.min(...s.vm));
  const slack = s.gens.find((g) => g.state === "slack")!;
  return {
    converged: s.converged, lowest: { bus: net.buses[i]!.id, v: s.vm[i]! },
    slackMW: s.slackMW, slackQ: slack.qg, lossMW: s.totalLossMW,
  };
}

export interface ScenarioResult {
  unlimited: Summary;
  limited: Summary;
  nextStep: Summary;
  /** pandapower's answer for the same case with Q limits on */
  reference: Summary;
  gens: { bus: number; qmax: number; unlimitedQ: number; limitedQ: number; limitedState: GenState; referenceQ: number }[];
  /** worst gap to pandapower over all buses / generators */
  agreement: { maxDeltaV: number; maxDeltaDeg: number; maxDeltaQ: number };
}

/** 140% load with and without generator Q limits, against the independent pandapower solution. */
export function runScenario(base: Network): ScenarioResult {
  const net = scaleLoads(base, SCENARIO_SCALE);
  const off = solvePowerFlow(net);
  const on = solvePowerFlow(net, { enforceQLimits: true });
  const next = scaleLoads(base, 1.5);
  const ref = reference.cases.load140;
  const refLow = ref.vm.indexOf(Math.min(...ref.vm));
  const refQ = ref.genQ as Record<string, number>;

  return {
    unlimited: summarise(net, off),
    limited: summarise(net, on),
    nextStep: summarise(next, solvePowerFlow(next, { enforceQLimits: true })),
    reference: {
      converged: true, lowest: { bus: ref.bus[refLow]!, v: ref.vm[refLow]! },
      slackMW: ref.slackMW, slackQ: refQ[String(ref.bus[0])]!, lossMW: ref.lossMW,
    },
    gens: on.gens.filter((g) => g.state !== "slack").map((g) => ({
      bus: g.bus, qmax: g.qmax, limitedQ: g.qg, limitedState: g.state,
      unlimitedQ: off.gens.find((u) => u.bus === g.bus)!.qg, referenceQ: refQ[String(g.bus)]!,
    })),
    agreement: {
      maxDeltaV: Math.max(...ref.vm.map((v, i) => Math.abs(on.vm[i]! - v))),
      maxDeltaDeg: Math.max(...ref.vaDeg.map((a, i) => Math.abs((on.va[i]! * 180) / Math.PI - a))),
      maxDeltaQ: Math.max(...on.gens.map((g) => Math.abs(g.qg - refQ[String(g.bus)]!))),
    },
  };
}
