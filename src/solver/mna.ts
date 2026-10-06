// General DC solver using Modified Nodal Analysis. A port of dcsolvrr/mna.py:
// same netlist format, sign conventions and error messages.
//
// Sign conventions:
//  * Resistor V is the drop V(node+) - V(node-); I flows node+ -> node- through it.
//    P = V * I is always >= 0.
//  * Source I is the current delivered out of its + terminal, P the power it delivers.
//    For a current source, V is V(node-) - V(node+).

export const GROUND_NAMES = new Set(["0", "gnd", "GND", "ground"]);

export class CircuitError extends Error {}

const SUFFIXES: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, meg: 1e6, g: 1e9,
};
const VALUE_RE = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(meg|[pnuµmkg])?$/i;

/** SPICE-style value, e.g. "4.7k" -> 4700. "M" and "m" both mean milli; use "meg". */
export function parseValue(text: string): number {
  const m = VALUE_RE.exec(text.trim());
  if (!m) throw new CircuitError(`Cannot read value '${text}'`);
  const scale = m[2] ? SUFFIXES[m[2].toLowerCase()] : 1;
  return parseFloat(m[1]) * scale;
}

export type Kind = "R" | "V" | "I";

export interface Element {
  name: string;
  kind: Kind;
  nPlus: string;
  nMinus: string;
  value: number;
}

export interface Quantities { R: number; V: number; I: number; P: number }

export interface Solution {
  nodeVoltages: Record<string, number>;
  resistors: Record<string, Quantities>;
  sources: Record<string, { V: number; I: number; P: number }>;
  totalPower: number;
}

function normNode(n: string | number): string {
  const s = String(n).trim();
  return GROUND_NAMES.has(s) ? "0" : s;
}

export class Circuit {
  elements: Element[] = [];

  add(kind: Kind, name: string, nPlus: string | number, nMinus: string | number, value: number | string): this {
    if (this.elements.some((e) => e.name === name)) throw new CircuitError(`Duplicate element name '${name}'`);
    const a = normNode(nPlus), b = normNode(nMinus);
    const v = typeof value === "string" ? parseValue(value) : Number(value);
    if (kind === "R" && v < 0) throw new CircuitError(`${name}: resistance must not be negative (got ${v})`);
    if (a === b && kind === "V" && v !== 0) throw new CircuitError(`${name}: voltage source shorted (both ends on node ${a})`);
    this.elements.push({ name, kind, nPlus: a, nMinus: b, value: v });
    return this;
  }
  addResistor(name: string, a: string | number, b: string | number, ohms: number | string) { return this.add("R", name, a, b, ohms); }
  addVoltageSource(name: string, a: string | number, b: string | number, volts: number | string) { return this.add("V", name, a, b, volts); }
  addCurrentSource(name: string, a: string | number, b: string | number, amps: number | string) { return this.add("I", name, a, b, amps); }
  solve(): Solution { return solveElements(this.elements); }
}

export function parseNetlist(text: string): Circuit {
  const circuit = new Circuit();
  text.split(/\r?\n/).forEach((raw, i) => {
    const lineno = i + 1;
    const line = raw.split(/[*#;]/, 1)[0].trim();
    if (!line || line.startsWith(".")) return;
    const parts = line.split(/\s+/);
    if (parts.length !== 4) throw new CircuitError(`Line ${lineno}: expected 'NAME NODE+ NODE- VALUE', got '${raw.trim()}'`);
    const [name, n1, n2, val] = parts;
    const kind = name[0].toUpperCase();
    if (!"RVI".includes(kind)) throw new CircuitError(`Line ${lineno}: element '${name}' must start with R, V or I`);
    try {
      circuit.add(kind as Kind, name, n1, n2, val);
    } catch (e) {
      throw new CircuitError(`Line ${lineno}: ${(e as Error).message}`);
    }
  });
  return circuit;
}

export function solveNetlist(text: string): Solution {
  return parseNetlist(text).solve();
}

export interface DictElement { type: string; name: string; a: string | number; b: string | number; value: number | string }

/** Dict API like mna.solve(): returns nodes (incl. "0"), resistors and sources. */
export function solve(elements: DictElement[]) {
  const c = new Circuit();
  for (const e of elements) {
    const kind = String(e.type).toUpperCase();
    if (!["R", "V", "I"].includes(kind)) throw new CircuitError(`${e.name ?? "?"}: unknown element type '${e.type}'`);
    c.add(kind as Kind, e.name, e.a, e.b, e.value);
  }
  const sol = c.solve();
  return { nodes: { "0": 0, ...sol.nodeVoltages }, resistors: sol.resistors, sources: sol.sources };
}

function nodeSortKey(a: string, b: string): number {
  const da = /^\d+$/.test(a), db = /^\d+$/.test(b);
  if (da && db) return parseInt(a) - parseInt(b);
  if (da !== db) return da ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function solveElements(elements: Element[]): Solution {
  if (!elements.length) throw new CircuitError("Circuit is empty");
  if (!elements.some((e) => e.kind === "R")) throw new CircuitError("Circuit has no resistors");

  const all = new Set<string>();
  for (const e of elements) { all.add(e.nPlus); all.add(e.nMinus); }
  const nodes = [...all].filter((n) => n !== "0").sort(nodeSortKey);
  if (nodes.length === all.size) throw new CircuitError("Circuit has no ground node; name one node '0' or 'gnd'");
  const idx = new Map(nodes.map((n, i) => [n, i]));

  // A zero-ohm resistor (a wire) is modelled as a 0 V source so its current is known.
  const branch = elements.filter((e) => e.kind === "V" || (e.kind === "R" && e.value === 0));
  const n = nodes.length, m = branch.length, size = n + m;
  const A = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const z = new Array<number>(size).fill(0);
  const node = (name: string) => idx.get(name);

  for (const e of elements) {
    const a = node(e.nPlus), b = node(e.nMinus);
    if (e.kind === "R" && e.value > 0) {
      const g = 1 / e.value;
      if (a !== undefined) A[a][a] += g;
      if (b !== undefined) A[b][b] += g;
      if (a !== undefined && b !== undefined) { A[a][b] -= g; A[b][a] -= g; }
    } else if (e.kind === "I") {
      if (a !== undefined) z[a] -= e.value;
      if (b !== undefined) z[b] += e.value;
    }
  }
  branch.forEach((e, k) => {
    const row = n + k;
    const a = node(e.nPlus), b = node(e.nMinus);
    if (a !== undefined) { A[a][row] += 1; A[row][a] += 1; }
    if (b !== undefined) { A[b][row] -= 1; A[row][b] -= 1; }
    z[row] = e.kind === "V" ? e.value : 0;
  });

  const x = gaussSolve(A, z);
  if (!x) throw new CircuitError(singularHint(elements, nodes));

  const v: Record<string, number> = { "0": 0 };
  idx.forEach((i, nm) => { v[nm] = x[i]; });
  const branchCurrent = new Map(branch.map((e, k) => [e.name, x[n + k]]));

  const resistors: Solution["resistors"] = {};
  const sources: Solution["sources"] = {};
  for (const e of elements) {
    const drop = v[e.nPlus] - v[e.nMinus];
    if (e.kind === "R") {
      const i = e.value === 0 ? branchCurrent.get(e.name)! : drop / e.value;
      resistors[e.name] = { R: e.value, V: clean(drop), I: clean(i), P: clean(drop * i) };
    } else if (e.kind === "V") {
      const i = -branchCurrent.get(e.name)!;
      sources[e.name] = { V: e.value, I: clean(i), P: clean(e.value * i) };
    } else {
      sources[e.name] = { V: clean(-drop), I: e.value, P: clean(-drop * e.value) };
    }
  }
  const nodeVoltages: Record<string, number> = {};
  for (const nm of nodes) nodeVoltages[nm] = clean(v[nm]);
  const total = clean(Object.values(resistors).reduce((s, r) => s + r.P, 0));
  return { nodeVoltages, resistors, sources, totalPower: total };
}

/** Gaussian elimination with partial pivoting. Returns null if singular. */
export function gaussSolve(A: number[][], z: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, z[i]]);
  let scale = 0;
  for (const row of A) for (const x of row) scale = Math.max(scale, Math.abs(x));
  const eps = 1e-12 * (scale || 1);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < eps) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / M[col][col];
      if (f) for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = s / M[r][r];
  }
  return x;
}

function singularHint(elements: Element[], nodes: string[]): string {
  const adj = new Map<string, Set<string>>([...nodes, "0"].map((nd) => [nd, new Set()]));
  for (const e of elements) {
    if (e.kind === "R" || e.kind === "V") {
      adj.get(e.nPlus)!.add(e.nMinus);
      adj.get(e.nMinus)!.add(e.nPlus);
    }
  }
  const seen = new Set(["0"]), stack = ["0"];
  while (stack.length) {
    for (const nb of adj.get(stack.pop()!)!) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  const floating = nodes.filter((nd) => !seen.has(nd));
  if (floating.length) {
    return `Circuit cannot be solved: node(s) ${floating.join(", ")} have no path to ground ` +
      "through resistors or voltage sources";
  }
  return "Circuit cannot be solved: it likely has a loop made only of voltage sources and wires, " +
    "or a current source in series with nothing that can carry its current";
}

/** Remove floating-point noise like 1.9999999999 -> 2 and -0 -> 0. */
export function clean(x: number): number {
  const r = parseFloat(x.toPrecision(12));
  return Math.abs(r) < 1e-15 ? 0 : r;
}
