// Number parsing and formatting with engineering prefixes, matching netlist.py:
// 4.7k = 4700, 10mA = 0.01, 1meg = 1e6, 220Ω = 220. A bare "M" is rejected as
// ambiguous (SPICE reads it as milli), so write "meg" for mega.

const PREFIXES: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6,
  m: 1e-3, k: 1e3, K: 1e3, meg: 1e6, MEG: 1e6, Meg: 1e6, G: 1e9,
};
const UNITS = ["ohms", "ohm", "Ω", "V", "v", "A", "a", "W", "w", "R"];
const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/;

export class ValueError extends Error {}

export function parseValue(text: string): number {
  const m = NUMBER.exec(text.trim());
  if (!m) throw new ValueError(`'${text}' is not a number`);
  const num = parseFloat(m[1]);
  const rest = m[2].trim();
  const candidates = [rest, ...UNITS.filter((u) => rest.endsWith(u)).map((u) => rest.slice(0, -u.length).trim())];
  for (const prefix of candidates) {
    if (prefix === "") return num;
    if (prefix in PREFIXES) return num * PREFIXES[prefix];
    if (prefix === "M") throw new ValueError(`'${text}' is ambiguous: write 'meg' for mega or 'm' for milli`);
  }
  throw new ValueError(`'${text}' has an unknown suffix '${rest}'`);
}

const STEPS: [number, string][] = [
  [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
];

/** 4700 -> "4.7 k", 0.0015 -> "1.5 m" (append the unit yourself). */
export function formatSI(x: number, digits = 4): string {
  if (!isFinite(x)) return "∞ ";
  if (x === 0) return "0 ";
  const a = Math.abs(x);
  for (const [scale, sym] of STEPS) {
    if (a >= scale * 0.9999995) return `${trim((x / scale).toPrecision(digits))} ${sym}`;
  }
  return `${trim(x.toPrecision(digits))} `;
}

/** Plain base units, no prefixes: 0.04259 -> "0.04259 A", 1727 -> "1727 W". */
export function formatQty(x: number, unit: string, digits = 4): string {
  if (!isFinite(x)) return `∞ ${unit}`;
  return `${Number(x.toPrecision(digits))} ${unit}`;
}

/** Text to put back into an input box, e.g. 4700 -> "4.7k". */
export function formatInput(x: number): string {
  return formatSI(x, 6).replace(" ", "").replace("M", "meg");
}

function trim(s: string): string {
  if (s.includes("e")) return s;
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
