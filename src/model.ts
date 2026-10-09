// The drawing: every wire, resistor and source sits on one grid edge between two
// neighbouring grid points. Wires that meet at a grid point are joined.

export type Q = "R" | "V" | "I" | "P";
export type ItemKind = "wire" | "R" | "V";

export interface Pt { x: number; y: number }

export interface Item {
  kind: ItemKind;
  /** Resistor or source name, e.g. R1, V1. */
  name?: string;
  /** What the user typed for each known value, e.g. { R: "4.7k" }. */
  known?: Partial<Record<Q, string>>;
  /** Sources only: + terminal at the b end instead of the a end. */
  flip?: boolean;
  /** Wires only, real-wire mode: overrides for the run this edge belongs to. */
  wire?: WireSpec;
}

export interface WireSpec {
  /** Length to use instead of the drawn length, in feet. */
  lengthFt?: number;
  /** Standard size name like "12 AWG", or "auto". */
  size?: string;
  metal?: "cu" | "al";
}

/** Edge key -> item. */
export type Doc = Record<string, Item>;

export const ptKey = (p: Pt) => `${p.x},${p.y}`;

/** Key of the unit edge between two neighbouring points; a is the left or top end. */
export function edgeKey(p: Pt, q: Pt): string {
  const [a, b] = p.x < q.x || (p.x === q.x && p.y < q.y) ? [p, q] : [q, p];
  return `${a.x},${a.y},${b.x},${b.y}`;
}

export function edgeEnds(key: string): [Pt, Pt] {
  const [x1, y1, x2, y2] = key.split(",").map(Number);
  return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
}

export function isVertical(key: string): boolean {
  const [a, b] = edgeEnds(key);
  return a.x === b.x;
}

/** Point keys of the + and - terminals of a source on this edge. */
export function terminals(key: string, item: Item): [string, string] {
  const [a, b] = edgeEnds(key);
  return item.flip ? [ptKey(b), ptKey(a)] : [ptKey(a), ptKey(b)];
}

export function nextName(doc: Doc, prefix: "R" | "V"): string {
  const used = new Set(Object.values(doc).map((i) => i.name));
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}
