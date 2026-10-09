// Conductor math for wire runs: resistance of a conductor, voltage drop, percent
// voltage drop and circular-mil area. Lengths are in feet (one-way), areas in
// circular mils (cmil), K in ohm·cmil/ft.
//
//   R (one conductor)   = K · L / CM
//   VD                  = M · K · I · L / CM      M = 2 for DC / single-phase, √3 for three-phase
//   %VD                 = VD / Vsource · 100
//   CM (round wire)     = d²  with d in mils (1 mil = 0.001 in)
//
// Leave any one of I, L, CM, VD blank and it is solved from the others.

export type System = "dc" | "three";

export const MULTIPLIER: Record<System, number> = { dc: 2, three: Math.sqrt(3) };

export interface Material { id: string; name: string; k: number; }

/** K values in ohm·cmil/ft. 12.6 is the copper value Dee's coursework uses;
 *  12.9 / 21.2 are the usual NEC-exam values (75 °C); 10.4 / 17.0 are the 20 °C textbook values. */
export const MATERIALS: Material[] = [
  { id: "cu126", name: "Copper (K = 12.6)", k: 12.6 },
  { id: "cu75", name: "Copper (K = 12.9)", k: 12.9 },
  { id: "al75", name: "Aluminum (K = 21.2)", k: 21.2 },
  { id: "cu20", name: "Copper (K = 10.4)", k: 10.4 },
  { id: "al20", name: "Aluminum (K = 17)", k: 17 },
];

export interface WireSize { name: string; cmil: number; }

/** Standard sizes with areas from NEC Chapter 9, Table 8. */
export const WIRE_SIZES: WireSize[] = [
  ["18 AWG", 1620], ["16 AWG", 2580], ["14 AWG", 4110], ["12 AWG", 6530], ["10 AWG", 10380],
  ["8 AWG", 16510], ["6 AWG", 26240], ["4 AWG", 41740], ["3 AWG", 52620], ["2 AWG", 66360],
  ["1 AWG", 83690], ["1/0 AWG", 105600], ["2/0 AWG", 133100], ["3/0 AWG", 167800], ["4/0 AWG", 211600],
  ["250 kcmil", 250000], ["300 kcmil", 300000], ["350 kcmil", 350000], ["400 kcmil", 400000],
  ["500 kcmil", 500000], ["600 kcmil", 600000], ["700 kcmil", 700000], ["750 kcmil", 750000],
  ["800 kcmil", 800000], ["900 kcmil", 900000], ["1000 kcmil", 1000000], ["1250 kcmil", 1250000],
  ["1500 kcmil", 1500000], ["1750 kcmil", 1750000], ["2000 kcmil", 2000000],
].map(([name, cmil]) => ({ name: name as string, cmil: cmil as number }));

/** Area in circular mils of a round conductor of diameter d mils. */
export function cmilFromDiameter(mils: number): number {
  return mils * mils;
}

export function diameterFromCmil(cmil: number): number {
  return Math.sqrt(cmil);
}

/** Smallest standard size whose area is at least `cmil`, or undefined if none is big enough. */
export function nextSizeUp(cmil: number): WireSize | undefined {
  return WIRE_SIZES.find((w) => w.cmil >= cmil * (1 - 1e-9));
}

/** Resistance of one conductor of length L ft. */
export function conductorResistance(k: number, lengthFt: number, cmil: number): number {
  return (k * lengthFt) / cmil;
}

export interface Inputs {
  system: System;
  k: number;
  current?: number;    // A
  length?: number;     // ft, one-way
  cmil?: number;       // circular mils
  vd?: number;         // V
  vdPercent?: number;  // %
  source?: number;     // V
}

export interface Result {
  system: System;
  k: number;
  current: number;
  length: number;
  cmil: number;
  vd: number;
  vdPercent?: number;
  source?: number;
  loadVoltage?: number;
  diameterMils: number;
  rConductor: number;  // one wire, Ω
  rCircuit: number;    // DC/1φ: both wires; 3φ: one phase conductor
  powerLoss: number;   // W lost in the wiring
  solvedFor: (keyof Inputs)[];
  steps: string[];
}

export class ConductorError extends Error {}

const has = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);

export function solve(inp: Inputs): Result {
  const { system, k } = inp;
  const M = MULTIPLIER[system];
  const mName = system === "dc" ? "2" : "√3";
  let { current: I, length: L, cmil: CM, vd: VD, vdPercent: P, source: Vs } = inp;
  const solvedFor: (keyof Inputs)[] = [];
  const steps: string[] = [];

  if (!(k > 0)) throw new ConductorError("K must be greater than 0");
  for (const [name, v] of [["Current", I], ["Length", L], ["Area", CM], ["Voltage drop", VD], ["Percent drop", P], ["Source voltage", Vs]] as const) {
    if (has(v) && v < 0) throw new ConductorError(`${name} can't be negative`);
  }
  if (has(CM) && CM === 0) throw new ConductorError("Area can't be 0");

  // Percent ↔ volts first, so the main equation has as much to work with as possible.
  if (!has(VD) && has(P) && has(Vs)) {
    VD = (P / 100) * Vs;
    solvedFor.push("vd");
    steps.push(`VD = %VD × Vs = ${f(P)}% × ${f(Vs)} V = ${f(VD)} V`);
  }

  const missing = ([["current", I], ["length", L], ["cmil", CM], ["vd", VD]] as const).filter(([, v]) => !has(v)).map(([n]) => n);
  if (missing.length > 1) {
    throw new ConductorError(`Need one more value: ${missing.map(label).join(" or ")} (or %VD with source voltage)`);
  }
  const lead = `${mName} × ${f(k)}`;
  if (missing[0] === "vd") {
    VD = (M * k * I! * L!) / CM!;
    steps.push(`VD = ${mName}·K·I·L / CM = ${lead} × ${f(I!)} A × ${f(L!)} ft / ${f(CM!)} cmil = ${f(VD)} V`);
  } else if (missing[0] === "cmil") {
    if (!(VD! > 0)) throw new ConductorError("Voltage drop must be greater than 0 to size a wire");
    CM = (M * k * I! * L!) / VD!;
    steps.push(`CM = ${mName}·K·I·L / VD = ${lead} × ${f(I!)} A × ${f(L!)} ft / ${f(VD!)} V = ${f(CM)} cmil`);
  } else if (missing[0] === "current") {
    if (!(L! > 0)) throw new ConductorError("Length must be greater than 0 to find current");
    I = (VD! * CM!) / (M * k * L!);
    steps.push(`I = VD·CM / (${mName}·K·L) = ${f(VD!)} V × ${f(CM!)} cmil / (${lead} × ${f(L!)} ft) = ${f(I)} A`);
  } else if (missing[0] === "length") {
    if (!(I! > 0)) throw new ConductorError("Current must be greater than 0 to find length");
    L = (VD! * CM!) / (M * k * I!);
    steps.push(`L = VD·CM / (${mName}·K·I) = ${f(VD!)} V × ${f(CM!)} cmil / (${lead} × ${f(I!)} A) = ${f(L)} ft`);
  } else if (!has(P) || !has(Vs)) {
    // All four given: check they agree.
    const expect = (M * k * I! * L!) / CM!;
    if (Math.abs(expect - VD!) > 1e-6 * Math.max(1, expect)) {
      throw new ConductorError(`These values disagree: with that current, length and area the drop is ${f(expect)} V, not ${f(VD!)} V. Clear one to solve for it.`);
    }
  }
  if (missing.length) solvedFor.push(missing[0]);

  if (!has(P) && has(Vs) && Vs > 0) {
    P = (VD! / Vs) * 100;
    solvedFor.push("vdPercent");
    steps.push(`%VD = VD / Vs × 100 = ${f(VD!)} V / ${f(Vs)} V × 100 = ${f(P)}%`);
  } else if (!has(Vs) && has(P) && P > 0) {
    Vs = (VD! / P) * 100;
    solvedFor.push("source");
    steps.push(`Vs = VD / %VD × 100 = ${f(VD!)} V / ${f(P)}% × 100 = ${f(Vs)} V`);
  } else if (has(P) && has(Vs) && !solvedFor.includes("vd")) {
    const expect = Vs > 0 ? (VD! / Vs) * 100 : NaN;
    if (Math.abs(expect - P) > 1e-6 * Math.max(1, P)) {
      throw new ConductorError(`These values disagree: ${f(VD!)} V out of ${f(Vs)} V is ${f(expect)}%, not ${f(P)}%. Clear one to solve for it.`);
    }
  }

  const rConductor = conductorResistance(k, L!, CM!);
  steps.push(`R (one conductor) = K·L / CM = ${f(k)} × ${f(L!)} ft / ${f(CM!)} cmil = ${f(rConductor)} Ω`);
  let rCircuit: number, powerLoss: number;
  if (system === "dc") {
    rCircuit = 2 * rConductor;
    powerLoss = I! * I! * rCircuit;
    steps.push(`R (both conductors) = 2 × ${f(rConductor)} Ω = ${f(rCircuit)} Ω`);
    steps.push(`Power lost in the wire = I²·R = ${f(I!)}² × ${f(rCircuit)} Ω = ${f(powerLoss)} W`);
  } else {
    rCircuit = rConductor;
    powerLoss = 3 * I! * I! * rConductor;
    steps.push(`Power lost in the wire = 3·I²·R = 3 × ${f(I!)}² × ${f(rConductor)} Ω = ${f(powerLoss)} W`);
  }

  return {
    system, k, current: I!, length: L!, cmil: CM!, vd: VD!,
    vdPercent: P, source: Vs, loadVoltage: has(Vs) ? Vs - VD! : undefined,
    diameterMils: diameterFromCmil(CM!), rConductor, rCircuit, powerLoss, solvedFor, steps,
  };
}

function label(n: string): string {
  return ({ current: "current", length: "length", cmil: "wire size", vd: "voltage drop" } as Record<string, string>)[n];
}

/** Plain number, 4 significant figures, no prefixes. */
export function f(x: number): string {
  if (!Number.isFinite(x)) return "∞";
  return String(Number(x.toPrecision(4)));
}
