import { add, cx, inv, mul, scale, type Cx } from "./complex";
import type { Network } from "./model";

/** Bus admittance matrix with pi-model lines, off-nominal taps and bus shunts. */
export function buildYbus(net: Network): { G: number[][]; B: number[][] } {
  const n = net.buses.length;
  const index = new Map(net.buses.map((b, i) => [b.id, i]));
  const Y: Cx[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => cx(0)));
  for (const br of net.branches) {
    const i = index.get(br.from)!;
    const k = index.get(br.to)!;
    const ys = inv(cx(br.r, br.x));
    const halfCharging = cx(0, br.b / 2);
    const yff = scale(add(ys, halfCharging), 1 / (br.tap * br.tap));
    const ytt = add(ys, halfCharging);
    const yft = scale(ys, -1 / br.tap);
    Y[i]![i] = add(Y[i]![i]!, yff);
    Y[k]![k] = add(Y[k]![k]!, ytt);
    Y[i]![k] = add(Y[i]![k]!, yft);
    Y[k]![i] = add(Y[k]![i]!, yft);
  }
  net.buses.forEach((b, i) => {
    Y[i]![i] = add(Y[i]![i]!, mul(cx(b.gs / net.baseMVA, b.bs / net.baseMVA), cx(1)));
  });
  return { G: Y.map((r) => r.map((c) => c.re)), B: Y.map((r) => r.map((c) => c.im)) };
}
