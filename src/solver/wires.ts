// Real-wire mode: every run of wire between junctions and parts becomes a
// conductor with resistance R = K·L/CM, the circuit is re-solved with those
// resistances in it, and each run is checked against the NEC.
//
// The ideal solve (perfect wires) decides each resistor's R and each source's V
// from what the user typed; this pass keeps those and adds the wiring, so it
// shows what the loads really get at the end of the drawn runs.

import { edgeEnds, ptKey, terminals, type Doc, type WireSpec } from "../model";
import type { Analysis } from "./circuit";
import { WIRE_SIZES, conductorResistance } from "./conductor";
import { CircuitError, solveElements, type Element } from "./mna";
import { ampacity, checkDrop, checkRun, worst, type Check, type Metal, type Verdict } from "./nec";

export interface WireSettings {
  on: boolean;
  /** Feet of conductor per grid square. */
  ftPerSquare: number;
  metal: Metal;
  /** Default size for runs without their own: "auto" or a standard size name. */
  size: string;
  /** K in ohm·cmil/ft for each metal. */
  k: Record<Metal, number>;
}

export const DEFAULT_WIRE_SETTINGS: WireSettings = {
  on: false, ftPerSquare: 10, metal: "cu", size: "auto", k: { cu: 12.6, al: 21.2 },
};

export const METAL_NAME: Record<Metal, string> = { cu: "Copper", al: "Aluminum" };

export interface Run {
  name: string;
  edges: string[];
  /** Grid points at the two ends. */
  ends: [string, string];
  drawnFt: number;
  lengthFt: number;
  spec: WireSpec;
  metal: Metal;
  k: number;
  auto: boolean;
  size: string;
  cmil: number;
  R: number;
  I: number;
  vd: number;
  vdPercent: number;
  loss: number;
  checks: Check[];
  verdict: Verdict;
}

export interface LoadResult {
  name: string;
  edge: string;
  vIdeal: number;
  v: number;
  i: number;
  p: number;
  dropPercent: number;
  check: Check;
}

export interface WireAnalysis {
  runs: Run[];
  loads: LoadResult[];
  sourceV: number;
  totalLoss: number;
  worstDrop: number;
  verdict: Verdict;
  runOfEdge: Map<string, Run>;
  /** Set when the circuit couldn't be solved with real wires. */
  problem?: string;
}

/** Sizes auto-sizing may pick for a metal: listed in 310.16 and at least the 310.3 minimum. */
export function sizesFor(metal: Metal) {
  const min = metal === "cu" ? "14 AWG" : "12 AWG";
  const from = WIRE_SIZES.findIndex((w) => w.name === min);
  return WIRE_SIZES.slice(from).filter((w) => ampacity(metal, w.name) !== undefined);
}

/** Chains of wire edges between junctions, part terminals and open ends. */
export function findRuns(doc: Doc): { edges: string[]; ends: [string, string] }[] {
  const adj = new Map<string, { to: string; edge: string }[]>();
  const touchesPart = new Set<string>();
  for (const [key, item] of Object.entries(doc)) {
    const [a, b] = edgeEnds(key).map(ptKey);
    if (item.kind !== "wire") { touchesPart.add(a); touchesPart.add(b); continue; }
    adj.set(a, [...(adj.get(a) ?? []), { to: b, edge: key }]);
    adj.set(b, [...(adj.get(b) ?? []), { to: a, edge: key }]);
  }
  const isEnd = (p: string) => touchesPart.has(p) || adj.get(p)!.length !== 2;
  const used = new Set<string>();
  const runs: { edges: string[]; ends: [string, string] }[] = [];
  const walk = (start: string, first: { to: string; edge: string }) => {
    const edges = [first.edge];
    used.add(first.edge);
    let at = first.to;
    while (!isEnd(at) && at !== start) {
      const next = adj.get(at)!.find((n) => !used.has(n.edge));
      if (!next) break;
      edges.push(next.edge);
      used.add(next.edge);
      at = next.to;
    }
    runs.push({ edges, ends: [start, at] });
  };
  // Sorted so run names stay put as the drawing changes elsewhere.
  const pts = [...adj.keys()].sort(byPosition);
  for (const p of pts) if (isEnd(p)) for (const n of adj.get(p)!) if (!used.has(n.edge)) walk(p, n);
  // Loops made only of wire.
  for (const p of pts) for (const n of adj.get(p)!) if (!used.has(n.edge)) walk(p, n);
  return runs;
}

function byPosition(a: string, b: string) {
  const [ax, ay] = a.split(",").map(Number), [bx, by] = b.split(",").map(Number);
  return ay - by || ax - bx;
}

function specOf(doc: Doc, edges: string[]): WireSpec {
  const spec: WireSpec = {};
  for (const e of edges) {
    const w = doc[e]?.wire;
    if (!w) continue;
    if (spec.lengthFt === undefined && w.lengthFt !== undefined) spec.lengthFt = w.lengthFt;
    if (spec.size === undefined && w.size !== undefined) spec.size = w.size;
    if (spec.metal === undefined && w.metal !== undefined) spec.metal = w.metal;
  }
  return spec;
}

export function analyzeWires(doc: Doc, analysis: Analysis, settings: WireSettings): WireAnalysis | null {
  const raw = findRuns(doc);
  const runs: Run[] = raw.map((r, i) => {
    const spec = specOf(doc, r.edges);
    const metal = spec.metal ?? settings.metal;
    const sizeSetting = spec.size ?? settings.size;
    const auto = sizeSetting === "auto" || !WIRE_SIZES.some((w) => w.name === sizeSetting);
    const size = auto ? sizesFor(metal)[0].name : sizeSetting;
    const drawnFt = r.edges.length * settings.ftPerSquare;
    return {
      name: `W${i + 1}`, edges: r.edges, ends: r.ends, drawnFt, lengthFt: spec.lengthFt ?? drawnFt, spec,
      metal, k: settings.k[metal], auto, size, cmil: 0, R: 0, I: 0, vd: 0, vdPercent: 0, loss: 0, checks: [], verdict: "pass",
    };
  });
  const runOfEdge = new Map<string, Run>();
  for (const r of runs) for (const e of r.edges) runOfEdge.set(e, r);
  const result: WireAnalysis = { runs, loads: [], sourceV: 0, totalLoss: 0, worstDrop: 0, verdict: "pass", runOfEdge };
  if (!analysis.solved || analysis.issues.some((i) => i.level === "error")) return result;

  // ---- elements: parts that carry current, plus every run
  type El = Element & { a: string; b: string };
  const parts: El[] = [];
  for (const [key, item] of Object.entries(doc)) {
    if (item.kind === "wire") continue;
    const pr = analysis.parts[item.name!];
    if (!pr || pr.state !== "ok") continue;
    const value = item.kind === "R" ? pr.values.R : pr.values.V;
    if (value === null || !isFinite(value)) return result;
    const [a, b] = item.kind === "V" ? terminals(key, item) : edgeEnds(key).map(ptKey);
    parts.push({ name: item.name!, kind: item.kind, nPlus: a, nMinus: b, value, a, b });
  }
  const sources = parts.filter((p) => p.kind === "V");
  if (!sources.length) return result;
  result.sourceV = Math.max(...sources.map((s) => Math.abs(s.value)));

  // Only what's connected to a source.
  const parent = new Map<string, string>();
  const find = (x: string): string => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const p of parts) union(p.a, p.b);
  for (const r of runs) union(r.ends[0], r.ends[1]);
  const live = new Set(sources.map((s) => find(s.a)));
  const ground = new Map<string, string>();
  for (const s of sources) if (!ground.has(find(s.a))) ground.set(find(s.a), s.b);
  const grounds = new Set(ground.values());
  const node = (p: string) => (grounds.has(p) ? "0" : p);
  const liveParts = parts.filter((p) => live.has(find(p.a)));
  const liveRuns = runs.filter((r) => live.has(find(r.ends[0])) && r.ends[0] !== r.ends[1]);

  const solve = () => {
    for (const r of runs) {
      r.cmil = WIRE_SIZES.find((w) => w.name === r.size)!.cmil;
      r.R = conductorResistance(r.k, r.lengthFt, r.cmil);
    }
    const els: Element[] = [
      ...liveParts.map((p) => ({ name: p.name, kind: p.kind, nPlus: node(p.nPlus), nMinus: node(p.nMinus), value: p.value })),
      ...liveRuns.map((r) => ({ name: `~${r.name}`, kind: "R" as const, nPlus: node(r.ends[0]), nMinus: node(r.ends[1]), value: r.R })),
    ];
    const sol = solveElements(els);
    for (const r of runs) {
      const q = sol.resistors[`~${r.name}`];
      r.I = q ? Math.abs(q.I) : 0;
      r.vd = r.I * r.R;
      r.vdPercent = result.sourceV > 0 ? (r.vd / result.sourceV) * 100 : 0;
      r.loss = r.I * r.I * r.R;
      r.checks = checkRun({ metal: r.metal, size: r.size, current: r.I });
      r.verdict = worst(r.checks);
    }
    result.loads = liveParts.filter((p) => p.kind === "R").map((p) => {
      const q = sol.resistors[p.name];
      const vIdeal = analysis.parts[p.name].values.V ?? 0;
      const v = Math.abs(q.V);
      const dropPercent = vIdeal > 0 ? ((vIdeal - v) / vIdeal) * 100 : 0;
      return { name: p.name, edge: analysis.parts[p.name].edge, vIdeal, v, i: Math.abs(q.I), p: q.P, dropPercent, check: checkDrop(dropPercent) };
    });
  };

  try {
    solve();
    // Auto sizing: step up any auto run that fails a size check. Then, while a
    // load gets more than 3% drop, step up the smallest current-carrying auto
    // runs together, so a circuit's conductors stay one size where they can.
    for (let round = 0; round < 400; round++) {
      let bumped = false;
      for (const r of runs.filter((r) => r.auto && r.verdict !== "pass")) bumped = step(r) || bumped;
      if (!bumped && result.loads.some((l) => l.check.verdict !== "pass")) {
        const carrying = runs.filter((r) => r.auto && r.I > 0 && !isLargest(r));
        const smallest = Math.min(...carrying.map((r) => r.cmil));
        for (const r of carrying.filter((r) => r.cmil === smallest)) bumped = step(r) || bumped;
      }
      if (!bumped) break;
      solve();
    }
  } catch (e) {
    if (!(e instanceof CircuitError)) throw e;
    result.problem = e.message;
    return result;
  }

  result.totalLoss = runs.reduce((s, r) => s + r.loss, 0);
  result.worstDrop = Math.max(0, ...result.loads.map((l) => l.dropPercent));
  const all: Verdict[] = [...runs.filter((r) => r.I > 0).map((r) => r.verdict), ...result.loads.map((l) => l.check.verdict)];
  result.verdict = all.includes("fail") ? "fail" : all.includes("warn") ? "warn" : "pass";
  return result;

  function isLargest(r: Run) {
    const list = sizesFor(r.metal);
    return list[list.length - 1].name === r.size;
  }
  function step(r: Run): boolean {
    const list = sizesFor(r.metal);
    const i = list.findIndex((w) => w.name === r.size);
    if (i < 0 || i >= list.length - 1) return false;
    r.size = list[i + 1].name;
    return true;
  }
}
