// Real-wire mode: runs, wire resistance in the solve, NEC checks and auto sizing.
import { describe, expect, it } from "vitest";
import { analyze, type Numbers } from "../src/solver/circuit";
import { Sketch } from "../src/draw";
import { EXAMPLES } from "../src/examples";
import { parseValue } from "../src/solver/units";
import { analyzeWires, findRuns, DEFAULT_WIRE_SETTINGS, type WireSettings } from "../src/solver/wires";
import { checkDrop, checkRun, worst } from "../src/solver/nec";
import type { Doc } from "../src/model";

const near = (a: number, b: number, tol = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(tol * Math.max(1, Math.abs(b)));

function knownOf(doc: Doc): Record<string, Numbers> {
  const k: Record<string, Numbers> = {};
  for (const item of Object.values(doc)) {
    if (!item.name) continue;
    k[item.name] = {};
    for (const [q, t] of Object.entries(item.known ?? {})) if (t) k[item.name][q as "R"] = parseValue(t);
  }
  return k;
}
const wired = (doc: Doc, s: Partial<WireSettings> = {}) => analyzeWires(doc, analyze(doc, knownOf(doc)), { ...DEFAULT_WIRE_SETTINGS, on: true, ...s })!;

/** 120 V into a 7.5 Ω load: 3 squares of wire on the + side, 11 on the return. */
const loop = () => new Sketch().wire([0, 1], [0, 0], [5, 0], [5, 3], [0, 3], [0, 2])
  .v("V1", 0, 1, 0, 2, { V: "120" }).r("R1", 2, 0, 3, 0, { R: "7.5" }).doc;

describe("runs", () => {
  it("splits wire at parts and junctions", () => {
    const runs = findRuns(loop()).map((r) => r.edges.length).sort((a, b) => a - b);
    expect(runs).toEqual([3, 11]);
    // The parallel example: each branch between the rails is its own run.
    const par = findRuns(EXAMPLES[1].build());
    expect(par.reduce((n, r) => n + r.edges.length, 0)).toBe(Object.values(EXAMPLES[1].build()).filter((i) => i.kind === "wire").length);
  });
});

describe("solving with wire resistance", () => {
  it("matches hand calculation for a fixed 12 AWG copper loop", () => {
    const w = wired(loop(), { size: "12 AWG" });
    const rw = (12.6 * 140) / 6530;
    const i = 120 / (7.5 + rw);
    near(w.runs.reduce((s, r) => s + r.R, 0), rw);
    near(w.loads[0].i, i);
    near(w.loads[0].v, i * 7.5);
    near(w.loads[0].dropPercent, ((120 - i * 7.5) / 120) * 100);
    near(w.totalLoss, i * i * rw);
    expect(w.loads[0].check.verdict).toBe("warn"); // 3.48 %
  });

  it("uses a run's own length and size over the drawn ones", () => {
    const doc = loop();
    for (const r of findRuns(doc)) if (r.edges.length === 11) for (const e of r.edges) doc[e].wire = { lengthFt: 10, size: "4 AWG" };
    const w = wired(doc, { size: "12 AWG" });
    const ret = w.runs.find((r) => r.edges.length === 11)!;
    expect(ret.lengthFt).toBe(10);
    expect(ret.drawnFt).toBe(110);
    near(ret.R, (12.6 * 10) / 41740);
  });

  it("auto-sizes to pass 240.4(D) and stay within 3%", () => {
    const w = wired(loop());
    expect(w.runs.map((r) => r.size)).toEqual(["10 AWG", "10 AWG"]);
    expect(w.verdict).toBe("pass");
    expect(w.worstDrop).toBeLessThanOrEqual(3);
  });

  it("flags a fixed size that is too small", () => {
    const w = wired(loop(), { size: "14 AWG" });
    expect(w.verdict).toBe("fail");
    expect(w.runs[0].checks.find((c) => c.rule === "240.4(D)")!.verdict).toBe("fail");
  });

  it("solves every example with real wires", () => {
    for (const ex of EXAMPLES) {
      const w = wired(ex.build());
      expect(w.problem, ex.name).toBeUndefined();
      expect(w.loads.length, ex.name).toBeGreaterThan(0);
      for (const l of w.loads) expect(l.v, ex.name).toBeLessThanOrEqual(l.vIdeal + 1e-9);
    }
  });

  it("leaves unsolved circuits alone", () => {
    const doc = new Sketch().wire([0, 1], [0, 0], [3, 0], [3, 2], [0, 2]).v("V1", 0, 1, 0, 2, { V: "12" }).r("R1", 1, 0, 2, 0).doc;
    expect(wired(doc).loads).toEqual([]);
  });
});

describe("NEC checks", () => {
  it("rates voltage drop", () => {
    expect(checkDrop(2.9).verdict).toBe("pass");
    expect(checkDrop(4).verdict).toBe("warn");
    expect(checkDrop(5.1).verdict).toBe("fail");
  });
  it("checks size, ampacity and the small-conductor limit", () => {
    expect(worst(checkRun({ metal: "cu", size: "12 AWG", current: 16 }))).toBe("pass");
    expect(checkRun({ metal: "cu", size: "14 AWG", current: 18 }).find((c) => c.rule === "240.4(D)")!.verdict).toBe("fail");
    expect(checkRun({ metal: "cu", size: "16 AWG", current: 1 }).find((c) => c.rule === "310.3(A)")!.verdict).toBe("fail");
    expect(checkRun({ metal: "cu", size: "6 AWG", current: 70 }).find((c) => c.rule === "310.16")!.verdict).toBe("fail");
    expect(checkRun({ metal: "al", size: "14 AWG", current: 1 }).find((c) => c.rule === "310.16")!.verdict).toBe("fail");
  });
});
