import case14 from "./case14.m?raw";
import { parseMatpower, type Network } from "./model";
import { solvePowerFlow, type Solution } from "./newton";

const base = parseMatpower(case14);
const POS: Record<number, [number, number]> = {
  1: [70, 130], 2: [290, 60], 3: [560, 60], 4: [420, 190], 5: [230, 220], 6: [200, 350],
  7: [580, 260], 8: [740, 260], 9: [580, 350], 10: [540, 450], 11: [370, 440],
  12: [60, 430], 13: [230, 520], 14: [730, 440],
};

const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const busSel = $<HTMLSelectElement>("#bus");
base.buses.forEach((b) => busSel.add(new Option(`Bus ${b.id}`, String(b.id))));
busSel.value = "9";

/** Illustrative ratings: 1.5× the base-case flow, at least 50 MVA, rounded up to 10. */
const baseSol = solvePowerFlow(base);
const ratings = baseSol.flows.map((f) => Math.max(50, Math.ceil((1.5 * Math.max(f.sFrom, f.sTo)) / 10) * 10));

function scenario(): Network {
  const busId = Number(busSel.value);
  const mw = Number($<HTMLInputElement>("#mw").value);
  const k = Number($<HTMLInputElement>("#scale").value) / 100;
  const net: Network = structuredClone(base);
  net.buses.forEach((b) => { b.pd *= k; b.qd *= k; });
  const bus = net.buses.find((b) => b.id === busId)!;
  // positive MW = added generation (negative load); negative = added load at 0.95 pf-ish (Q follows P)
  bus.pd -= mw;
  if (mw < 0) bus.qd += -mw * 0.33;
  return net;
}

// The IEEE 14-bus case's own voltage limits are 0.94–1.06 pu. The reference solution itself sits a hair over
// 1.06 at bus 7 (1.0615), so allow 0.005 before calling it a violation.
const V_MIN = 0.94, V_MAX = 1.06, TOL = 0.005;
const outside = (v: number) => Math.max(V_MIN - v, v - V_MAX, 0);
const vColor = (v: number, regulated: boolean) =>
  regulated || outside(v) <= TOL ? "var(--ok)" : outside(v) < 0.02 ? "var(--warn)" : "var(--bad)";
const lColor = (pct: number) => (pct > 100 ? "var(--bad)" : pct > 70 ? "var(--warn)" : "var(--ok)");

function draw(net: Network, sol: Solution): void {
  const svg = $<SVGSVGElement>("#diagram");
  const sel = Number(busSel.value);
  let s = "";
  net.branches.forEach((br, i) => {
    const [x1, y1] = POS[br.from]!;
    const [x2, y2] = POS[br.to]!;
    const f = sol.flows[i]!;
    const pct = sol.converged ? (Math.max(f.sFrom, f.sTo) / ratings[i]!) * 100 : 0;
    const w = 2 + Math.min(pct, 130) / 18;
    const col = sol.converged ? lColor(pct) : "var(--muted)";
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" opacity=".85"><title>${br.from}–${br.to}: ${f.pFrom.toFixed(1)} MW, ${pct.toFixed(0)}% of ${ratings[i]} MVA</title></line>`;
  });
  net.buses.forEach((b, i) => {
    const [x, y] = POS[b.id]!;
    const v = sol.vm[i]!;
    const col = sol.converged ? vColor(v, b.type !== "PQ") : "var(--muted)";
    const hasGen = net.gens.some((g) => g.bus === b.id);
    s += `<g class="bus${b.id === sel ? " sel" : ""}" data-bus="${b.id}"><circle cx="${x}" cy="${y}" r="17" fill="${col}"/><text x="${x}" y="${y}">${b.id}</text></g>`;
    s += `<text class="vlabel" x="${x}" y="${y + 31}">${sol.converged ? v.toFixed(3) + " pu" : "—"}</text>`;
    if (hasGen) s += `<text class="gen" x="${x}" y="${y - 24}">⚡ gen</text>`;
  });
  svg.innerHTML = s;
  svg.querySelectorAll<SVGGElement>(".bus").forEach((g) =>
    g.addEventListener("click", () => { busSel.value = g.dataset.bus!; update(); }));
}

function report(net: Network, sol: Solution): void {
  const banner = $("#banner");
  if (sol.converged) {
    // Generator buses are held at their set-points (1.06–1.09 pu here), so only load (PQ) buses are judged.
    const pq = sol.vm.filter((_, i) => net.buses[i]!.type === "PQ");
    const vmin = Math.min(...pq), vmax = Math.max(...pq);
    const bad = outside(vmin) > TOL || outside(vmax) > TOL;
    banner.className = "banner" + (bad ? " bad" : "");
    banner.textContent = `Converged in ${sol.iterations} iterations. ` + (bad
      ? `A load bus is outside the case's 0.94–1.06 pu limits (min ${vmin.toFixed(3)}, max ${vmax.toFixed(3)}).`
      : `All load-bus voltages within the case's 0.94–1.06 pu limits (generator buses sit at their set-points).`);
  } else {
    banner.className = "banner bad";
    banner.textContent = `Solver diverged: ${sol.reason}. No stable operating point exists for this scenario, so no numbers are shown.`;
  }
  const dd = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
  const load = net.buses.reduce((a, b) => a + b.pd, 0);
  $("#stats").innerHTML = sol.converged
    ? dd("Total demand", `${load.toFixed(1)} MW`) + dd("Slack bus output", `${sol.slackMW.toFixed(1)} MW`) +
      dd("Network losses", `${sol.totalLossMW.toFixed(2)} MW`) +
      dd("Lowest voltage", `${Math.min(...sol.vm).toFixed(3)} pu`) +
      dd("Max line loading", `${Math.max(...sol.flows.map((f, i) => (Math.max(f.sFrom, f.sTo) / ratings[i]!) * 100)).toFixed(0)}%`)
    : dd("Total demand", `${load.toFixed(1)} MW`);
  $("#log").innerHTML = "<tr><th>Iter</th><th>Max mismatch (pu)</th></tr>" +
    sol.log.map((l) => `<tr><td>${l.iter}</td><td>${l.maxMismatch.toExponential(2)}</td></tr>`).join("");
  $("#buses").innerHTML = "<tr><th>Bus</th><th>V (pu)</th><th>Angle (°)</th><th>P inj (MW)</th></tr>" +
    (sol.converged ? net.buses.map((b, i) =>
      `<tr><td>${b.id}</td><td>${sol.vm[i]!.toFixed(4)}</td><td>${((sol.va[i]! * 180) / Math.PI).toFixed(2)}</td><td>${sol.pInj[i]!.toFixed(1)}</td></tr>`).join("") : "");
}

function update(): void {
  const mw = Number($<HTMLInputElement>("#mw").value);
  $("#busOut").textContent = `Bus ${busSel.value}`;
  $("#mwOut").textContent = mw === 0 ? "0 MW" : mw > 0 ? `+${mw} MW generation` : `${-mw} MW extra load`;
  $("#scaleOut").textContent = `${$<HTMLInputElement>("#scale").value}%`;
  const net = scenario();
  const sol = solvePowerFlow(net);
  draw(net, sol);
  report(net, sol);
}

busSel.addEventListener("change", update);
$("#mw").addEventListener("input", update);
$("#scale").addEventListener("input", update);
$("#solar").addEventListener("click", () => { busSel.value = "9"; $<HTMLInputElement>("#mw").value = "200"; $<HTMLInputElement>("#scale").value = "100"; update(); });
$("#reset").addEventListener("click", () => { $<HTMLInputElement>("#mw").value = "0"; $<HTMLInputElement>("#scale").value = "100"; update(); });
update();
