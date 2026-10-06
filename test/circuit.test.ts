// Drawn circuits: shape detection, solving from mixed known values, and problems.
import { describe, expect, it } from "vitest";
import { analyze, type Numbers } from "../src/solver/circuit";
import { Sketch } from "../src/draw";
import { EXAMPLES } from "../src/examples";
import { parseValue } from "../src/solver/units";
import type { Doc } from "../src/model";

const near = (a: number | null, b: number, tol = 1e-6) => {
  expect(a).not.toBeNull();
  expect(Math.abs(a! - b)).toBeLessThan(tol * Math.max(1, Math.abs(b)));
};

function knownOf(doc: Doc): Record<string, Numbers> {
  const k: Record<string, Numbers> = {};
  for (const item of Object.values(doc)) {
    if (!item.name) continue;
    k[item.name] = {};
    for (const [q, t] of Object.entries(item.known ?? {})) if (t) k[item.name][q as "R"] = parseValue(t);
  }
  return k;
}
const run = (doc: Doc) => analyze(doc, knownOf(doc));
const example = (name: string) => EXAMPLES.find((e) => e.name === name)!.build();

/** A rectangle loop with the source on the left and the given resistors along the top. */
function seriesLoop(src: Record<string, string>, rs: Record<string, string>[]) {
  const s = new Sketch().wire([0, 1], [0, 0], [8, 0], [8, 3], [0, 3], [0, 2]).v("V1", 0, 1, 0, 2, src);
  rs.forEach((k, i) => s.r(`R${i + 1}`, 1 + 2 * i, 0, 2 + 2 * i, 0, k));
  return s.doc;
}

describe("examples match the hand-solved Python tests", () => {
  it("series", () => {
    const a = run(example("Series"));
    expect(a.shape).toBe("series");
    expect(a.solved).toBe(true);
    near(a.parts.R3.values.V, 12); near(a.parts.R3.values.P, 48);
    near(a.total!.R, 6); near(a.total!.I, 4); near(a.total!.P, 96);
  });
  it("parallel", () => {
    const a = run(example("Parallel"));
    expect(a.shape).toBe("parallel");
    near(a.parts.R1.values.I, 3); near(a.parts.R2.values.I, 2); near(a.parts.R3.values.I, 1);
    near(a.total!.R, 2); near(a.total!.P, 72);
  });
  it("combination", () => {
    const a = run(example("Combination"));
    expect(a.shape).toBe("combination");
    expect(a.expression).toBe("R1 + R2 || R3");
    near(a.parts.R1.values.V, 6); near(a.parts.R2.values.I, 1); near(a.parts.R3.values.P, 3);
    near(a.total!.R, 8);
  });
  it("bridge", () => {
    const a = run(example("Bridge"));
    expect(a.shape).toBe("network");
    const va = 40 / 7, vb = 30 / 7;
    near(a.parts.R5.values.I, va - vb); near(a.parts.R1.values.V, 10 - va);
    expect(a.issues.filter((i) => i.level !== "info")).toEqual([]);
  });
});

describe("known values on a drawing", () => {
  it("missing resistor from source voltage and current", () => {
    const a = run(seriesLoop({ V: "12", I: "2" }, [{ R: "2" }, { R: "3" }, {}]));
    near(a.parts.R3.values.R, 1); near(a.parts.R3.values.P, 4);
    expect(a.log.length).toBeGreaterThan(0);
  });
  it("source voltage from resistor values", () => {
    const a = run(seriesLoop({}, [{ R: "4" }, { V: "8", I: "2" }]));
    near(a.parts.V1.values.V, 16); near(a.parts.V1.values.P, 32);
  });
  it("units are accepted", () => {
    const a = run(seriesLoop({ V: "9V" }, [{ R: "4.5k" }]));
    near(a.parts.R1.values.I, 2e-3);
  });
  it("partial results when information is missing", () => {
    const a = run(seriesLoop({ V: "12" }, [{ R: "2" }, {}]));
    expect(a.solved).toBe(false);
    expect(a.issues.some((i) => i.message.startsWith("Not enough"))).toBe(true);
    expect(a.parts.R1.values.R).toBe(2);
  });
  it("conflicting values are flagged", () => {
    const a = run(seriesLoop({ V: "12" }, [{ R: "2", I: "5" }, { R: "4" }]));
    expect(a.issues.some((i) => i.level === "error" && i.message.startsWith("Conflict"))).toBe(true);
  });
  it("bridge with a missing resistor solved from a measured current", () => {
    const doc = example("Bridge");
    const r5 = Object.values(doc).find((i) => i.name === "R5")!;
    r5.known = { I: String(10 / 7) };
    const a = run(doc);
    near(a.parts.R5.values.R, 1, 1e-5);
  });
  it("two sources", () => {
    // Va = 10 and Vb = 5 feeding a middle node through 1 Ω each, 1 Ω to ground
    const doc = new Sketch()
      .wire([0, 1], [0, 0], [1, 0]).wire([2, 0], [4, 0], [4, 1]).wire([4, 2], [4, 4], [0, 4], [0, 2])
      .wire([4, 0], [6, 0]).wire([7, 0], [8, 0], [8, 1]).wire([8, 2], [8, 4], [4, 4])
      .v("Va", 0, 1, 0, 2, { V: "10" }).v("Vb", 8, 1, 8, 2, { V: "5" })
      .r("R1", 1, 0, 2, 0, { R: "1" }).r("R2", 6, 0, 7, 0, { R: "1" }).r("R3", 4, 1, 4, 2, { R: "1" })
      .doc;
    const a = run(doc);
    expect(a.shape).toBe("multi-source");
    near(a.parts.R1.values.I, 5); near(a.parts.R2.values.I, 0); near(a.parts.R3.values.V, 5);
  });
});

describe("problems", () => {
  it("short circuit", () => {
    const doc = seriesLoop({ V: "12" }, [{ R: "2" }]);
    Object.assign(doc, new Sketch().wire([0, 1], [-1, 1], [-1, 2], [0, 2]).doc);
    const a = run(doc);
    expect(a.issues[0].message).toMatch(/Short circuit/);
    expect(a.solved).toBe(false);
  });
  it("open loop", () => {
    const doc = seriesLoop({ V: "12" }, [{ R: "2" }]);
    delete doc["8,1,8,2"];
    const a = run(doc);
    expect(a.issues.some((i) => /isn't closed/.test(i.message))).toBe(true);
    expect(a.openEnds.length).toBe(2);
  });
  it("resistor shorted by a wire", () => {
    const doc = seriesLoop({ V: "12" }, [{ R: "2" }, { R: "4" }]);
    Object.assign(doc, new Sketch().wire([3, 0], [3, -1], [4, -1], [4, 0]).doc);
    const a = run(doc);
    expect(a.parts.R2.state).toBe("shorted");
    near(a.parts.R1.values.I, 6);
  });
  it("dangling resistor carries no current", () => {
    const doc = seriesLoop({ V: "12" }, [{ R: "2" }]);
    Object.assign(doc, new Sketch().wire([4, 0], [4, -2]).r("R9", 4, -2, 4, -3, { R: "5" }).doc);
    const a = run(doc);
    expect(a.parts.R9.state).toBe("open");
    near(a.parts.R1.values.I, 6);
    expect(a.shape).toBe("series");
  });
  it("floating part", () => {
    const doc = seriesLoop({ V: "12" }, [{ R: "2" }]);
    Object.assign(doc, new Sketch().wire([20, 1], [20, 0], [22, 0], [22, 1]).r("R7", 20, 1, 21, 1, { R: "1" }).r("R8", 21, 1, 22, 1, { R: "1" }).doc);
    const a = run(doc);
    expect(a.parts.R7.state).toBe("floating");
  });
});

describe("current flow", () => {
  it("every edge of a series loop carries the same current", () => {
    const a = run(example("Series"));
    for (const [, c] of a.edgeCurrent) near(Math.abs(c), 4);
  });
  it("Kirchhoff's current law holds at every grid point", () => {
    const doc = example("Combination");
    const a = run(doc);
    const net = new Map<string, number>();
    for (const [k, c] of a.edgeCurrent) {
      const [x1, y1, x2, y2] = k.split(",");
      net.set(`${x1},${y1}`, (net.get(`${x1},${y1}`) ?? 0) - c);
      net.set(`${x2},${y2}`, (net.get(`${x2},${y2}`) ?? 0) + c);
    }
    for (const [, v] of net) expect(Math.abs(v)).toBeLessThan(1e-9);
  });
});

describe("netlist export", () => {
  it("round-trips through the MNA solver", async () => {
    const { toNetlist } = await import("../src/solver/circuit");
    const { solveNetlist } = await import("../src/solver/mna");
    const doc = example("Combination");
    const text = toNetlist(doc, run(doc));
    const sol = solveNetlist(text);
    near(sol.resistors.R2.P, 6);
    expect(text).toMatch(/^V1 \d+ 0 12$/m);
  });
});

describe("source resistance", () => {
  it("is the total resistance the source drives", () => {
    const a = run(example("Combination"));
    near(a.parts.V1.values.R, 8);
    const b = run(example("Bridge"));
    near(b.parts.V1.values.R, 10 / (b.parts.V1.values.I!));
  });
  it("can be typed in as a known value", () => {
    // 12 V source driving 6 Ω total, with R1 = 2 Ω: R2 must be 4 Ω
    const a = run(seriesLoop({ V: "12", R: "6" }, [{ R: "2" }, {}]));
    near(a.parts.R2.values.R, 4); near(a.parts.V1.values.I, 2);
    // same idea in a bridge: total R pins down the missing R5
    const doc = example("Bridge");
    const src = Object.values(doc).find((i) => i.name === "V1")!;
    const r5 = Object.values(doc).find((i) => i.name === "R5")!;
    const full = run(example("Bridge")).parts.V1.values.R!;
    src.known = { V: "10", R: String(full) };
    r5.known = {};
    near(run(doc).parts.R5.values.R, 1, 1e-5);
  });
});
