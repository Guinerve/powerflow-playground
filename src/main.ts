import case14 from "./case14.m?raw";
import { parseMatpower, type Network } from "./model";
import { solvePowerFlow, type GenResult, type Solution } from "./newton";
import { applyInjection, maxLoadScale, runScenario, SCENARIO_SCALE } from "./scenario";
import { floatingBuses, genStateLabel, outside, qBreach, statusMessage, V_TOL } from "./status";

const base = parseMatpower(case14);

/** Diagram coordinates (800 × 570 viewBox) and which side each generator is drawn on. */
const POS: Record<number, [number, number]> = {
  1: [110, 140], 2: [300, 70], 3: [570, 70], 4: [430, 200], 5: [240, 230], 6: [210, 360],
  7: [590, 270], 8: [740, 270], 9: [590, 360], 10: [550, 460], 11: [380, 450],
  12: [70, 440], 13: [240, 530], 14: [740, 450],
};
const GEN_SIDE: Record<number, "up" | "left"> = { 1: "left", 2: "up", 3: "up", 6: "left", 8: "up" };
/** Label offsets from the bus centre, placed by hand to keep clear of the lines: [dx, dy, text-anchor]. */
type Place = [number, number, "start" | "middle" | "end"];
const NUM: Record<number, Place> = {
  1: [0, -15, "middle"], 3: [37, 0, "start"], 4: [0, -15, "middle"], 6: [-14, -15, "middle"],
  8: [37, 0, "start"], 10: [-30, -15, "middle"], 14: [0, -16, "middle"],
};
const VOLT: Record<number, Place> = { 2: [7, 23, "middle"], 5: [24, 23, "middle"], 6: [-28, 22, "middle"], 7: [-30, 22, "middle"], 9: [34, -10, "start"] };
/** Load arrows hang off the right end of the bar unless that side is crowded. */
const LOAD_DX: Record<number, number> = { 5: -22, 9: -22 };

const $ = <T extends Element>(s: string) => document.querySelector<T>(s)!;
const busSel = $<HTMLSelectElement>("#bus");
const mwIn = $<HTMLInputElement>("#mw");
const scaleIn = $<HTMLInputElement>("#scale");
const qlimIn = $<HTMLInputElement>("#qlim");
base.buses.forEach((b) => busSel.add(new Option(`Bus ${b.id}`, String(b.id))));
busSel.value = "9";

/** Illustrative ratings: 1.5× the base-case flow, at least 50 MVA, rounded up to 10. */
const baseSol = solvePowerFlow(base);
const ratings = baseSol.flows.map((f) => Math.max(50, Math.ceil((1.5 * Math.max(f.sFrom, f.sTo)) / 10) * 10));
const loadingPct = (sol: Solution, i: number) => (Math.max(sol.flows[i]!.sFrom, sol.flows[i]!.sTo) / ratings[i]!) * 100;

/** The case as the controls set it. Positive MW is added generation, negative is added load. */
const scenario = () => applyInjection(base, Number(scaleIn.value) / 100, Number(busSel.value), Number(mwIn.value));

const fmt = (x: number, d = 1) => x.toFixed(d).replace("-", "−");
const vTone = (v: number) => (outside(v) <= V_TOL ? "ok" : outside(v) < 0.02 ? "warn" : "bad");
const lineColor = (pct: number) => (pct > 100 ? "var(--bad)" : pct > 70 ? "var(--warn)" : "var(--ok)");
const isLimited = (g: GenResult) => g.state === "at Qmax" || g.state === "at Qmin";

function drawDiagram(net: Network, sol: Solution): void {
  const svg = $<SVGSVGElement>("#diagram");
  const sel = Number(busSel.value);
  const floating = new Set(floatingBuses(net, sol).map((i) => net.buses[i]!.id));
  let s = "";

  // Drafting-film dot grid
  for (let x = 20; x < 800; x += 40) for (let y = 15; y < 570; y += 40) s += `<circle class="grid" cx="${x}" cy="${y}" r="1.2"/>`;

  net.branches.forEach((br, i) => {
    const [x1, y1] = POS[br.from]!;
    const [x2, y2] = POS[br.to]!;
    const f = sol.flows[i]!;
    const pct = sol.converged ? loadingPct(sol, i) : 0;
    const w = sol.converged ? 2.5 + Math.min(pct, 130) / 20 : 2;
    const col = sol.converged ? lineColor(pct) : "var(--idle)";
    const tip = sol.converged
      ? `Line ${br.from}–${br.to}: ${fmt(Math.abs(f.pFrom))} MW, ${fmt(pct, 0)}% of an illustrative ${ratings[i]} MVA rating`
      : `Line ${br.from}–${br.to}`;
    s += `<line class="branch" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w.toFixed(1)}"><title>${tip}</title></line>`;
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const at = (t: number) => [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t] as const;
    if (br.tap !== 1) {
      const [mx, my] = at(0.5);
      const dx = Math.cos(ang) * 5.5, dy = Math.sin(ang) * 5.5;
      s += `<circle class="xfmr" cx="${mx - dx}" cy="${my - dy}" r="8"/><circle class="xfmr" cx="${mx + dx}" cy="${my + dy}" r="8"/>`;
    }
    if (sol.converged && Math.abs(f.pFrom) > 0.5) {
      const [ax, ay] = at(br.tap !== 1 ? 0.75 : 0.5);
      const deg = (ang * 180) / Math.PI + (f.pFrom >= 0 ? 0 : 180);
      s += `<path class="flow" d="M5 0 L-4 -4.5 L-4 4.5 Z" transform="translate(${ax.toFixed(1)} ${ay.toFixed(1)}) rotate(${deg.toFixed(1)})"/>`;
    }
  });

  net.buses.forEach((b, i) => {
    const [x, y] = POS[b.id]!;
    const g = sol.gens.find((gg) => gg.bus === b.id);
    const side = GEN_SIDE[b.id];
    const v = sol.vm[i]!;
    const tone = !sol.converged ? "idle" : floating.has(b.id) ? vTone(v) : "held";
    const fill = { idle: "var(--idle)", held: "var(--ink)", ok: "var(--ok)", warn: "var(--warn)", bad: "var(--bad)" }[tone];

    if (g) {
      const [gx, gy] = side === "left" ? [x - 70, y] : [x, y - 38];
      s += side === "left"
        ? `<line class="stem" x1="${x - 30}" y1="${y}" x2="${gx + 12}" y2="${y}"/>`
        : `<line class="stem" x1="${x}" y1="${y - 4}" x2="${x}" y2="${gy + 12}"/>`;
      const lim = sol.converged && isLimited(g);
      // Only possible with limits off. The slack is exempt: its limits are reported, never enforced.
      const breach = sol.converged && g.state !== "slack" ? qBreach(g) : null;
      const overCap = breach !== null;
      s += `<g><title>Generator at bus ${b.id}: ${g.state}${sol.converged ? `, ${fmt(g.qg)} MVAr (limits ${g.qmin} to ${g.qmax})` : ""}</title>` +
        `<circle class="gen-sym${lim ? " limited" : overCap ? " over" : ""}" cx="${gx}" cy="${gy}" r="12"/>` +
        `<path class="gen-wave" d="M${gx - 6.5} ${gy}c1.6-4 3.2-4 4.9 0s3.2 4 4.9 0"/></g>`;
      if (sol.converged) {
        const label = `${fmt(g.qg, 0)} MVAr${lim ? `, ${g.state}` : breach === "above Qmax" ? ", over Qmax" : breach === "below Qmin" ? ", under Qmin" : ""}`;
        // Above the symbol for side-mounted generators; beside it otherwise, on the left near the right edge.
        const [lx, ly, anchor] = side === "left" ? [gx, gy - 19, "middle"] : gx > 700 ? [gx - 18, gy + 4, "end"] : [gx + 18, gy + 4, "start"];
        s += `<text class="gen-q" x="${lx}" y="${ly}" style="text-anchor:${anchor}">${label}</text>`;
      }
    }
    if (b.pd > 0.5) {
      s += `<path class="load" d="M${x + (LOAD_DX[b.id] ?? 22)} ${y + 4} v9 h-4 l5 8 l5 -8 h-4 v-9 Z"><title>Load ${fmt(b.pd)} MW</title></path>`;
    }

    const [ndx, ndy, nanc] = NUM[b.id] ?? [-37, 0, "end"];
    const [vdx, vdy, vanc] = VOLT[b.id] ?? [0, 23, "middle"];
    const label = `<text class="num" x="${x + ndx}" y="${y + ndy}" style="text-anchor:${nanc}">${b.id}</text>`;
    const flag = tone === "warn" || tone === "bad";
    const arrow = flag ? (v > 1 ? "▲ " : "▼ ") : "";
    s += `<g class="bus${b.id === sel ? " sel" : ""}" data-bus="${b.id}" tabindex="0" role="button" aria-label="Bus ${b.id}${sol.converged ? `, ${v.toFixed(3)} per unit` : ""}">` +
      `<rect class="hit" x="${x - 48}" y="${y - 20}" width="96" height="40"/>` +
      `<rect class="bar" x="${x - 30}" y="${y - 4.5}" width="60" height="9" rx="1.5" fill="${fill}"/>${label}</g>`;
    s += `<text class="v${flag ? " flag" : ""}" x="${x + vdx}" y="${y + vdy}" style="text-anchor:${vanc}">${sol.converged ? `${arrow}${v.toFixed(3)}` : "—"}</text>`;

    if (b.id === sel && Number(mwIn.value) !== 0) {
      const mw = Number(mwIn.value);
      s += `<text class="added" x="${x}" y="${y + 41}">${mw > 0 ? `+${mw} MW generation` : `+${-mw} MW load`}</text>`;
    }
  });

  if (!sol.converged) s += `<text class="void" x="400" y="300">No solution found, so voltages and flows are hidden</text>`;
  svg.innerHTML = s;
  svg.querySelectorAll<SVGGElement>(".bus").forEach((el) => {
    const pick = () => { busSel.value = el.dataset.bus!; update(); svg.querySelector<SVGGElement>(`.bus[data-bus="${el.dataset.bus}"]`)?.focus(); };
    el.addEventListener("click", pick);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });
}

/** Q axis shared by every row, MVAr. Values beyond it are clamped and flagged. */
const Q_MIN_AXIS = -50, Q_MAX_AXIS = 100;
const qx = (q: number) => ((Math.min(Math.max(q, Q_MIN_AXIS), Q_MAX_AXIS) - Q_MIN_AXIS) / (Q_MAX_AXIS - Q_MIN_AXIS)) * 300;

function drawGens(sol: Solution): void {
  const host = $("#gens");
  if (!sol.converged) { host.innerHTML = `<p class="note">No solution, so no generator outputs.</p>`; return; }
  const rows = sol.gens.map((g) => {
    const tone = g.state === "regulating" ? "ok" : isLimited(g) ? "warn" : g.withinLimits ? "ok" : "bad";
    const state = genStateLabel(g);
    const off = g.qg > Q_MAX_AXIS ? `<text class="over" x="300" y="6" text-anchor="end" fill="var(--bad)">▶</text>`
      : g.qg < Q_MIN_AXIS ? `<text class="over" x="0" y="6" text-anchor="start" fill="var(--bad)">◀</text>` : "";
    return `<div class="gen-row" title="Bus ${g.bus}: ${fmt(g.qg)} MVAr, capability ${g.qmin} to ${g.qmax} MVAr">
      <span class="who">G${g.bus}<small>bus ${g.bus}</small></span>
      <svg viewBox="0 0 300 26" preserveAspectRatio="none" aria-hidden="true">
        <rect class="track" x="${qx(g.qmin)}" y="8" width="${qx(g.qmax) - qx(g.qmin)}" height="10" rx="2"/>
        <line class="zero" x1="${qx(0)}" x2="${qx(0)}" y1="4" y2="22"/>
        <line class="tick" x1="${qx(g.qg)}" x2="${qx(g.qg)}" y1="3" y2="23" stroke="var(--${tone})"/>${off}
      </svg>
      <span class="val">${fmt(g.qg)} MVAr<small${tone !== "ok" ? ' class="flag"' : ""}>${state}</small></span>
    </div>`;
  });
  host.innerHTML = rows.join("") +
    `<div class="gens-axis" aria-hidden="true"><span></span><span><span>−50</span><span>0</span><span>50</span><span>100 MVAr</span></span><span></span></div>`;
}

function drawConvergence(sol: Solution): void {
  const W = 320, H = 150, L = 34, R = 10, T = 10, B = 24;
  const lg = sol.log.map((l) => Math.log10(Math.max(l.maxMismatch, 1e-16)));
  const finite = lg.filter(Number.isFinite);
  const top = Math.min(6, Math.max(0, Math.ceil(Math.max(...finite))));
  const bottom = -16;
  const n = sol.log.length;
  const x = (i: number) => L + (n > 1 ? (i / (n - 1)) * (W - L - R) : 0);
  const y = (v: number) => T + ((top - Math.min(Math.max(v, bottom), top)) / (top - bottom)) * (H - T - B);
  let s = "";
  for (let e = top; e >= bottom; e -= 4) {
    s += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(e)}" y2="${y(e)}"/><text class="axis" x="${L - 6}" y="${y(e) + 3.5}" text-anchor="end">1e${e}</text>`;
  }
  s += `<line class="tol" x1="${L}" x2="${W - R}" y1="${y(-8)}" y2="${y(-8)}"/><text class="axis" x="${W - R}" y="${y(-8) - 4}" text-anchor="end">tolerance</text>`;
  const passes = [...new Set(sol.log.map((l) => l.pass))];
  for (const p of passes) {
    const idx = sol.log.flatMap((l, i) => (l.pass === p && Number.isFinite(lg[i]!) ? [i] : []));
    if (p > 0) {
      const bx = (x(idx[0]!) + x(idx[0]! - 1)) / 2;
      s += `<line class="pass" x1="${bx}" x2="${bx}" y1="${T}" y2="${H - B}"/><text class="pass-label" x="${bx + 4}" y="${T + 9}">${p === 1 ? "limits applied, re-solve" : `pass ${p + 1}`}</text>`;
    }
    s += `<polyline class="series" points="${idx.map((i) => `${x(i).toFixed(1)},${y(lg[i]!).toFixed(1)}`).join(" ")}"/>`;
    s += idx.map((i) => `<circle class="pt" cx="${x(i).toFixed(1)}" cy="${y(lg[i]!).toFixed(1)}" r="4"><title>Pass ${p + 1}, iteration ${sol.log[i]!.iter}: ${sol.log[i]!.maxMismatch.toExponential(2)} pu</title></circle>`).join("");
  }
  s += `<text class="axis" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">Newton iterations →</text>`;
  $("#conv").innerHTML = s;
}

function report(net: Network, sol: Solution, load: number): void {
  const st = statusMessage(net, sol);
  const banner = $("#banner");
  banner.className = `banner ${st.tone}`;
  banner.textContent = st.text;

  const dd = (k: string, v: string, note = "") => `<dt>${k}</dt><dd>${v}${note ? `<small>${note}</small>` : ""}</dd>`;
  if (sol.converged) {
    const lowI = sol.vm.indexOf(Math.min(...sol.vm));
    const slack = sol.gens.find((g) => g.state === "slack")!;
    const ctl = sol.gens.filter((g) => g.state !== "slack");
    const maxLoad = Math.max(...sol.flows.map((_, i) => loadingPct(sol, i)));
    $("#stats").innerHTML =
      dd("Total demand", `${fmt(load)} MW`) +
      dd("Slack bus output", `${fmt(sol.slackMW)} MW`, `${fmt(slack.qg)} MVAr`) +
      dd("Network losses", `${fmt(sol.totalLossMW, 2)} MW`) +
      dd("Lowest voltage", `${sol.vm[lowI]!.toFixed(3)} pu`, `bus ${net.buses[lowI]!.id}`) +
      dd("Generators at a Q limit", `${ctl.filter(isLimited).length} of ${ctl.length}`) +
      dd("Busiest line", `${fmt(maxLoad, 0)}%`, "of illustrative rating");
  } else {
    $("#stats").innerHTML = dd("Total demand", `${fmt(load)} MW`);
  }

  $("#log").innerHTML = "<tr><th>Pass</th><th>Iteration</th><th>Max mismatch (pu)</th></tr>" +
    sol.log.map((l) => `<tr><td>${l.pass + 1}</td><td>${l.iter}</td><td>${l.maxMismatch.toExponential(2)}</td></tr>`).join("");
  $("#buses").innerHTML = "<tr><th>Bus</th><th>Role</th><th>V (pu)</th><th>Angle (°)</th><th>P inj (MW)</th><th>Q inj (MVAr)</th></tr>" +
    (sol.converged ? net.buses.map((b, i) => {
      const g = sol.gens.find((gg) => gg.bus === b.id);
      const role = g ? (g.state === "regulating" ? "PV" : g.state === "slack" ? "slack" : `PQ, ${g.state}`) : "PQ";
      return `<tr><td>${b.id}</td><td>${role}</td><td>${sol.vm[i]!.toFixed(4)}</td><td>${fmt((sol.va[i]! * 180) / Math.PI, 2)}</td><td>${fmt(sol.pInj[i]!)}</td><td>${fmt(sol.qInj[i]!)}</td></tr>`;
    }).join("") : "");
}

function update(): void {
  const mw = Number(mwIn.value);
  $("#busOut").textContent = `Bus ${busSel.value}`;
  $("#mwOut").textContent = mw === 0 ? "none" : mw > 0 ? `+${mw} MW generation` : `+${-mw} MW load`;
  $("#scaleOut").textContent = `${scaleIn.value}%`;
  const { net, demandMW } = scenario();
  const sol = solvePowerFlow(net, { enforceQLimits: qlimIn.checked });
  drawDiagram(net, sol);
  drawGens(sol);
  drawConvergence(sol);
  report(net, sol, demandMW);
}

function renderScenario(): void {
  const r = runScenario(base);
  const reachOff = maxLoadScale(base, false), reachOn = maxLoadScale(base, true);
  const v = (s: { lowest: { bus: number; v: number } }) => `${s.lowest.v.toFixed(3)} pu <small>bus ${s.lowest.bus}</small>`;
  const row = (k: string, a: string, b: string, c: string) => `<tr><td>${k}</td><td>${a}</td><td>${b}</td><td>${c}</td></tr>`;
  const group = (k: string) => `<tr class="group"><td colspan="4">${k}</td></tr>`;
  $("#compare").innerHTML =
    `<thead><tr><th></th><th>Q limits off</th><th>Q limits on</th><th>pandapower, limits on</th></tr></thead><tbody>` +
    group("Voltage") +
    row("Lowest bus voltage", v(r.unlimited), v(r.limited), v(r.reference)) +
    group("Generator reactive output, MVAr") +
    r.gens.map((g) => row(`Bus ${g.bus} <small>(Qmax ${g.qmax})</small>`,
      g.unlimitedQ > g.qmax ? `<span class="over">${fmt(g.unlimitedQ)}</span>` : fmt(g.unlimitedQ), fmt(g.limitedQ), fmt(g.referenceQ))).join("") +
    row("Slack, bus 1", fmt(r.unlimited.slackQ), fmt(r.limited.slackQ), fmt(r.reference.slackQ)) +
    group("System") +
    row("Slack real power, MW", fmt(r.unlimited.slackMW), fmt(r.limited.slackMW), fmt(r.reference.slackMW)) +
    row("Losses, MW", fmt(r.unlimited.lossMW, 2), fmt(r.limited.lossMW, 2), fmt(r.reference.lossMW, 2)) +
    row("Highest load that still solves", `×${reachOff.toFixed(2)}`, `×${reachOn.toFixed(2)}`, "") +
    `</tbody><tfoot><tr><td colspan="4">Largest gap to pandapower over all 14 buses: ` +
    `${r.agreement.maxDeltaV.toExponential(1)} pu in voltage, ${r.agreement.maxDeltaDeg.toExponential(1)}° in angle, ` +
    `${r.agreement.maxDeltaQ.toExponential(1)} MVAr in generator output. ▲ marks output beyond the machine's Qmax. ` +
    `“Highest load” is found by bisection from a flat start: near the nose of the PV curve it is the solver's reach, not a certified limit.</td></tr></tfoot>`;

  const g = Object.fromEntries(r.gens.map((x) => [x.bus, x]));
  const over = (b: number) => `${Math.round((g[b]!.unlimitedQ / g[b]!.qmax - 1) * 100)}%`;
  $("#reading").innerHTML = `
    <h3>The unconstrained answer looks fine, and isn't</h3>
    <p>With limits off, the lowest voltage is <b>${r.unlimited.lowest.v.toFixed(3)} pu</b> and nothing looks wrong. But holding those set-points takes <b>${fmt(g[2]!.unlimitedQ)} MVAr</b> from the bus 2 generator, which is rated for ${g[2]!.qmax}, and buses 3 and 6 each run ${over(3)} over. No machine can do that. The healthy voltages are bought with reactive power that doesn't exist.</p>
    <h3>With real limits, the reactive reserve is gone</h3>
    <p>Enforce Qmin–Qmax and all four generators pin at their ceilings, so nothing but the slack is regulating voltage. Voltages sag across the network: bus ${r.limited.lowest.bus} falls to <b>${r.limited.lowest.v.toFixed(3)} pu</b>, just inside the 0.94 pu floor. The slack swings from absorbing ${fmt(-r.unlimited.slackQ)} MVAr to supplying ${fmt(r.limited.slackQ)} MVAr across the network, and losses rise by ${fmt(r.limited.lossMW - r.unlimited.lossMW, 2)} MW. pandapower lands on the same answer to within ${r.agreement.maxDeltaV.toExponential(0)} pu at every bus.</p>
    <h3>What an engineer takes from it</h3>
    <p>At higher load this network runs short of reactive power first. One more step, to 150%, puts bus ${r.nextStep.lowest.bus} at <b>${r.nextStep.lowest.v.toFixed(3)} pu</b>, a violation. The solver stops finding any solution past <b>×${reachOn.toFixed(2)}</b> load, against ×${reachOff.toFixed(2)} with limits ignored: a study that skipped Q limits would report a +${Math.round((reachOff - 1) * 100)}% load margin where this model finds about +${Math.round((reachOn - 1) * 100)}%. The fix to study is reactive support near the load (switched capacitors or a STATCOM around buses 9–14), not just more generation.</p>
    <p class="caveat">What this study leaves out: the slack's ${fmt(r.limited.slackMW)} MW is above its ${base.gens[0]!.pmax} MW Pmax, so a real study would also redispatch real power; and the line ratings here are illustrative, so a line near 100% on the diagram is not a finding.</p>`;
}

busSel.addEventListener("change", update);
mwIn.addEventListener("input", update);
scaleIn.addEventListener("input", update);
qlimIn.addEventListener("change", update);
const set = (bus: number, mw: number, scale: number) => {
  busSel.value = String(bus); mwIn.value = String(mw); scaleIn.value = String(scale); qlimIn.checked = true; update();
};
$("#preset-solar").addEventListener("click", () => set(9, 200, 100));
$("#preset-load").addEventListener("click", () => set(9, 0, SCENARIO_SCALE * 100));
$("#preset-load-2").addEventListener("click", () => {
  set(9, 0, SCENARIO_SCALE * 100);
  $(".workbench").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});
$("#reset").addEventListener("click", () => set(9, 0, 100));
update();
renderScenario();
