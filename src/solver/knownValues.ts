// "Known values" solver for series, parallel and combination circuits. A port of
// dcsolvrr/known_values.py: the same step-by-step rules and log, then a numeric
// fallback (Levenberg-Marquardt in log space) when the rules get stuck.
//
// Expression syntax: "R1 + R2" series, "R1 || R2" parallel ("//" works too),
// parentheses group, and || binds tighter than +.

export const QUANTITIES = ["R", "V", "I", "P"] as const;
export type Q = (typeof QUANTITIES)[number];
export const UNITS: Record<Q, string> = { R: "Ω", V: "V", I: "A", P: "W" };
export const TOTAL = "Total";
const REL_TOL = 1e-6;

export class KnownValuesError extends Error {}

export type PartKind = "R" | "series" | "parallel";

export class Part {
  constructor(public name: string, public kind: PartKind, public children: Part[] = []) {}

  *walk(): Generator<Part> {
    yield this;
    for (const c of this.children) yield* c.walk();
  }

  label(): string {
    if (this.kind === "R") return this.name;
    const sep = this.kind === "series" ? " + " : " || ";
    // || binds tighter than +, so only a series group inside a parallel one needs parentheses.
    return this.children
      .map((c) => (this.kind === "parallel" && c.kind === "series" ? `(${c.label()})` : c.label()))
      .join(sep);
  }
}

/** Build a group, flattening nested groups of the same kind (R1 + (R2 + R3) is one series). */
export function group(kind: "series" | "parallel", parts: Part[]): Part {
  if (parts.length === 1) return parts[0];
  const flat: Part[] = [];
  for (const p of parts) flat.push(...(p.kind === kind ? p.children : [p]));
  return new Part("", kind, flat);
}

/** Name every group by its label and the root "Total", as parse_expression does. */
export function finishTree(root: Part): Part {
  const names = [...root.walk()].filter((p) => p.kind === "R").map((p) => p.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))].sort();
  if (dupes.length) throw new KnownValuesError(`Each resistor can appear only once: ${dupes.join(", ")}`);
  if (names.includes(TOTAL)) throw new KnownValuesError(`'${TOTAL}' is reserved for the whole circuit`);
  for (const p of root.walk()) if (p.kind !== "R") p.name = p.label();
  if (root.kind === "R") root = new Part(TOTAL, "series", [root]);
  root.name = TOTAL;
  return root;
}

const TOKEN = /\s*(?:(\|\||\/\/)|([+()])|([A-Za-z_][A-Za-z0-9_]*)|(\S))/g;

export function parseExpression(text: string): Part {
  const tokens: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const [, par, sym, name, bad] = m;
    if (bad) throw new KnownValuesError(`Unexpected character '${bad}'. Use resistor names, +, ||, and parentheses.`);
    if (par || sym || name) tokens.push(par ? "||" : sym || name);
  }
  if (!tokens.length) throw new KnownValuesError("Enter a circuit, for example: R1 + (R2 || R3)");
  let pos = 0;
  const peek = () => (pos < tokens.length ? tokens[pos] : null);
  const take = () => tokens[pos++];

  const series = (): Part => {
    const parts = [parallel()];
    while (peek() === "+") { take(); parts.push(parallel()); }
    return group("series", parts);
  };
  const parallel = (): Part => {
    const parts = [atom()];
    while (peek() === "||") { take(); parts.push(atom()); }
    return group("parallel", parts);
  };
  const atom = (): Part => {
    const t = peek();
    if (t === null) throw new KnownValuesError("The expression ends too early");
    if (t === "(") {
      take();
      const inner = series();
      if (peek() !== ")") throw new KnownValuesError("Missing ')'");
      take();
      return inner;
    }
    if (t === "+" || t === "||" || t === ")") throw new KnownValuesError(`Expected a resistor name before '${t}'`);
    take();
    return new Part(t, "R");
  };

  const root = series();
  if (pos !== tokens.length) throw new KnownValuesError(`Unexpected '${tokens[pos]}'`);
  return finishTree(root);
}

export type Values = Record<string, Record<Q, number | null>>;
export type Known = Record<string, Partial<Record<Q, number | null>>>;

export interface Result {
  values: Values;
  log: string[];
  warnings: string[];
  complete: boolean;
}

export function solveKnown(root: Part, known: Known): Result {
  const parts = [...root.walk()];
  const names = new Set(parts.map((p) => p.name));
  for (const name of Object.keys(known)) {
    if (!names.has(name)) throw new KnownValuesError(`'${name}' is not part of the circuit`);
  }
  const vals: Values = {};
  for (const p of parts) vals[p.name] = { R: null, V: null, I: null, P: null };
  const given: [string, Q, number][] = [];
  for (const [name, qs] of Object.entries(known)) {
    for (const q of QUANTITIES) {
      const raw = qs[q];
      if (raw === null || raw === undefined) continue;
      const v = Number(raw);
      if (!isFinite(v) || v < 0 || (q === "R" && v === 0)) {
        throw new KnownValuesError(`${name} ${q} must be a positive number (got ${fmt(v)})`);
      }
      vals[name][q] = v;
      given.push([name, q, v]);
    }
  }
  if (!given.length) throw new KnownValuesError("Enter at least a few known values");

  const log: string[] = [];
  const warnings: string[] = [];
  propagate(root, vals, log, warnings);
  const anyMissing = () => Object.values(vals).some((p) => QUANTITIES.some((q) => p[q] === null));
  if (!warnings.length && anyMissing()) numericFallback(root, vals, given, log, warnings);

  const missing = Object.entries(vals).filter(([, p]) => QUANTITIES.some((q) => p[q] === null)).map(([n]) => n).sort();
  if (missing.length && !warnings.length) {
    warnings.push("Not enough information to find everything. Still unknown: " + missing.join(", ") + ". Add another known value.");
  }
  return { values: vals, log, warnings, complete: !missing.length };
}

export function fmt(x: number): string {
  if (!isFinite(x)) return String(x);
  // Python's "%.6g"
  const s = x.toPrecision(6);
  if (s.includes("e")) {
    const [mant, exp] = s.split("e");
    const m = mant.includes(".") ? mant.replace(/0+$/, "").replace(/\.$/, "") : mant;
    const e = parseInt(exp);
    return `${m}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  }
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= REL_TOL * Math.max(Math.abs(a), Math.abs(b), 1e-12);
}

function propagate(root: Part, vals: Values, log: string[], warnings: string[]): void {
  const reported = new Set<string>();
  const conflict = (msg: string) => {
    if (!reported.has(msg)) { reported.add(msg); warnings.push("Conflict: " + msg); }
  };
  const put = (name: string, q: Q, value: number | null, how: string): boolean => {
    if (value === null || !isFinite(value)) return false;
    if (value < 0) {
      if (value > -1e-9 * (Math.abs(value) + 1)) value = 0;
      else { conflict(`${name} ${q} would be ${fmt(value)} ${UNITS[q]} (${how}); the given values don't add up`); return false; }
    }
    const cur = vals[name][q];
    if (cur === null) {
      vals[name][q] = value;
      log.push(`${name}: ${q} = ${how} = ${fmt(value)} ${UNITS[q]}`);
      return true;
    }
    if (!close(cur, value)) conflict(`${name} ${q} is ${fmt(cur)} ${UNITS[q]}, but ${how} gives ${fmt(value)} ${UNITS[q]}`);
    return false;
  };

  const ohm = (p: Part): boolean => {
    const n = p.name;
    let changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const { R, V, I, P } = vals[n];
      if (V !== null && I !== null) {
        if (I > 0) changed = put(n, "R", V / I, "V / I") || changed;
        changed = put(n, "P", V * I, "V × I") || changed;
      }
      if (V !== null && R !== null) {
        changed = put(n, "I", V / R, "V / R") || changed;
        changed = put(n, "P", (V * V) / R, "V² / R") || changed;
      }
      if (I !== null && R !== null) {
        changed = put(n, "V", I * R, "I × R") || changed;
        changed = put(n, "P", I * I * R, "I² × R") || changed;
      }
      if (P !== null && V !== null && V > 0) {
        changed = put(n, "I", P / V, "P / V") || changed;
        if (P > 0) changed = put(n, "R", (V * V) / P, "V² / P") || changed;
      }
      if (P !== null && I !== null && I > 0) {
        changed = put(n, "V", P / I, "P / I") || changed;
        changed = put(n, "R", P / (I * I), "P / I²") || changed;
      }
      if (P !== null && R !== null) {
        changed = put(n, "I", Math.sqrt(P / R), "√(P / R)") || changed;
        changed = put(n, "V", Math.sqrt(P * R), "√(P × R)") || changed;
      }
    }
    return changed;
  };

  const shared = (p: Part, q: Q): boolean => {
    const members = [p, ...p.children];
    const k = members.map((m) => vals[m.name][q]).find((v) => v !== null);
    if (k === undefined || k === null) return false;
    const why = q === "I" ? "same current in series" : "same voltage in parallel";
    let changed = false;
    for (const m of members) changed = put(m.name, q, k, why) || changed;
    return changed;
  };

  const summed = (p: Part, q: Q, inverse = false): boolean => {
    const get = (name: string) => { const v = vals[name][q]; return v === null ? null : inverse ? 1 / v : v; };
    const conv = (x: number) => (inverse ? (x > 0 ? 1 / x : null) : x);
    const kids = p.children.map((c) => c.name);
    const kidVals = kids.map(get);
    const unknown = kids.filter((_, i) => kidVals[i] === null);
    let word = ({ R: "resistances", V: "voltages", I: "currents", P: "powers" } as const)[q] as string;
    if (inverse) word = "1/R";
    if (!unknown.length) {
      const s = (kidVals as number[]).reduce((a, b) => a + b, 0);
      return put(p.name, q, conv(s), inverse ? "1 / (sum of 1/R)" : `sum of ${word}`);
    }
    const parent = get(p.name);
    if (parent !== null && unknown.length === 1) {
      const rest = kidVals.reduce<number>((a, b) => a + (b ?? 0), 0);
      let diff = parent - rest;
      if (Math.abs(diff) <= 1e-9 * Math.max(Math.abs(parent), 1e-12)) diff = 0;
      if (diff < 0 || (inverse && diff === 0)) {
        conflict(`${unknown[0]} ${q} would be ${inverse ? "infinite" : "negative"}; the values given for ${p.name} don't add up`);
        return false;
      }
      return put(unknown[0], q, conv(diff), `${p.name === TOTAL ? "total" : p.name} minus the others (${word})`);
    }
    return false;
  };

  const groups = [...root.walk()].filter((p) => p.kind !== "R");
  const every = [...root.walk()];
  let changed = true;
  while (changed && !warnings.length) {
    changed = false;
    for (const p of every) changed = ohm(p) || changed;
    for (const g of groups) {
      if (g.kind === "series") {
        changed = shared(g, "I") || changed;
        for (const q of ["V", "R", "P"] as Q[]) changed = summed(g, q) || changed;
      } else {
        changed = shared(g, "V") || changed;
        for (const q of ["I", "P"] as Q[]) changed = summed(g, q) || changed;
        changed = summed(g, "R", true) || changed;
      }
    }
  }
}

type Full = Record<string, Record<Q, number>>;

function forward(root: Part, leafR: Record<string, number>, vTotal: number): Full {
  const out: Full = {};
  const resistance = (p: Part): number => {
    let r: number;
    if (p.kind === "R") r = leafR[p.name];
    else if (p.kind === "series") r = p.children.reduce((s, c) => s + resistance(c), 0);
    else r = 1 / p.children.reduce((s, c) => s + 1 / resistance(c), 0);
    out[p.name] = { R: r, V: 0, I: 0, P: 0 };
    return r;
  };
  const fill = (p: Part, v: number) => {
    const r = out[p.name].R;
    const i = v / r;
    Object.assign(out[p.name], { V: v, I: i, P: v * i });
    for (const c of p.children) fill(c, p.kind === "parallel" ? v : i * out[c.name].R);
  };
  resistance(root);
  fill(root, vTotal);
  return out;
}

/** Deterministic PRNG so results repeat run to run (Python uses random.Random(0)). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Levenberg-Marquardt over x, from several starting points. Returns distinct solutions
 * where the fit is exact and the Jacobian has full rank (the answer is pinned down).
 * Shared with the drawn-circuit solver.
 */
export function multiStartLM(
  residuals: (x: number[]) => number[] | null,
  base: number[],
  maxSolutions = 3,
  nStarts = 60,
): number[][] {
  const nFree = base.length;
  const jacobian = (x: number[], f0: number[]): number[][] | null => {
    const cols: number[][] = [];
    for (let k = 0; k < x.length; k++) {
      const h = 1e-7;
      const x2 = [...x];
      x2[k] += h;
      const f1 = residuals(x2);
      if (!f1) return null;
      cols.push(f1.map((a, i) => (a - f0[i]) / h));
    }
    return f0.map((_, i) => cols.map((c) => c[i]));
  };
  const sq = (f: number[]) => f.reduce((s, e) => s + e * e, 0);
  const lm = (x: number[]): number[] | null => {
    let lam = 1e-3;
    let f = residuals(x);
    if (!f) return null;
    let cost = sq(f);
    for (let it = 0; it < 200; it++) {
      if (cost < 1e-24) break;
      const J = jacobian(x, f);
      if (!J) return null;
      const n = x.length;
      const JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a] * row[b], 0)));
      const Jtf = Array.from({ length: n }, (_, a) => J.reduce((s, row, i) => s + row[a] * f![i], 0));
      let improved = false;
      for (let t = 0; t < 20; t++) {
        const A = JtJ.map((row, a) => row.map((v, b) => v + (a === b ? lam * (JtJ[a][a] + 1e-12) : 0)));
        const step = linsolve(A, Jtf.map((g) => -g));
        if (!step) { lam *= 10; continue; }
        const x2 = x.map((a, i) => a + Math.max(-5, Math.min(5, step[i])));
        const f2 = residuals(x2);
        if (f2) {
          const c2 = sq(f2);
          if (c2 < cost) { x = x2; f = f2; cost = c2; lam = Math.max(lam / 10, 1e-12); improved = true; break; }
        }
        lam *= 10;
      }
      if (!improved) break;
    }
    return cost < 1e-18 ? x : null;
  };

  const rng = mulberry32(0);
  const starts = [base, ...Array.from({ length: nStarts }, () => base.map((b) => b + (rng() * 8 - 4)))];
  const solutions: number[][] = [];
  for (const s of starts) {
    const x = lm(s);
    if (!x) continue;
    const f = residuals(x)!;
    const J = jacobian(x, f);
    if (!J || rank(J) < nFree) continue;
    if (!solutions.some((y) => x.every((a, i) => Math.abs(a - y[i]) < 1e-4))) solutions.push(x);
    if (solutions.length >= maxSolutions) break;
  }
  return solutions;
}

function numericFallback(root: Part, vals: Values, given: [string, Q, number][], log: string[], warnings: string[]): void {
  const leaves = [...root.walk()].filter((p) => p.kind === "R").map((p) => p.name);
  const free = leaves.filter((n) => vals[n].R === null);
  const vFree = vals[TOTAL].V === null;
  const nFree = free.length + (vFree ? 1 : 0);
  if (nFree === 0 || given.length < nFree) return;

  const fixedR: Record<string, number> = {};
  for (const n of leaves) if (vals[n].R !== null) fixedR[n] = vals[n].R!;
  const unpack = (x: number[]): [Record<string, number>, number] => {
    const r = { ...fixedR };
    free.forEach((n, k) => { r[n] = Math.exp(x[k]); });
    return [r, vFree ? Math.exp(x[x.length - 1]) : vals[TOTAL].V!];
  };
  const residuals = (x: number[]): number[] | null => {
    const [r, v] = unpack(x);
    const out = forward(root, r, v);
    const res = given.map(([n, q, g]) => (out[n][q] - g) / Math.max(Math.abs(g), 1e-12));
    return res.every(isFinite) ? res : null;
  };

  const scaleR = given.filter(([, q]) => q === "R").map(([, , g]) => g);
  const scaleV = given.filter(([, q]) => q === "V").map(([, , g]) => g);
  const sr = scaleR.length ? scaleR : [1];
  const sv = scaleV.length ? scaleV : [1];
  const base = [
    ...free.map(() => Math.log(sr.reduce((a, b) => a + b, 0) / sr.length)),
    ...(vFree ? [Math.log(Math.max(...sv))] : []),
  ];
  const solutions = multiStartLM(residuals, base);
  if (!solutions.length) return;

  const [r, v] = unpack(solutions[0]);
  const out = forward(root, r, v);
  log.push("The step-by-step rules got stuck, so the remaining values were found by solving the circuit equations together:");
  for (const name of Object.keys(vals)) {
    for (const q of QUANTITIES) {
      if (vals[name][q] === null) {
        vals[name][q] = out[name][q];
        log.push(`${name}: ${q} = ${fmt(out[name][q])} ${UNITS[q]}`);
      }
    }
  }
  if (solutions.length > 1) {
    const describe = (rr: Record<string, number>, vv: number) =>
      [...free.map((n) => `${n} = ${fmt(rr[n])} Ω`), ...(vFree ? [`total V = ${fmt(vv)} V`] : [])].join(", ");
    const alts = solutions.slice(1).map((x) => describe(...unpack(x)));
    warnings.push(`More than one answer fits these values. Shown: ${describe(r, v)}. Also possible: ${alts.join("; ")}.`);
  }
}

export function linsolve(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-300) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

export function rank(J: number[][], tol = 1e-6): number {
  const M = J.map((row) => [...row]);
  const rows = M.length, cols = rows ? M[0].length : 0;
  let rk = 0, r = 0;
  let scale = 0;
  for (const row of M) for (const v of row) scale = Math.max(scale, Math.abs(v));
  scale = scale || 1;
  for (let c = 0; c < cols; c++) {
    if (r >= rows) break;
    let piv = r;
    for (let i = r + 1; i < rows; i++) if (Math.abs(M[i][c]) > Math.abs(M[piv][c])) piv = i;
    if (Math.abs(M[piv][c]) < tol * scale) continue;
    [M[r], M[piv]] = [M[piv], M[r]];
    for (let i = r + 1; i < rows; i++) {
      const f = M[i][c] / M[r][c];
      for (let k = c; k < cols; k++) M[i][k] -= f * M[r][k];
    }
    r++; rk++;
    if (r === rows) break;
  }
  return rk;
}
