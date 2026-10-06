// Port of dcsolvrr/test_mna.py: the same hand-solved circuits.
import { describe, expect, it } from "vitest";
import { Circuit, CircuitError, parseValue, solve, solveNetlist, type Solution } from "../src/solver/mna";

const near = (a: number, b: number, places = 7) => expect(Math.abs(a - b)).toBeLessThan(0.5 * 10 ** -places);

function assertResistor(sol: Solution, name: string, R: number, V: number, I: number, P: number) {
  const r = sol.resistors[name];
  near(r.R, R, 9); near(r.V, V, 9); near(r.I, I, 9); near(r.P, P, 9);
}
function assertPowerBalances(sol: Solution) {
  near(Object.values(sol.sources).reduce((s, x) => s + x.P, 0), sol.totalPower, 9);
}

describe("series", () => {
  it("two resistors", () => {
    const sol = solveNetlist("V1 1 0 12\nR1 1 2 2\nR2 2 0 4");
    assertResistor(sol, "R1", 2, 4, 2, 8);
    assertResistor(sol, "R2", 4, 8, 2, 16);
    near(sol.sources.V1.I, 2); near(sol.sources.V1.P, 24);
    assertPowerBalances(sol);
  });
  it("three resistors", () => {
    const sol = solveNetlist("V1 a gnd 24\nR1 a b 1\nR2 b c 2\nR3 c gnd 3");
    assertResistor(sol, "R1", 1, 4, 4, 16);
    assertResistor(sol, "R2", 2, 8, 4, 32);
    assertResistor(sol, "R3", 3, 12, 4, 48);
    near(sol.totalPower, 96);
  });
});

describe("parallel", () => {
  it("two branches", () => {
    const sol = solveNetlist("V1 1 0 12\nR1 1 0 6\nR2 1 0 3");
    assertResistor(sol, "R1", 6, 12, 2, 24);
    assertResistor(sol, "R2", 3, 12, 4, 48);
    near(sol.sources.V1.I, 6);
    assertPowerBalances(sol);
  });
  it("current source", () => {
    const sol = solveNetlist("I1 0 1 2\nR1 1 0 5\nR2 1 0 20");
    assertResistor(sol, "R1", 5, 8, 1.6, 12.8);
    assertResistor(sol, "R2", 20, 8, 0.4, 3.2);
    near(sol.sources.I1.P, 16);
    assertPowerBalances(sol);
  });
});

describe("mixed", () => {
  it("series-parallel", () => {
    const sol = solveNetlist("V1 1 0 12\nR1 1 2 4\nR2 2 0 6\nR3 2 0 12");
    assertResistor(sol, "R1", 4, 6, 1.5, 9);
    assertResistor(sol, "R2", 6, 6, 1, 6);
    assertResistor(sol, "R3", 12, 6, 0.5, 3);
    assertPowerBalances(sol);
  });
  it("two voltage sources", () => {
    const sol = solveNetlist("Va a 0 10\nVb b 0 5\nR1 a m 1\nR2 b m 1\nR3 m 0 1");
    assertResistor(sol, "R1", 1, 5, 5, 25);
    assertResistor(sol, "R2", 1, 0, 0, 0);
    assertResistor(sol, "R3", 1, 5, 5, 25);
    assertPowerBalances(sol);
  });
  it("unbalanced Wheatstone bridge", () => {
    const sol = solveNetlist("V1 1 0 10\nR1 1 a 1\nR2 a 0 2\nR3 1 b 2\nR4 b 0 1\nR5 a b 1");
    const a = 40 / 7, b = 30 / 7;
    near(sol.nodeVoltages.a, a); near(sol.nodeVoltages.b, b);
    assertResistor(sol, "R5", 1, a - b, a - b, (a - b) ** 2);
    assertResistor(sol, "R1", 1, 10 - a, 10 - a, (10 - a) ** 2);
    assertPowerBalances(sol);
  });
  it("reversed resistor reports negative drop", () => {
    const sol = solveNetlist("V1 1 0 12\nR1 1 2 2\nR2 0 2 4");
    assertResistor(sol, "R2", 4, -8, -2, 16);
  });
  it("zero-ohm wire", () => {
    const sol = solveNetlist("V1 1 0 10\nR1 1 2 5\nR2 2 0 0\nR3 2 0 100");
    assertResistor(sol, "R1", 5, 10, 2, 20);
    assertResistor(sol, "R2", 0, 0, 2, 0);
    assertResistor(sol, "R3", 100, 0, 0, 0);
  });
});

describe("API and errors", () => {
  it("builder API", () => {
    const sol = new Circuit().addVoltageSource("V1", 1, 0, 9).addResistor("R1", 1, 0, "4.5k").solve();
    near(sol.resistors.R1.I, 2e-3);
  });
  it("dict API", () => {
    const out = solve([
      { type: "V", name: "V1", a: "1", b: "0", value: 12 },
      { type: "R", name: "R1", a: "1", b: "2", value: 2 },
      { type: "R", name: "R2", a: "2", b: "0", value: 4 },
    ]);
    expect(out.nodes).toEqual({ "0": 0, "1": 12, "2": 8 });
    near(out.resistors.R2.P, 16); near(out.sources.V1.I, 2);
    expect(() => solve([{ type: "R", name: "R1", a: "1", b: "2", value: 1 }])).toThrow(CircuitError);
  });
  it("suffixes", () => {
    expect(parseValue("4.7k")).toBe(4700);
    expect(parseValue("2meg")).toBe(2e6);
    near(parseValue("10m"), 0.01); near(parseValue("1e3"), 1000);
  });
  it("comments and dot commands ignored", () => {
    near(solveNetlist("* title\nV1 1 0 5  ; source\nR1 1 0 5 # load\n.end").resistors.R1.I, 1);
  });
  it("floating node", () => expect(() => solveNetlist("V1 1 0 5\nR1 1 0 5\nR2 7 8 10")).toThrow(/no path to ground/));
  it("voltage source loop", () => expect(() => solveNetlist("V1 1 0 5\nV2 1 0 3\nR1 1 0 5")).toThrow(/cannot be solved/));
  it("no ground", () => expect(() => solveNetlist("V1 1 2 5\nR1 1 2 5")).toThrow(/ground/));
  it("bad lines", () => {
    expect(() => solveNetlist("V1 1 0 5\nR1 1 0")).toThrow(/Line 2/);
    expect(() => solveNetlist("C1 1 0 5")).toThrow(/must start with R, V or I/);
    expect(() => solveNetlist("V1 1 0 5\nR1 1 0 -5")).toThrow(/negative/);
    expect(() => solveNetlist("V1 1 0 5\nR1 1 0 5\nR1 1 0 5")).toThrow(/Duplicate/);
  });
});
