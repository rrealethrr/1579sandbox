// Turns a drawing into a circuit, works out its shape (series, parallel,
// combination or a general network) and solves it from whatever values are known.
//
//  * Series-parallel circuits with one source go through the known-values solver,
//    which logs a step-by-step hand solution (Total = the source).
//  * Anything else (bridges, several sources) is solved with MNA. Missing
//    resistances or source voltages are then found by fitting the known values.
//  * Every solved circuit finally runs through MNA to get current directions.

import { edgeEnds, ptKey, terminals, type Doc, type Q } from "../model";
import { KnownValuesError, Part, finishTree, group, multiStartLM, solveKnown, fmt, TOTAL, UNITS } from "./knownValues";
import { CircuitError, solveElements, type Element } from "./mna";

export type Numbers = Partial<Record<Q, number>>;
export type Shape = "empty" | "series" | "parallel" | "combination" | "network" | "multi-source";

export const SHAPE_LABEL: Record<Shape, string> = {
  empty: "Nothing to solve yet",
  series: "Series circuit",
  parallel: "Parallel circuit",
  combination: "Combination circuit",
  network: "Complex network",
  "multi-source": "Multi-source network",
};

export interface Issue {
  level: "error" | "warning" | "info";
  message: string;
  /** Edge keys and point keys to highlight. */
  targets: string[];
}

export interface PartResult {
  name: string;
  kind: "R" | "V";
  edge: string;
  values: Record<Q, number | null>;
  given: Set<Q>;
  /** "open", "shorted" or "floating" when no current can flow through it. */
  state: "ok" | "open" | "shorted" | "floating";
}

export interface Analysis {
  shape: Shape;
  expression: string | null;
  issues: Issue[];
  parts: Record<string, PartResult>;
  total: Record<Q, number | null> | null;
  log: string[];
  method: string;
  solved: boolean;
  /** Signed current along each edge, from its a end to its b end. */
  edgeCurrent: Map<string, number>;
  junctions: string[];
  openEnds: string[];
}

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string) { this.parent.set(this.find(a), this.find(b)); }
}

interface Comp {
  name: string;
  kind: "R" | "V";
  edge: string;
  /** Node of the a end (resistor) or + terminal (source). */
  p: string;
  n: string;
  pPt: string;
  nPt: string;
  known: Numbers;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-12);

export function analyze(doc: Doc, known: Record<string, Numbers>): Analysis {
  const out: Analysis = {
    shape: "empty", expression: null, issues: [], parts: {}, total: null, log: [], method: "",
    solved: false, edgeCurrent: new Map(), junctions: [], openEnds: [],
  };
  const issue = (level: Issue["level"], message: string, targets: string[] = []) => out.issues.push({ level, message, targets });

  // ---- nodes: grid points joined by wires
  const uf = new UnionFind();
  const degree = new Map<string, number>();
  for (const [key, item] of Object.entries(doc)) {
    const [a, b] = edgeEnds(key).map(ptKey);
    degree.set(a, (degree.get(a) ?? 0) + 1);
    degree.set(b, (degree.get(b) ?? 0) + 1);
    uf.find(a); uf.find(b);
    if (item.kind === "wire") uf.union(a, b);
  }
  for (const [pt, d] of degree) {
    if (d >= 3) out.junctions.push(pt);
    if (d === 1) out.openEnds.push(pt);
  }

  const comps: Comp[] = [];
  for (const [key, item] of Object.entries(doc)) {
    if (item.kind === "wire") continue;
    const [a, b] = edgeEnds(key).map(ptKey);
    const [pPt, nPt] = item.kind === "V" ? terminals(key, item) : [a, b];
    const name = item.name!;
    comps.push({ name, kind: item.kind, edge: key, p: uf.find(pPt), n: uf.find(nPt), pPt, nPt, known: known[name] ?? {} });
    out.parts[name] = {
      name, kind: item.kind, edge: key, values: { R: null, V: null, I: null, P: null },
      given: new Set(Object.keys(known[name] ?? {}) as Q[]), state: "ok",
    };
    for (const [q, v] of Object.entries(known[name] ?? {})) out.parts[name].values[q as Q] = v!;
  }
  const resistors = comps.filter((c) => c.kind === "R");
  const sources = comps.filter((c) => c.kind === "V");

  if (!Object.keys(doc).length) {
    issue("info", "Draw a closed loop with the wire brush, then drop in a source and some resistors.");
    return out;
  }
  if (!sources.length) issue("info", "Add a power source with the source brush (B).");
  if (!resistors.length) issue("info", "Add a resistor with the resistor brush (R).");
  if (!sources.length || !resistors.length) return out;

  // ---- problems that stop the solve
  for (const s of sources) {
    if (s.p === s.n) issue("error", `Short circuit: a wire connects both ends of ${s.name}.`, [s.edge]);
  }
  const zeroR = resistors.filter((r) => r.known.R === 0);
  for (const r of zeroR) issue("error", `${r.name} can't be 0 Ω. Use a wire instead.`, [r.edge]);
  if (out.issues.some((i) => i.level === "error")) { out.shape = classifyOnly(); return out; }

  // ---- parts that can't carry current
  let active = [...comps];
  const mark = (c: Comp, state: PartResult["state"]) => {
    const pr = out.parts[c.name];
    pr.state = state;
    if (c.kind === "R") Object.assign(pr.values, { V: 0, I: 0, P: 0 });
  };
  for (const r of resistors.filter((r) => r.p === r.n)) {
    mark(r, "shorted");
    issue("warning", `${r.name} is shorted out by a wire, so no current flows through it.`, [r.edge]);
  }
  active = active.filter((c) => out.parts[c.name].state === "ok");

  // Parts in a piece of the drawing with no source are floating.
  const pieceOf = new UnionFind();
  for (const c of active) pieceOf.union(c.p, c.n);
  const powered = new Set(sources.map((s) => pieceOf.find(s.p)));
  const floating = active.filter((c) => !powered.has(pieceOf.find(c.p)));
  if (floating.length) {
    floating.forEach((c) => mark(c, "floating"));
    issue("warning", `${list(floating)} ${floating.length > 1 ? "aren't" : "isn't"} connected to a source.`, floating.map((c) => c.edge));
  }
  active = active.filter((c) => out.parts[c.name].state === "ok");

  // Peel off branches that dead-end: nothing flows through them.
  const open: Comp[] = [];
  for (let changed = true; changed;) {
    changed = false;
    const deg = new Map<string, number>();
    for (const c of active) { deg.set(c.p, (deg.get(c.p) ?? 0) + 1); deg.set(c.n, (deg.get(c.n) ?? 0) + 1); }
    for (const c of active) {
      if (deg.get(c.p) === 1 || deg.get(c.n) === 1) { open.push(c); changed = true; }
    }
    active = active.filter((c) => !open.includes(c));
  }
  if (open.length) {
    open.forEach((c) => mark(c, "open"));
    const openR = open.filter((c) => c.kind === "R");
    const openV = open.filter((c) => c.kind === "V");
    const ends = out.openEnds;
    if (openR.length) issue("warning", `${list(openR)} ${openR.length > 1 ? "sit" : "sits"} on an open branch, so no current flows through ${openR.length > 1 ? "them" : "it"}.`, [...openR.map((c) => c.edge), ...ends]);
    if (openV.length) issue("warning", `${list(openV)} isn't part of a closed loop.`, [...openV.map((c) => c.edge), ...ends]);
  }
  const activeR = active.filter((c) => c.kind === "R");
  const activeV = active.filter((c) => c.kind === "V");
  if (!activeV.length || !activeR.length) {
    issue("error", "The circuit isn't closed yet. Connect the wires into a loop through the source and at least one resistor.", out.openEnds);
    out.shape = classifyOnly();
    return out;
  }

  // ---- shape
  let tree: Part | null = null;
  if (activeV.length === 1) {
    tree = seriesParallelTree(activeR, activeV[0].p, activeV[0].n);
    if (tree) {
      out.shape = shapeOf(tree);
      out.expression = tree.label();
    } else out.shape = "network";
  } else out.shape = "multi-source";

  // ---- solve
  let resolved: Map<string, number> | null = null; // name -> R or source V
  if (tree) {
    out.method = "Step-by-step series and parallel rules";
    const src = activeV[0];
    const kv: Record<string, Numbers> = {};
    for (const r of activeR) if (Object.keys(r.known).length) kv[r.name] = r.known;
    if (Object.keys(src.known).length) kv[TOTAL] = src.known;
    try {
      const res = solveKnown(tree, kv);
      out.log = res.log.map((l) => l.replace(/^Total:/, `${src.name} (total):`));
      for (const w0 of res.warnings) {
        const w = w0.replace(/\bTotal\b/g, src.name);
        issue(w.startsWith("Conflict") ? "error" : w.startsWith("Not enough") ? "info" : "warning", w);
      }
      for (const r of activeR) Object.assign(out.parts[r.name].values, res.values[r.name]);
      const t = res.values[TOTAL];
      // A source's R is the total (equivalent) resistance it drives: V / I.
      Object.assign(out.parts[src.name].values, { R: t.R, V: t.V, I: t.I, P: t.P });
      out.total = { ...t };
      if (res.complete && !res.warnings.some((w) => w.startsWith("Conflict"))) {
        resolved = new Map([...activeR.map((r) => [r.name, res.values[r.name].R!] as const), [src.name, t.V!]]);
      }
    } catch (e) {
      if (!(e instanceof KnownValuesError)) throw e;
      issue("info", e.message.startsWith("Enter at least") ? "Type in some known values: click a part and fill in R, V, I or P." : e.message);
    }
  } else {
    out.method = "Nodal analysis (MNA)";
    resolved = solveNetwork(active, out, issue);
  }

  // ---- final pass through MNA for signs and current flow
  if (resolved) {
    const ground = new Map<string, string>();
    for (const s of activeV) if (!ground.has(pieceOf.find(s.p))) ground.set(pieceOf.find(s.p), s.n);
    const groundNodes = new Set(ground.values());
    const nodeName = (n: string) => (groundNodes.has(n) ? "0" : n);
    const elements: Element[] = active.map((c) => ({ name: c.name, kind: c.kind, nPlus: nodeName(c.p), nMinus: nodeName(c.n), value: resolved!.get(c.name)! }));
    try {
      const sol = solveElements(elements);
      let pTot = 0;
      for (const c of active) {
        const pr = out.parts[c.name];
        if (c.kind === "R") {
          const r = sol.resistors[c.name];
          Object.assign(pr.values, { R: r.R, V: Math.abs(r.V), I: Math.abs(r.I), P: r.P });
          pTot += r.P;
          // Resistor current flows p -> n, and p is the a end of its edge.
          out.edgeCurrent.set(c.edge, r.I);
        } else {
          const s = sol.sources[c.name];
          Object.assign(pr.values, { R: s.I !== 0 ? Math.abs(s.V / s.I) : null, V: s.V, I: Math.abs(s.I), P: Math.abs(s.P) });
          if (s.I < 0) issue("info", `${c.name} is being charged: current is pushed into its + terminal.`, [c.edge]);
          // Inside the source current runs from - to +; out of + is s.I.
          const plusAtA = c.pPt === ptKey(edgeEnds(c.edge)[0]);
          out.edgeCurrent.set(c.edge, plusAtA ? -s.I : s.I);
        }
      }
      if (activeV.length === 1) {
        const s = out.parts[activeV[0].name].values;
        out.total = { R: s.I! > 0 ? s.V! / s.I! : Infinity, V: s.V, I: s.I, P: pTot };
      } else {
        out.total = { R: null, V: null, I: null, P: pTot };
      }
      for (const c of comps) if (out.parts[c.name].state !== "ok") out.edgeCurrent.set(c.edge, 0);
      wireCurrents(doc, out.edgeCurrent);
      out.solved = true;
    } catch (e) {
      if (!(e instanceof CircuitError)) throw e;
      issue("error", e.message);
    }
  }
  return out;

  function classifyOnly(): Shape {
    return sources.length > 1 ? "multi-source" : "empty";
  }
}

function list(cs: { name: string }[]): string {
  const n = cs.map((c) => c.name);
  return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

function shapeOf(tree: Part): Shape {
  const leaves = tree.children.every((c) => c.kind === "R");
  if (leaves && tree.kind === "series") return "series";
  if (leaves && tree.kind === "parallel") return "parallel";
  return "combination";
}

/**
 * Reduce the resistors seen from the source terminals s and t by merging parallel
 * pairs and series chains. Returns the tree, or null when it doesn't reduce
 * (a bridge or mesh).
 */
export function seriesParallelTree(rs: { name: string; p: string; n: string }[], s: string, t: string): Part | null {
  type E = { u: string; v: string; part: Part };
  let edges: E[] = rs.map((r) => ({ u: r.p, v: r.n, part: new Part(r.name, "R") }));
  const pairKey = (e: E) => (e.u < e.v ? `${e.u}|${e.v}` : `${e.v}|${e.u}`);
  for (let changed = true; changed;) {
    changed = false;
    // parallel
    const byPair = new Map<string, E[]>();
    for (const e of edges) byPair.set(pairKey(e), [...(byPair.get(pairKey(e)) ?? []), e]);
    for (const es of byPair.values()) {
      if (es.length < 2) continue;
      const parts = es.map((e) => e.part).sort((a, b) => a.label().localeCompare(b.label(), undefined, { numeric: true }));
      edges = edges.filter((e) => !es.includes(e));
      edges.push({ u: es[0].u, v: es[0].v, part: group("parallel", parts) });
      changed = true;
    }
    if (changed) continue;
    // series: a node other than s or t with exactly two parts on it
    const inc = new Map<string, E[]>();
    for (const e of edges) for (const x of [e.u, e.v]) inc.set(x, [...(inc.get(x) ?? []), e]);
    for (const [node, es] of inc) {
      if (node === s || node === t || es.length !== 2) continue;
      const [e1, e2] = es;
      const far1 = e1.u === node ? e1.v : e1.u;
      const far2 = e2.u === node ? e2.v : e2.u;
      // Keep the chain in order from the + side when we can tell.
      const first = far2 === s ? [e2, e1] : [e1, e2];
      edges = edges.filter((e) => e !== e1 && e !== e2);
      edges.push({ u: far1, v: far2, part: group("series", first.map((e) => e.part)) });
      changed = true;
      break;
    }
  }
  if (edges.length !== 1) return null;
  const e = edges[0];
  if (!((e.u === s && e.v === t) || (e.u === t && e.v === s))) return null;
  return finishTree(e.part);
}

type IssueFn = (level: Issue["level"], message: string, targets?: string[]) => void;

/** Find every resistance and source voltage for a general network; null if it can't. */
function solveNetwork(active: Comp[], out: Analysis, issue: IssueFn): Map<string, number> | null {
  const resolved = new Map<string, number>();
  const key = (c: Comp) => (c.kind === "R" ? "R" : "V");
  // Ohm's law on each part first.
  for (const c of active) {
    const { R, V, I, P } = c.known;
    let x: number | undefined;
    let how = "";
    if (c.kind === "R") {
      if (R !== undefined) x = R;
      else if (V !== undefined && I) { x = V / I; how = "V / I"; }
      else if (P && I) { x = P / (I * I); how = "P / I²"; }
      else if (V !== undefined && P) { x = (V * V) / P; how = "V² / P"; }
    } else {
      if (V !== undefined) x = V;
      else if (P !== undefined && I) { x = P / I; how = "P / I"; }
      else if (R !== undefined && I !== undefined) { x = I * R; how = "I × R"; }
      else if (R !== undefined && P !== undefined) { x = Math.sqrt(P * R); how = "√(P × R)"; }
    }
    if (x !== undefined) {
      resolved.set(c.name, x);
      if (how) out.log.push(`${c.name}: ${key(c)} = ${how} = ${fmt(x)} ${UNITS[key(c)]}`);
    }
  }
  const free = active.filter((c) => !resolved.has(c.name));
  const given: [Comp, Q, number][] = [];
  for (const c of active) for (const q of ["R", "V", "I", "P"] as Q[]) {
    const g = c.known[q];
    // A resistor's R and a source's V are unknowns in the fit, not checks on it.
    if (g !== undefined && !(c.kind === "V" && q === "V") && !(c.kind === "R" && q === "R")) given.push([c, q, g]);
  }

  const groundOf = (els: Element[]) => {
    // Ground the - terminal of the first source in each connected piece.
    const uf = new UnionFind();
    for (const e of els) uf.union(e.nPlus, e.nMinus);
    const g = new Set<string>();
    const seen = new Set<string>();
    for (const c of active) if (c.kind === "V" && !seen.has(uf.find(c.p))) { seen.add(uf.find(c.p)); g.add(c.n); }
    return els.map((e) => ({ ...e, nPlus: g.has(e.nPlus) ? "0" : e.nPlus, nMinus: g.has(e.nMinus) ? "0" : e.nMinus }));
  };
  const simulate = (vals: Map<string, number>) => {
    const els = groundOf(active.map((c) => ({ name: c.name, kind: c.kind, nPlus: c.p, nMinus: c.n, value: vals.get(c.name)! })));
    return solveElements(els);
  };
  const measured = (sol: ReturnType<typeof simulate>, c: Comp, q: Q) => {
    const r = c.kind === "R" ? sol.resistors[c.name] : sol.sources[c.name];
    if (c.kind === "V" && q === "R") return Math.abs(r.V / r.I);
    return Math.abs((r as Record<string, number>)[q]);
  };

  if (free.length) {
    if (given.length < free.length) {
      issue("info", `Not enough information yet. Still unknown: ${free.map((c) => `${c.name} ${key(c)}`).join(", ")}. Add another known value.`, free.map((c) => c.edge));
      return null;
    }
    const residuals = (x: number[]) => {
      const vals = new Map(resolved);
      free.forEach((c, k) => vals.set(c.name, Math.exp(x[k])));
      try {
        const sol = simulate(vals);
        const r = given.map(([c, q, g]) => (measured(sol, c, q) - g) / Math.max(Math.abs(g), 1e-12));
        return r.every(isFinite) ? r : null;
      } catch { return null; }
    };
    const rs = active.filter((c) => c.kind === "R" && resolved.has(c.name)).map((c) => resolved.get(c.name)!);
    const vs = active.filter((c) => c.kind === "V" && resolved.has(c.name)).map((c) => resolved.get(c.name)!);
    const gv = given.filter(([, q]) => q === "V").map(([, , g]) => g);
    const rBase = Math.log(rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 1);
    const vBase = Math.log(Math.max(1, ...vs, ...gv));
    const sols = multiStartLM(residuals, free.map((c) => (c.kind === "R" ? rBase : vBase)), 3, 40);
    if (!sols.length) {
      issue("error", "These values can't all be true at the same time, or they don't pin the circuit down. Check the numbers or add another known value.", free.map((c) => c.edge));
      return null;
    }
    free.forEach((c, k) => resolved.set(c.name, Math.exp(sols[0][k])));
    out.log.push("The remaining unknowns were found by solving the circuit equations together:");
    for (const c of free) out.log.push(`${c.name}: ${key(c)} = ${fmt(resolved.get(c.name)!)} ${UNITS[key(c)]}`);
    if (sols.length > 1) {
      const alt = sols.slice(1).map((x) => free.map((c, k) => `${c.name} = ${fmt(Math.exp(x[k]))} ${UNITS[key(c)]}`).join(", "));
      issue("warning", `More than one answer fits these values. Also possible: ${alt.join("; ")}.`);
    }
    return resolved;
  }

  // Everything is pinned down: check the extra values against the circuit.
  try {
    const sol = simulate(resolved);
    for (const [c, q, g] of given) {
      const m = measured(sol, c, q);
      if (!close(m, g)) issue("error", `Conflict: ${c.name} ${q} is ${fmt(g)} ${UNITS[q]}, but the circuit gives ${fmt(m)} ${UNITS[q]}.`, [c.edge]);
    }
  } catch (e) {
    if (!(e instanceof CircuitError)) throw e;
    issue("error", e.message);
    return null;
  }
  return out.issues.some((i) => i.level === "error") ? null : resolved;
}

/**
 * Current along every wire edge. Each node's wires form a graph; we route the
 * currents that parts push into its grid points along a spanning tree.
 */
function wireCurrents(doc: Doc, current: Map<string, number>) {
  const inject = new Map<string, number>();
  const add = (p: string, x: number) => inject.set(p, (inject.get(p) ?? 0) + x);
  const adj = new Map<string, { to: string; edge: string }[]>();
  for (const [key, item] of Object.entries(doc)) {
    const [a, b] = edgeEnds(key).map(ptKey);
    if (item.kind === "wire") {
      adj.set(a, [...(adj.get(a) ?? []), { to: b, edge: key }]);
      adj.set(b, [...(adj.get(b) ?? []), { to: a, edge: key }]);
      current.set(key, 0);
    } else {
      const c = current.get(key) ?? 0; // flows a -> b through the part
      add(a, -c);
      add(b, c);
    }
  }
  const seen = new Set<string>();
  for (const root of adj.keys()) {
    if (seen.has(root)) continue;
    // BFS tree, then push flow from the leaves up.
    const order: string[] = [];
    const parent = new Map<string, { from: string; edge: string }>();
    seen.add(root);
    const queue = [root];
    while (queue.length) {
      const p = queue.shift()!;
      order.push(p);
      for (const { to, edge } of adj.get(p) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        parent.set(to, { from: p, edge });
        queue.push(to);
      }
    }
    const up = new Map<string, number>(); // flow from point toward its parent
    for (const p of order.reverse()) {
      const par = parent.get(p);
      if (!par) continue;
      const f = (inject.get(p) ?? 0) + (up.get(p) ?? 0);
      up.set(par.from, (up.get(par.from) ?? 0) + f);
      const [a] = edgeEnds(par.edge).map(ptKey);
      current.set(par.edge, a === p ? f : -f);
    }
  }
}

/** SPICE netlist of the drawing for the Python tools (mna.py / cli.py). */
export function toNetlist(doc: Doc, a: Analysis): string {
  const uf = new UnionFind();
  for (const [key, item] of Object.entries(doc)) {
    const [p, q] = edgeEnds(key).map(ptKey);
    uf.find(p); uf.find(q);
    if (item.kind === "wire") uf.union(p, q);
  }
  const names = new Map<string, string>();
  const parts = Object.entries(doc).filter(([, i]) => i.kind !== "wire");
  const firstSrc = parts.find(([, i]) => i.kind === "V");
  if (firstSrc) names.set(uf.find(terminals(firstSrc[0], firstSrc[1])[1]), "0");
  let next = 1;
  const nodeName = (pt: string) => {
    const r = uf.find(pt);
    if (!names.has(r)) names.set(r, String(next++));
    return names.get(r)!;
  };
  const lines = ["* Drawn in DC Circuit Sandbox"];
  const sorted = parts.sort(([, x], [, y]) => (x.kind === y.kind ? x.name!.localeCompare(y.name!, undefined, { numeric: true }) : x.kind === "V" ? -1 : 1));
  for (const [key, item] of sorted) {
    const [p, n] = item.kind === "V" ? terminals(key, item) : edgeEnds(key).map(ptKey);
    const v = a.parts[item.name!]?.values[item.kind === "V" ? "V" : "R"];
    const val = v === null || v === undefined ? "?" : String(parseFloat(v.toPrecision(9)));
    const line = `${item.name} ${nodeName(p)} ${nodeName(n)} ${val}`;
    lines.push(val === "?" ? `* ${line}   (value unknown)` : line);
  }
  return lines.join("\n") + "\n";
}
