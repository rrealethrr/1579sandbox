// Helpers to build drawings in code: used by the example circuits and the tests.
import { edgeKey, type Doc, type Item, type Pt } from "./model";

export class Sketch {
  doc: Doc = {};

  /** Wire along a path of grid points (straight runs between corners). */
  wire(...pts: [number, number][]): this {
    for (let i = 1; i < pts.length; i++) {
      for (const [p, q] of unitSteps(pts[i - 1], pts[i])) this.doc[edgeKey(p, q)] = { kind: "wire" };
    }
    return this;
  }

  /** Resistor on the unit edge from (x1, y1) to (x2, y2). */
  r(name: string, x1: number, y1: number, x2: number, y2: number, known: Item["known"] = {}): this {
    this.doc[edgeKey({ x: x1, y: y1 }, { x: x2, y: y2 })] = { kind: "R", name, known };
    return this;
  }

  /** Source with its + terminal at (x1, y1). */
  v(name: string, x1: number, y1: number, x2: number, y2: number, known: Item["known"] = {}): this {
    const flip = x1 > x2 || y1 > y2;
    this.doc[edgeKey({ x: x1, y: y1 }, { x: x2, y: y2 })] = { kind: "V", name, known, flip };
    return this;
  }
}

function* unitSteps(a: [number, number], b: [number, number]): Generator<[Pt, Pt]> {
  let [x, y] = a;
  const [tx, ty] = b;
  if (x !== tx && y !== ty) throw new Error("wire runs must be straight");
  while (x !== tx || y !== ty) {
    const nx = x + Math.sign(tx - x), ny = y + Math.sign(ty - y);
    yield [{ x, y }, { x: nx, y: ny }];
    x = nx; y = ny;
  }
}
