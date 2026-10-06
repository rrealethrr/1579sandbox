import { Sketch } from "./draw";
import type { Doc } from "./model";

// Grid coordinates; each example is centered roughly on (0, 0).
export const EXAMPLES: { name: string; build: () => Doc }[] = [
  {
    name: "Series",
    // 24 V across 1 + 2 + 3 Ω (test_mna three resistors)
    build: () => new Sketch()
      .wire([-4, -1], [-4, -3], [4, -3], [4, 3], [-4, 3], [-4, 0])
      .v("V1", -4, -1, -4, 0, { V: "24" })
      .r("R1", -1, -3, 0, -3, { R: "1" }).r("R2", 4, 0, 4, 1, { R: "2" }).r("R3", 0, 3, -1, 3, { R: "3" })
      .doc,
  },
  {
    name: "Parallel",
    // 12 V across 4, 6 and 12 Ω
    build: () => new Sketch()
      .wire([-5, -1], [-5, -3], [5, -3], [5, 3], [-5, 3], [-5, 0])
      .wire([-1, -3], [-1, -1]).wire([-1, 0], [-1, 3])
      .wire([2, -3], [2, -1]).wire([2, 0], [2, 3])
      .wire([5, -3], [5, -1]).wire([5, 0], [5, 3])
      .v("V1", -5, -1, -5, 0, { V: "12" })
      .r("R1", -1, -1, -1, 0, { R: "4" }).r("R2", 2, -1, 2, 0, { R: "6" }).r("R3", 5, -1, 5, 0, { R: "12" })
      .doc,
  },
  {
    name: "Combination",
    // R1 = 4 Ω in series with 6 || 12 Ω from 12 V
    build: () => new Sketch()
      .wire([-5, -1], [-5, -3], [5, -3], [5, -1]).wire([5, 0], [5, 3], [-5, 3], [-5, 0])
      .wire([1, -3], [1, -1]).wire([1, 0], [1, 3])
      .v("V1", -5, -1, -5, 0, { V: "12" })
      .r("R1", -3, -3, -2, -3, { R: "4" }).r("R2", 1, -1, 1, 0, { R: "6" }).r("R3", 5, -1, 5, 0, { R: "12" })
      .doc,
  },
  {
    name: "Bridge",
    // Unbalanced Wheatstone bridge from test_mna
    build: () => new Sketch()
      .wire([-6, -1], [-6, -4], [0, -4], [0, -3]).wire([-6, 0], [-6, 4], [0, 4], [0, 3])
      .wire([0, -3], [-3, -3], [-3, -2]).wire([0, -3], [3, -3], [3, -2])
      .wire([-3, -1], [-3, 1]).wire([3, -1], [3, 1])
      .wire([-3, 2], [-3, 3], [0, 3]).wire([3, 2], [3, 3], [0, 3])
      .wire([-3, 0], [-1, 0]).wire([0, 0], [3, 0])
      .v("V1", -6, -1, -6, 0, { V: "10" })
      .r("R1", -3, -2, -3, -1, { R: "1" }).r("R3", 3, -2, 3, -1, { R: "2" })
      .r("R2", -3, 1, -3, 2, { R: "2" }).r("R4", 3, 1, 3, 2, { R: "1" })
      .r("R5", -1, 0, 0, 0, { R: "1" })
      .doc,
  },
];
