// NEC checks for one conductor run. Tables are copper/aluminum, 75 °C column of
// Table 310.16 (not more than three current-carrying conductors, 30 °C ambient).
// 18 and 16 AWG are not in 310.16; their ratings here are from Table 400.5(A)(1)
// and only apply to cords and fixture wire, so they fail the 310.3 minimum anyway.

export type Metal = "cu" | "al";

const AMPACITY_75: Record<Metal, Record<string, number>> = {
  cu: {
    "18 AWG": 7, "16 AWG": 10, "14 AWG": 20, "12 AWG": 25, "10 AWG": 35, "8 AWG": 50, "6 AWG": 65,
    "4 AWG": 85, "3 AWG": 100, "2 AWG": 115, "1 AWG": 130, "1/0 AWG": 150, "2/0 AWG": 175,
    "3/0 AWG": 200, "4/0 AWG": 230, "250 kcmil": 255, "300 kcmil": 285, "350 kcmil": 310,
    "400 kcmil": 335, "500 kcmil": 380, "600 kcmil": 420, "700 kcmil": 460, "750 kcmil": 475,
    "800 kcmil": 490, "900 kcmil": 520, "1000 kcmil": 545, "1250 kcmil": 590, "1500 kcmil": 625,
    "1750 kcmil": 650, "2000 kcmil": 665,
  },
  al: {
    "12 AWG": 20, "10 AWG": 30, "8 AWG": 40, "6 AWG": 50, "4 AWG": 65, "3 AWG": 75, "2 AWG": 90,
    "1 AWG": 100, "1/0 AWG": 120, "2/0 AWG": 135, "3/0 AWG": 155, "4/0 AWG": 180, "250 kcmil": 205,
    "300 kcmil": 230, "350 kcmil": 250, "400 kcmil": 270, "500 kcmil": 310, "600 kcmil": 340,
    "700 kcmil": 375, "750 kcmil": 385, "800 kcmil": 395, "900 kcmil": 425, "1000 kcmil": 445,
    "1250 kcmil": 485, "1500 kcmil": 520, "1750 kcmil": 545, "2000 kcmil": 560,
  },
};

/** 240.4(D): largest overcurrent device allowed on small conductors. */
const SMALL_CONDUCTOR: Record<Metal, Record<string, number>> = {
  cu: { "18 AWG": 7, "16 AWG": 10, "14 AWG": 15, "12 AWG": 20, "10 AWG": 30 },
  al: { "12 AWG": 15, "10 AWG": 25 },
};

/** 310.3(A): smallest conductor for general wiring. */
const MINIMUM: Record<Metal, string> = { cu: "14 AWG", al: "12 AWG" };
const ORDER = ["18 AWG", "16 AWG", "14 AWG", "12 AWG", "10 AWG"];

/** Informational notes to 210.19(A) and 215.2(A): 3% for a branch circuit or feeder, 5% for both together. */
export const VD_CIRCUIT_LIMIT = 3;
export const VD_TOTAL_LIMIT = 5;

export function ampacity(metal: Metal, size: string): number | undefined {
  return AMPACITY_75[metal][size];
}

export type Verdict = "pass" | "warn" | "fail";

export interface Check { rule: string; title: string; verdict: Verdict; detail: string; }

export interface RunFacts {
  metal: Metal;
  /** Standard size name like "12 AWG"; undefined for a custom area. */
  size?: string;
  current: number; // A
}

const r1 = (x: number) => String(Number(x.toPrecision(3)));

/** Voltage drop from the source to a load, as a % of what it would get with perfect wire. */
export function checkDrop(percent: number): Check {
  return {
    rule: "210.19(A) / 215.2(A) IN", title: "Voltage drop",
    verdict: percent <= VD_CIRCUIT_LIMIT ? "pass" : percent <= VD_TOTAL_LIMIT ? "warn" : "fail",
    detail: percent <= VD_CIRCUIT_LIMIT ? `${r1(percent)}%, within the recommended ${VD_CIRCUIT_LIMIT}%`
      : percent <= VD_TOTAL_LIMIT ? `${r1(percent)}%, over ${VD_CIRCUIT_LIMIT}% for one circuit but within ${VD_TOTAL_LIMIT}% overall`
      : `${r1(percent)}%, over the recommended ${VD_TOTAL_LIMIT}% total`,
  };
}

/** Size checks for one run: minimum size, ampacity and the small-conductor limit. */
export function checkRun(f: RunFacts): Check[] {
  const out: Check[] = [];
  const metalName = f.metal === "cu" ? "copper" : "aluminum";

  if (!f.size) {
    out.push({ rule: "310.16", title: "Ampacity", verdict: "warn", detail: "Custom area: pick a standard size to check ampacity" });
    return out;
  }
  // Minimum size
  const min = MINIMUM[f.metal];
  const small = ORDER.indexOf(f.size), minIdx = ORDER.indexOf(min);
  out.push({
    rule: "310.3(A)", title: "Minimum size",
    verdict: small >= 0 && small < minIdx ? "fail" : "pass",
    detail: small >= 0 && small < minIdx ? `${f.size} ${metalName} is smaller than the ${min} minimum` : `${min} ${metalName} or larger`,
  });

  // Ampacity
  const amp = ampacity(f.metal, f.size);
  if (amp === undefined) {
    out.push({ rule: "310.16", title: "Ampacity", verdict: "fail", detail: `${f.size} isn't listed for ${metalName}` });
  } else {
    out.push({
      rule: "310.16", title: "Ampacity",
      verdict: f.current <= amp ? "pass" : "fail",
      detail: `${r1(f.current)} A on a wire rated ${amp} A (75 °C)`,
    });
  }

  // Small-conductor overcurrent limit
  const cap = SMALL_CONDUCTOR[f.metal][f.size];
  if (cap !== undefined) {
    out.push({
      rule: "240.4(D)", title: "Small conductor limit",
      verdict: f.current <= cap ? "pass" : "fail",
      detail: `${f.size} ${metalName} is limited to ${cap} A; this run carries ${r1(f.current)} A`,
    });
  }
  return out;
}

export function worst(checks: Check[]): Verdict {
  return checks.some((c) => c.verdict === "fail") ? "fail" : checks.some((c) => c.verdict === "warn") ? "warn" : "pass";
}
