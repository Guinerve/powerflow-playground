"""Independent reference solutions for the scenarios the TypeScript solver is tested against.

Reads the same src/case14.m the app uses, solves it with pandapower (Newton-Raphson, its own
Ybus and Jacobian, nothing shared with this repo) and writes src/reference/case14.json.

    uv run --python 3.12 --with pandapower==3.5.6 python reference/generate.py
"""

import json
import logging
import re
import warnings
from pathlib import Path

import numpy as np
import pandapower as pp
from pandapower.converter.pypower import from_ppc

warnings.filterwarnings("ignore")
logging.getLogger("pandapower").setLevel(logging.ERROR)
ROOT = Path(__file__).resolve().parent.parent


def read_case(path: Path) -> dict:
    text = path.read_text()

    def matrix(name: str) -> np.ndarray:
        body = re.search(rf"mpc\.{name}\s*=\s*\[(.*?)\];", text, re.S).group(1)
        rows = [re.sub(r"%.*", "", line).replace(";", "").split() for line in body.splitlines()]
        return np.array([[float(x) for x in r] for r in rows if r])

    bus = matrix("bus")
    # The case leaves baseKV at 0. Per-unit results don't depend on it, but pandapower needs a
    # nominal voltage to build its element models, so use the 135 kV its bundled case14 uses.
    bus[bus[:, 9] == 0, 9] = 135.0
    gen = matrix("gen")
    # MATPOWER gen has 21 columns; the short form ends at Pmin. Pad the rest with zeros.
    gen = np.hstack([gen, np.zeros((gen.shape[0], 21 - gen.shape[1]))])
    return {
        "version": "2",
        "baseMVA": float(re.search(r"mpc\.baseMVA\s*=\s*([\d.]+)", text).group(1)),
        "bus": bus,
        "gen": gen,
        "branch": matrix("branch"),
    }


def solve(load_scale: float, enforce_q_lims: bool) -> dict:
    net = from_ppc(read_case(ROOT / "src" / "case14.m"), f_hz=60)
    net.load.p_mw *= load_scale
    net.load.q_mvar *= load_scale
    pp.runpp(net, algorithm="nr", init="flat", enforce_q_lims=enforce_q_lims,
             tolerance_mva=1e-9, numba=False)
    # from_ppc keeps the case's own bus numbers as the pandapower bus index
    bus_ids = [int(i) for i in net.bus.index]
    gen_q = {int(b): float(q) for b, q in zip(net.gen.bus, net.res_gen.q_mvar)}
    gen_q[int(net.ext_grid.bus.iloc[0])] = float(net.res_ext_grid.q_mvar.iloc[0])
    return {
        "loadScale": load_scale,
        "enforceQLimits": enforce_q_lims,
        "bus": bus_ids,
        "vm": [round(float(v), 8) for v in net.res_bus.vm_pu],
        "vaDeg": [round(float(a), 6) for a in net.res_bus.va_degree],
        "genQ": {str(b): round(q, 5) for b, q in sorted(gen_q.items())},
        "slackMW": round(float(net.res_ext_grid.p_mw.iloc[0]), 5),
        "lossMW": round(float(net.res_line.pl_mw.sum() + net.res_trafo.pl_mw.sum()), 5),
    }


def main() -> None:
    cases = {
        "base": solve(1.0, True),
        "load140_unlimited": solve(1.4, False),
        "load140": solve(1.4, True),
        "load150": solve(1.5, True),
    }
    out = {
        "source": f"pandapower {pp.__version__}, Newton-Raphson, flat start, tolerance 1e-9 MVA",
        "case": "src/case14.m (IEEE 14-bus, MATPOWER format)",
        "notes": "Load scaling multiplies every bus Pd and Qd; generator Pg is fixed so the slack picks up "
                 "the difference. Slack (bus 1) reactive limits are not enforced.",
        "cases": cases,
    }
    dest = ROOT / "src" / "reference" / "case14.json"
    dest.parent.mkdir(exist_ok=True)
    dest.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {dest.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
