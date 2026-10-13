export type BusType = "PQ" | "PV" | "slack";

export interface Bus {
  id: number;
  type: BusType;
  /** MW / MVAr demand */
  pd: number;
  qd: number;
  /** shunt, MW / MVAr at 1.0 pu */
  gs: number;
  bs: number;
  vm: number;
  va: number;
}
export interface Gen {
  bus: number;
  pg: number;
  qg: number;
  /** reactive capability, MVAr */
  qmax: number;
  qmin: number;
  vg: number;
  pmax: number;
}
export interface Branch {
  from: number;
  to: number;
  r: number;
  x: number;
  b: number;
  /** off-nominal tap ratio; 1 for plain lines */
  tap: number;
}
export interface Network {
  baseMVA: number;
  buses: Bus[];
  gens: Gen[];
  branches: Branch[];
}

/**
 * Parse the subset of MATPOWER case format needed here (bus, gen, branch matrices).
 * Out-of-service generators and branches are left out. Phase shifters are not modelled, so a
 * branch with a non-zero shift angle is an error rather than a wrong answer.
 */
export function parseMatpower(text: string): Network {
  const baseMatch = /mpc\.baseMVA\s*=\s*([\d.]+)/.exec(text);
  if (!baseMatch) throw new Error("MATPOWER: baseMVA not found");
  const matrix = (name: string): number[][] => {
    const m = new RegExp(`mpc\\.${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(text);
    if (!m) throw new Error(`MATPOWER: mpc.${name} not found`);
    return m[1]!
      .split("\n")
      .map((l) => l.replace(/%.*/, ""))
      .join("\n")
      .split(/[;\n]/) // a row ends at a semicolon or a line break
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/).map(Number));
  };
  const typeOf = (t: number): BusType => (t === 3 ? "slack" : t === 2 ? "PV" : "PQ");
  const buses = matrix("bus").map((r): Bus => ({
    id: r[0]!, type: typeOf(r[1]!), pd: r[2]!, qd: r[3]!, gs: r[4]!, bs: r[5]!, vm: r[7]!, va: r[8]!,
  }));
  const gens = matrix("gen").filter((r) => r[7] !== 0).map((r): Gen => ({
    bus: r[0]!, pg: r[1]!, qg: r[2]!, qmax: r[3]!, qmin: r[4]!, vg: r[5]!, pmax: r[8]!,
  }));
  const branches = matrix("branch").filter((r) => r[10] !== 0).map((r): Branch => {
    if (r[9] !== undefined && r[9] !== 0) {
      throw new Error(`MATPOWER: branch ${r[0]} to ${r[1]} has a phase shift, which this solver does not model`);
    }
    return { from: r[0]!, to: r[1]!, r: r[2]!, x: r[3]!, b: r[4]!, tap: r[8] === 0 ? 1 : r[8]! };
  });
  return { baseMVA: Number(baseMatch[1]), buses, gens, branches };
}
