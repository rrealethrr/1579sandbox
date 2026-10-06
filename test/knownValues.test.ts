// Port of dcsolvrr/test_known_values.py: the same hand-solved problems.
import { describe, expect, it } from "vitest";
import { KnownValuesError, parseExpression, solveKnown, type Known, type Result } from "../src/solver/knownValues";

const solve = (expr: string, known: Known) => solveKnown(parseExpression(expr), known);
const near = (a: number, b: number, places = 6) => expect(Math.abs(a - b)).toBeLessThan(0.5 * 10 ** -places);

function assertPart(res: Result, name: string, want: Partial<Record<"R" | "V" | "I" | "P", number>>) {
  for (const [q, v] of Object.entries(want)) {
    const got = res.values[name][q as "R"];
    expect(got, `${name}.${q} not solved`).not.toBeNull();
    near(got!, v!);
  }
}
function assertSolved(res: Result) {
  expect(res.warnings).toEqual([]);
  expect(res.complete).toBe(true);
}

describe("parsing", () => {
  it("parallel binds tighter", () => {
    const root = parseExpression("R1 + R2 || R3");
    expect(root.kind).toBe("series");
    expect(root.children[1].kind).toBe("parallel");
    expect(root.children[1].name).toBe("R2 || R3");
  });
  it("flattening and labels", () => {
    const root = parseExpression("(R1 + (R2 + R3)) // R4");
    expect(root.kind).toBe("parallel");
    expect(root.children[0].name).toBe("R1 + R2 + R3");
  });
  it("errors", () => {
    for (const [bad, msg] of [["", "Enter"], ["R1 +", "ends too early"], ["R1 + (R2", "Missing"],
      ["R1 + R1", "only once"], ["R1 * R2", "Unexpected"], ["R1 R2", "Unexpected"]]) {
      expect(() => parseExpression(bad)).toThrow(KnownValuesError);
      expect(() => parseExpression(bad)).toThrow(msg);
    }
  });
});

describe("series", () => {
  it("from resistors and voltage", () => {
    const res = solve("R1 + R2 + R3", { Total: { V: 24 }, R1: { R: 1 }, R2: { R: 2 }, R3: { R: 3 } });
    assertSolved(res);
    assertPart(res, "Total", { R: 6, I: 4, P: 96 });
    assertPart(res, "R3", { V: 12, P: 48 });
  });
  it("missing resistor from totals", () => {
    const res = solve("R1 + R2 + R3", { Total: { V: 12, I: 2 }, R1: { R: 2 }, R2: { R: 3 } });
    assertSolved(res);
    assertPart(res, "R3", { R: 1, V: 2, P: 4 });
  });
  it("quadratic reports both answers", () => {
    const res = solve("R1 + R2", { Total: { V: 10 }, R1: { R: 1 }, R2: { P: 16 } });
    expect(res.complete).toBe(true);
    expect([4, 0.25]).toContain(Math.round(res.values.R2.R! * 1e6) / 1e6);
    expect(res.warnings.length).toBe(1);
    expect(res.warnings[0]).toContain("More than one answer");
    const r2 = res.values.R2.R!, i = res.values.Total.I!;
    near(i * (1 + r2), 10, 7); near(i * i * r2, 16, 7);
  });
});

describe("parallel", () => {
  it("from resistors and voltage", () => {
    const res = solve("R1 || R2 || R3", { Total: { V: 12 }, R1: { R: 4 }, R2: { R: 6 }, R3: { R: 12 } });
    assertSolved(res);
    assertPart(res, "R1", { I: 3, P: 36 });
    assertPart(res, "R2", { I: 2, P: 24 });
    assertPart(res, "R3", { I: 1, P: 12 });
    assertPart(res, "Total", { R: 2, I: 6, P: 72 });
  });
  it("missing resistor from total current", () => {
    const res = solve("R1 || R2 || R3", { Total: { V: 12, I: 6 }, R1: { R: 4 }, R2: { R: 6 } });
    assertSolved(res);
    assertPart(res, "R3", { R: 12, I: 1 });
  });
  it("missing resistor from total resistance", () => {
    const res = solve("R1 || R2 || R3", { Total: { R: 2, I: 6 }, R1: { R: 4 }, R2: { R: 6 } });
    assertSolved(res);
    assertPart(res, "R3", { R: 12 });
  });
  it("from powers", () => {
    const res = solve("R1 || R2 || R3", { Total: { V: 12, P: 72 }, R1: { P: 36 }, R2: { P: 24 } });
    assertSolved(res);
    assertPart(res, "R3", { P: 12, R: 12, I: 1 });
  });
});

describe("combination", () => {
  it("series then parallel", () => {
    const res = solve("R1 + (R2 || R3)", { Total: { V: 12 }, R1: { R: 4 }, R2: { R: 6 }, R3: { R: 12 } });
    assertSolved(res);
    assertPart(res, "Total", { R: 8, I: 1.5, P: 18 });
    assertPart(res, "R1", { V: 6, P: 9 });
    assertPart(res, "R2 || R3", { R: 4, V: 6, I: 1.5 });
    assertPart(res, "R2", { I: 1, P: 6 });
    assertPart(res, "R3", { I: 0.5, P: 3 });
  });
  it("parallel of series branches", () => {
    const res = solve("(R1 + R2) || R3", { Total: { V: 12 }, R1: { R: 2 }, R2: { R: 4 }, R3: { R: 3 } });
    assertSolved(res);
    assertPart(res, "R1 + R2", { I: 2, R: 6 });
    assertPart(res, "R1", { V: 4, P: 8 });
    assertPart(res, "R2", { V: 8, P: 16 });
    assertPart(res, "R3", { I: 4, P: 48 });
    assertPart(res, "Total", { R: 2, I: 6, P: 72 });
  });
  it("known group value finds missing resistor", () => {
    const res = solve("R1 + (R2 || R3)", { Total: { V: 12 }, "R2 || R3": { V: 6 }, R2: { R: 6 }, R3: { R: 12 } });
    assertSolved(res);
    assertPart(res, "R1", { R: 4, V: 6, I: 1.5 });
  });
  it("needs simultaneous equations", () => {
    const res = solve("R1 + (R2 || R3)", { Total: { V: 20, I: 2 }, R1: { P: 24 }, R2: { I: 4 / 3 } });
    assertSolved(res);
    assertPart(res, "R2", { R: 6 });
    assertPart(res, "R3", { R: 12, I: 2 / 3 });
  });
  it("nested three levels", () => {
    const res = solve("R1 + ((R2 + R3) || R4)", { Total: { V: 40 }, R1: { R: 10 }, R2: { R: 5 }, R3: { R: 15 }, R4: { R: 20 } });
    assertSolved(res);
    assertPart(res, "Total", { I: 2, R: 20 });
    assertPart(res, "R2", { I: 1, V: 5 });
    assertPart(res, "R4", { I: 1, V: 20, P: 20 });
  });
});

describe("problems", () => {
  it("not enough information", () => {
    const res = solve("R1 || R2", { Total: { I: 3 }, R1: { R: 10 } });
    expect(res.complete).toBe(false);
    expect(res.warnings[0]).toContain("Not enough information");
  });
  it("conflicting values", () => {
    const res = solve("R1 || R2", { Total: { I: 3, V: 10 }, R1: { I: 5 } });
    expect(res.warnings.some((w) => w.startsWith("Conflict"))).toBe(true);
  });
  it("Ohm's law conflict", () => {
    const res = solve("R1 + R2", { R1: { R: 2, V: 4, I: 3 }, R2: { R: 1 } });
    expect(res.warnings.some((w) => w.startsWith("Conflict"))).toBe(true);
  });
  it("bad values", () => {
    expect(() => solve("R1 + R2", { R1: { R: 0 } })).toThrow(/positive/);
    expect(() => solve("R1 + R2", { R1: { V: -1 } })).toThrow(/positive/);
    expect(() => solve("R1 + R2", { R9: { R: 1 } })).toThrow(/not part/);
  });
});
