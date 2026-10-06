import "./style.css";
import { EXAMPLES } from "./examples";
import { edgeEnds, edgeKey, isVertical, nextName, type Doc, type Item, type Pt, type Q } from "./model";
import { analyze, SHAPE_LABEL, toNetlist, type Analysis, type Numbers } from "./solver/circuit";
import { formatQty, parseValue } from "./solver/units";

const G = 40; // pixels per grid step
const STORE_KEY = "dc-sandbox-doc-v1";
const UNIT: Record<Q, string> = { R: "Ω", V: "V", I: "A", P: "W" };
const QNAME: Record<Q, string> = { R: "Resistance", V: "Voltage", I: "Current", P: "Power" };

type Tool = "select" | "wire" | "R" | "V" | "erase";

const TOOLS: { id: Tool; key: string; label: string; color: string; icon: string; hint: string }[] = [
  { id: "select", key: "V", label: "Select and move", color: "var(--calc)", icon: '<path d="M5 3l14 8-6 1.5L10 19z"/>', hint: "Click a part to edit its values. Drag a part to slide it along the wire. Drag empty space to pan." },
  { id: "wire", key: "W", label: "Wire brush", color: "var(--wire)", icon: '<path d="M4 18V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10"/><circle cx="4" cy="18" r="1.6"/><circle cx="20" cy="18" r="1.6"/>', hint: "Drag along the grid to paint wires. Close the loop to make a circuit; wires that meet join." },
  { id: "R", key: "R", label: "Resistor brush", color: "var(--res)", icon: '<path d="M2 12h4l2-5 3 10 3-10 3 10 2-5h3"/>', hint: "Click any wire segment to drop a resistor there." },
  { id: "V", key: "B", label: "Source brush", color: "var(--src)", icon: '<path d="M2 12h7M15 12h7M9 5v14M15 8v8"/>', hint: "Click a wire segment to place a DC source. Press F to flip its polarity." },
  { id: "erase", key: "E", label: "Eraser", color: "var(--bad)", icon: '<path d="M8 20h12M5.5 14.5l8-8 5 5-6 6H9z"/>', hint: "Click or drag over wires and parts to erase them." },
];

// ---------------------------------------------------------------- state
const isPhone = () => window.matchMedia("(max-width: 860px)").matches;
const isPortrait = () => isPhone() && window.innerHeight > window.innerWidth;
let doc: Doc = loadDoc() ?? orient(EXAMPLES[2].build());
/** Last pointer type, so touch gets bigger hit areas and no surprise keyboard. */
let pointerType = "mouse";
let tool: Tool = "select";
let selected: string | null = null;
let showFlow = true;
const MILLI_KEY = "dc-sandbox-milli";
/** Show currents in mA and powers in mW. Display only: typed values are still read in A and W. */
let milli = (() => { try { return localStorage.getItem(MILLI_KEY) === "1"; } catch { return false; } })();

function show(v: number, unit: string): string {
  if (milli && (unit === "A" || unit === "W")) return formatQty(v * 1000, "m" + unit, 4);
  return formatQty(v, unit, 4);
}
let view = { tx: 0, ty: 0, k: 1 };
let analysis: Analysis = analyze({}, {});
let inputErrors: Record<string, Partial<Record<Q, string>>> = {};
const undoStack: string[] = [];
const redoStack: string[] = [];

const $ = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as unknown as T;
const board = $<SVGSVGElement>("#board");
const world = $<SVGGElement>("#world");
const layers = {
  issues: $<SVGGElement>("#layer-issues"),
  parts: $<SVGGElement>("#layer-parts"),
  flow: $<SVGGElement>("#layer-flow"),
  labels: $<SVGGElement>("#layer-labels"),
  overlay: $<SVGGElement>("#layer-overlay"),
};
const gridRect = $<SVGRectElement>("#grid");
const pattern = $<SVGPatternElement>("#dots");
const resultsEl = $("#results");
const editorEl = $("#editor");
const hintEl = $("#hint");

/** Examples are drawn landscape; on a portrait phone, flip them on the diagonal to fit tall. */
function orient(d: Doc): Doc {
  if (!isPortrait()) return d;
  const out: Doc = {};
  for (const [key, item] of Object.entries(d)) {
    const [a, b] = edgeEnds(key);
    // Swapping x and y keeps each edge's a end first, so source polarity is unchanged.
    out[edgeKey({ x: a.y, y: a.x }, { x: b.y, y: b.x })] = item;
  }
  return out;
}

function loadDoc(): Doc | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && typeof d === "object" && Object.keys(d).length ? (d as Doc) : null;
  } catch { return null; }
}
function saveDoc() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(doc)); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- history
function snapshot(): string { return JSON.stringify(doc); }
function pushHistory(snap = snapshot()) {
  if (undoStack[undoStack.length - 1] === snap) return;
  undoStack.push(snap);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
function undo() {
  const prev = undoStack.pop();
  if (prev === undefined) return;
  redoStack.push(snapshot());
  doc = JSON.parse(prev);
  if (selected && !doc[selected]) selected = null;
  changed();
}
function redo() {
  const next = redoStack.pop();
  if (next === undefined) return;
  undoStack.push(snapshot());
  doc = JSON.parse(next);
  if (selected && !doc[selected]) selected = null;
  changed();
}

// ---------------------------------------------------------------- solve + render
function knownNumbers(): Record<string, Numbers> {
  inputErrors = {};
  const out: Record<string, Numbers> = {};
  for (const item of Object.values(doc)) {
    if (!item.name) continue;
    const k: Numbers = {};
    for (const [q, text] of Object.entries(item.known ?? {}) as [Q, string][]) {
      if (!text || !text.trim()) continue;
      try {
        const v = parseValue(text);
        if (!isFinite(v) || v < 0 || (q === "R" && v === 0)) throw new Error(q === "R" ? "Must be more than 0 Ω" : "Must be a positive number");
        k[q] = v;
      } catch (e) {
        (inputErrors[item.name] ??= {})[q] = (e as Error).message;
      }
    }
    out[item.name] = k;
  }
  return out;
}

function changed(persist = true) {
  analysis = analyze(doc, knownNumbers());
  if (persist) saveDoc();
  renderBoard();
  renderResults();
  renderEditor();
  updateButtons();
}

function applyView() {
  world.setAttribute("transform", `translate(${view.tx} ${view.ty}) scale(${view.k})`);
  pattern.setAttribute("patternTransform", `translate(${view.tx} ${view.ty}) scale(${view.k})`);
  gridRect.setAttribute("width", "100%");
  positionEditor();
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Transform that maps a horizontal unit edge drawn from (0,0) to (G,0) onto this edge. */
function edgeTransform(key: string): string {
  const [a] = edgeEnds(key);
  return `translate(${a.x * G} ${a.y * G})${isVertical(key) ? " rotate(90)" : ""}`;
}

function partSvg(key: string, item: Item, extraClass = ""): string {
  if (item.kind === "wire") {
    const [a, b] = edgeEnds(key);
    return `<line class="wire ${extraClass}" data-edge="${key}" x1="${a.x * G}" y1="${a.y * G}" x2="${b.x * G}" y2="${b.y * G}"/>`;
  }
  const sel = key === selected ? " selected" : "";
  const st = analysis.parts[item.name ?? ""]?.state;
  const dim = st && st !== "ok" ? " dim" : "";
  let body: string;
  if (item.kind === "R") {
    body = `<path class="part-body" d="M0 0H7L10 -7L15 7L20 -7L25 7L30 -7L33 0H40"/>`;
  } else {
    // + plate (long, thin) at x=16, - plate (short, thick) at x=24; mirrored when flipped
    const flip = item.flip ? ` transform="translate(${G} 0) scale(-1 1)"` : "";
    const vert = isVertical(key);
    body = `<g${flip}><path class="part-body" d="M0 0H16M24 0H40"/>` +
      `<path class="part-body plate-plus" d="M16 -12V12"/><path class="part-body plate-minus" d="M24 -6V6"/></g>` +
      // the + sign stays upright
      `<text class="sign" text-anchor="middle" transform="translate(${item.flip ? 32 : 8} ${vert ? 14 : -10})${vert ? " rotate(-90)" : ""}" dy="4">+</text>`;
  }
  return `<g class="part part-${item.kind}${sel}${dim} ${extraClass}" data-edge="${key}" transform="${edgeTransform(key)}">` +
    `<line class="part-hit" x1="0" y1="0" x2="${G}" y2="0"/>${body}</g>`;
}

function fmtVal(q: Q, v: number | null, given: boolean): string {
  if (v === null) return `<tspan class="unk">${q} ?</tspan>`;
  return `<tspan class="${given ? "" : "calc"}">${esc(show(v, UNIT[q]))}</tspan>`;
}

function labelSvg(key: string, item: Item): string {
  const pr = analysis.parts[item.name!];
  if (!pr) return "";
  const [a, b] = edgeEnds(key);
  const mx = ((a.x + b.x) / 2) * G, my = ((a.y + b.y) / 2) * G;
  const vert = isVertical(key);
  const g = (q: Q) => fmtVal(q, pr.values[q], pr.given.has(q));
  const sep = '<tspan class="sep"> · </tspan>';
  const head = item.kind === "R" ? g("R") : g("V");
  const rest = (item.kind === "R" ? (["V", "I", "P"] as Q[]) : (["I", "P", "R"] as Q[])).filter((q) => pr.values[q] !== null).map(g);
  const anchor = vert ? "start" : "middle";
  const x = vert ? mx + 18 : mx;
  const y1 = vert ? my - 4 : my - 30;
  // Vertical parts sit side by side in parallel branches, so their labels stack narrow.
  const compact = isPhone() && key !== selected;
  const lines = compact ? [] : vert ? [rest.slice(0, 2), rest.slice(2)] : [rest];
  const top = compact ? (vert ? my + 5 : my - 16) : vert ? y1 - (rest.length > 2 ? 8 : 0) : y1;
  return `<g class="label" data-edge="${key}">` +
    `<text x="${x}" y="${top}" text-anchor="${anchor}"><tspan class="nm ${item.kind}">${esc(item.name!)}</tspan><tspan class="val" dx="6">${head}</tspan></text>` +
    lines.filter((l) => l.length).map((l, i) => `<text class="val" x="${x}" y="${top + 15 * (i + 1)}" text-anchor="${anchor}">${l.join(sep)}</text>`).join("") + `</g>`;
}

function renderBoard() {
  const parts: string[] = [], labels: string[] = [], flows: string[] = [], issues: string[] = [];
  const entries = Object.entries(doc);
  for (const [key, item] of entries) if (item.kind === "wire") parts.push(partSvg(key, item));
  for (const [key, item] of entries) {
    if (item.kind === "wire") continue;
    parts.push(partSvg(key, item));
    labels.push(labelSvg(key, item));
  }
  for (const pt of analysis.junctions) {
    const [x, y] = pt.split(",").map(Number);
    parts.push(`<circle class="junction" cx="${x * G}" cy="${y * G}" r="4.5"/>`);
  }
  for (const pt of analysis.openEnds) {
    const [x, y] = pt.split(",").map(Number);
    parts.push(`<circle class="open-end" cx="${x * G}" cy="${y * G}" r="5"/>`);
  }
  for (const iss of analysis.issues) {
    if (iss.level === "info") continue;
    for (const t of iss.targets) {
      if (t.split(",").length !== 4) continue;
      const [a, b] = edgeEnds(t);
      issues.push(`<line class="issue-mark ${iss.level}" x1="${a.x * G}" y1="${a.y * G}" x2="${b.x * G}" y2="${b.y * G}"/>`);
    }
  }
  if (analysis.solved) {
    let max = 0;
    for (const c of analysis.edgeCurrent.values()) max = Math.max(max, Math.abs(c));
    for (const [key, c] of analysis.edgeCurrent) {
      if (doc[key]?.kind !== "wire" || Math.abs(c) < max * 1e-6 || max === 0) continue;
      let [a, b] = edgeEnds(key);
      if (c < 0) [a, b] = [b, a];
      const dur = (0.35 + 1.4 * (1 - Math.abs(c) / max)).toFixed(2);
      flows.push(`<line class="flow" style="--dur:${dur}s" x1="${a.x * G}" y1="${a.y * G}" x2="${b.x * G}" y2="${b.y * G}"/>`);
    }
  }
  layers.parts.innerHTML = parts.join("");
  layers.labels.innerHTML = labels.join("");
  layers.flow.innerHTML = flows.join("");
  layers.issues.innerHTML = issues.join("");
  board.classList.toggle("flow-off", !showFlow);
  renderOverlay();
}

function renderResults() {
  const a = analysis;
  const errors = a.issues.filter((i) => i.level === "error");
  const status = a.solved && !errors.length ? ["ok", "Solved"]
    : errors.length ? ["bad", "Needs a fix"]
    : a.shape === "empty" ? ["idle", "Waiting"] : ["partial", "Partly solved"];
  const tot = a.total;
  const tile = (k: string, v: number | null | undefined, u: string) =>
    `<div class="total"><div class="k">${k}</div><div class="v">${v === null || v === undefined ? "–" : esc(show(v, u))}</div></div>`;

  const rows = Object.values(a.parts)
    .sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name, undefined, { numeric: true }) : x.kind === "V" ? -1 : 1))
    .map((p) => {
      const cell = (q: Q) => {
        const v = p.values[q];
        if (v === null) return `<td class="unk">?</td>`;
        return `<td class="${p.given.has(q) ? "" : "calc"}">${esc(show(v, UNIT[q]))}</td>`;
      };
      const state = p.state !== "ok" ? `<span class="state">${p.state}</span>` : "";
      return `<tr class="row${p.edge === selected ? " selected" : ""}" data-edge="${p.edge}"><td><span class="pname ${p.kind}">${esc(p.name)}</span>${state}</td>${(["R", "V", "I", "P"] as Q[]).map(cell).join("")}</tr>`;
    }).join("");

  const issues = [
    ...Object.entries(inputErrors).flatMap(([n, qs]) => Object.entries(qs).map(([q, m]) => ({ level: "error", message: `${n} ${q}: ${m}` }))),
    ...a.issues,
  ];
  const peekVals = tot ? [tot.R !== null ? show(tot.R, "Ω") : null, tot.I !== null ? show(tot.I, "A") : null, tot.P !== null ? show(tot.P, "W") : null].filter(Boolean).join(" · ") : "";
  resultsEl.innerHTML = `
    <button class="peek" type="button" id="peek" aria-expanded="${!resultsEl.classList.contains("collapsed")}">
      <span class="badge ${status[0]}">${status[1]}</span>
      <span class="peek-main"><b>${SHAPE_LABEL[a.shape]}</b><span>${esc(peekVals)}</span></span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>
    </button>
    <section class="shape">
      <span class="badge ${status[0]}">${status[1]}</span>
      <h2>${SHAPE_LABEL[a.shape]}</h2>
      ${a.expression ? `<div class="expr">${esc(a.expression)}</div>` : ""}
      ${a.method ? `<div class="method">Solved with ${esc(a.method[0].toLowerCase() + a.method.slice(1))}</div>` : ""}
    </section>
    ${tot ? `<section class="totals">${tile("R eq", tot.R, "Ω")}${tile("Source", tot.V, "V")}${tile("Total I", tot.I, "A")}${tile("Total P", tot.P, "W")}</section>` : ""}
    ${issues.length ? `<ul class="issues">${issues.map((i) => `<li class="${i.level}">${esc(i.message)}</li>`).join("")}</ul>` : ""}
    ${rows ? `<section><div class="table-wrap"><table>
      <thead><tr><th>Part</th><th>R</th><th>V</th><th>I</th><th>P</th></tr></thead><tbody>${rows}</tbody></table></div></section>
      <div class="legend"><span><b>White</b> you typed</span><span><b class="calc">Cyan</b> calculated</span></div>` : ""}
    ${a.log.length ? `<details class="steps"><summary>How it was solved (${a.log.length} steps)</summary><ol>${a.log.map((l) => `<li>${esc(l)}</li>`).join("")}</ol></details>` : ""}
    ${rows ? `<div class="row-actions"><button class="chip" id="btn-netlist" type="button">Copy netlist</button></div>` : ""}
  `;
}

// ---------------------------------------------------------------- value editor
let editorSnap: string | null = null;

function renderEditor() {
  const item = selected ? doc[selected] : null;
  if (!item || item.kind === "wire") {
    // Forget which part the editor showed, so reopening the same part rebuilds it.
    editorEl.hidden = true; editorEl.innerHTML = ""; delete editorEl.dataset.edge; delete editorEl.dataset.kind;
    document.body.classList.remove("editing");
    return;
  }
  const pr = analysis.parts[item.name!];
  const qs: Q[] = item.kind === "R" ? ["R", "V", "I", "P"] : ["V", "I", "P", "R"];
  const focusedId = document.activeElement?.id;
  const caret = (document.activeElement as HTMLInputElement | null)?.selectionStart ?? null;
  // Rebuild only when the part changes; otherwise update in place so typing isn't interrupted.
  if (editorEl.dataset.edge !== selected || editorEl.dataset.kind !== item.kind) {
    editorEl.dataset.edge = selected!;
    editorEl.dataset.kind = item.kind;
    editorEl.className = `editor ${item.kind}`;
    editorEl.innerHTML = `
      <header><span class="kind-dot"></span>
        <input class="name" id="ed-name" aria-label="Name" maxlength="12" spellcheck="false">
        <button class="close" type="button" id="ed-close" aria-label="Close">×</button></header>
      ${qs.map((q) => `<label class="field" id="f-${q}"><span class="q" title="${item.kind === "V" && q === "R" ? "Total resistance the source drives (V ÷ I)" : QNAME[q]}">${q}</span>
        <span class="box"><input id="ed-${q}" data-q="${q}" autocomplete="off" spellcheck="false" aria-label="${QNAME[q]} in ${UNIT[q]}"></span>
        <span class="err" hidden></span></label>`).join("")}
      <div class="note">Type what you know in plain V, A, W and Ω, like 12, 0.01 or 4700. Leave the rest blank.${milli ? " Typed values stay in A and W; add m for milli, like 42.6m." : ""}</div>
      <div class="actions">
        ${item.kind === "V" ? `<button class="chip" type="button" id="ed-flip">Flip polarity</button>` : ""}
        <button class="chip danger" type="button" id="ed-del">Delete</button>
      </div>`;
    (editorEl.querySelector("#ed-name") as HTMLInputElement).value = item.name!;
    for (const q of qs) (editorEl.querySelector(`#ed-${q}`) as HTMLInputElement).value = item.known?.[q] ?? "";
  }
  editorEl.hidden = false;
  document.body.classList.add("editing");
  for (const q of qs) {
    const input0 = editorEl.querySelector(`#ed-${q}`) as HTMLInputElement;
    // Keep boxes in step with the drawing (undo, redo) unless the user is typing in them.
    if (document.activeElement !== input0) input0.value = item.known?.[q] ?? "";
    const input = editorEl.querySelector(`#ed-${q}`) as HTMLInputElement;
    const field = editorEl.querySelector(`#f-${q}`) as HTMLElement;
    const v = pr?.values[q];
    input.placeholder = v === null || v === undefined || pr.given.has(q) ? "unknown" : `= ${show(v, UNIT[q])}`;
    const err = inputErrors[item.name!]?.[q];
    field.classList.toggle("bad", !!err);
    const errEl = field.querySelector(".err") as HTMLElement;
    errEl.hidden = !err;
    errEl.textContent = err ?? "";
  }
  if (focusedId && document.activeElement?.id !== focusedId) {
    const el = document.getElementById(focusedId) as HTMLInputElement | null;
    el?.focus();
    if (el && caret !== null) el.setSelectionRange(caret, caret);
  }
  positionEditor();
}

function positionEditor() {
  if (editorEl.hidden || !selected || !doc[selected]) return;
  if (window.matchMedia("(max-width: 860px)").matches) { editorEl.style.left = ""; editorEl.style.top = ""; return; }
  const [a, b] = edgeEnds(selected);
  const sx = ((a.x + b.x) / 2) * G * view.k + view.tx;
  const sy = ((a.y + b.y) / 2) * G * view.k + view.ty;
  const w = editorEl.offsetWidth || 260, h = editorEl.offsetHeight || 280;
  const resultsLeft = resultsEl.getBoundingClientRect().left || window.innerWidth;
  let x = sx + 36, y = sy - h / 2;
  if (x + w > resultsLeft - 12) x = sx - 36 - w;
  x = Math.max(16, Math.min(x, window.innerWidth - w - 16));
  y = Math.max(76, Math.min(y, window.innerHeight - h - 16));
  editorEl.style.left = `${x}px`;
  editorEl.style.top = `${y}px`;
}

editorEl.addEventListener("focusin", () => { editorSnap ??= snapshot(); });
editorEl.addEventListener("focusout", (e) => {
  if (editorEl.contains(e.relatedTarget as Node)) return;
  commitEditor();
});
function commitEditor() {
  if (editorSnap !== null && editorSnap !== snapshot()) pushHistory(editorSnap);
  editorSnap = null;
}
editorEl.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement;
  if (!selected || !doc[selected]) return;
  const item = doc[selected];
  if (t.id === "ed-name") {
    const name = t.value.trim().replace(/\s+/g, "");
    const clash = Object.values(doc).some((i) => i !== item && i.name === name);
    const ok = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !clash && name !== "Total";
    t.classList.toggle("bad", !ok);
    if (ok) { item.name = name; changed(); }
    return;
  }
  const q = t.dataset.q as Q | undefined;
  if (!q) return;
  item.known = { ...item.known, [q]: t.value };
  if (!t.value.trim()) delete item.known[q];
  changed();
});
editorEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const inputs = [...editorEl.querySelectorAll("input")];
    const i = inputs.indexOf(e.target as HTMLInputElement);
    if (i >= 0 && i < inputs.length - 1) inputs[i + 1].focus();
    else (e.target as HTMLElement).blur();
  }
  if (e.key === "Escape") { commitEditor(); select(null); }
  e.stopPropagation();
});
editorEl.addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).id;
  if (id === "ed-close") { commitEditor(); select(null); }
  if (id === "ed-del") deleteSelected();
  if (id === "ed-flip") flipSelected();
});

// ---------------------------------------------------------------- results interactions
resultsEl.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  if (t.id === "btn-netlist") {
    const text = toNetlist(doc, analysis);
    try {
      await navigator.clipboard.writeText(text);
      t.textContent = "Copied";
    } catch {
      t.textContent = "Copy failed";
      console.log(text);
    }
    setTimeout(() => { t.textContent = "Copy netlist"; }, 1500);
    return;
  }
  const row = t.closest("tr.row") as HTMLElement | null;
  if (row) select(row.dataset.edge!);
});

// ---------------------------------------------------------------- editing actions
function select(key: string | null) {
  if (key !== selected) commitEditor();
  selected = key;
  renderBoard();
  renderResults();
  renderEditor();
  if (key && isPhone()) requestAnimationFrame(() => keepInView(key));
}
function keepInView(key: string) {
  const [a, b] = edgeEnds(key);
  const sy = ((a.y + b.y) / 2) * G * view.k + view.ty;
  const sx = ((a.x + b.x) / 2) * G * view.k + view.tx;
  const top = $(".topbar").getBoundingClientRect().bottom + 50;
  const bottom = (editorEl.hidden ? $(".toolbar") : editorEl).getBoundingClientRect().top - 50;
  if (sy > bottom) view.ty -= sy - bottom;
  else if (sy < top) view.ty += top - sy;
  if (sx < 40) view.tx += 40 - sx;
  else if (sx > window.innerWidth - 120) view.tx -= sx - (window.innerWidth - 120);
  applyView();
}
function deleteSelected() {
  if (!selected || !doc[selected]) return;
  pushHistory();
  delete doc[selected];
  selected = null;
  editorSnap = null;
  changed();
}
function flipSelected() {
  if (!selected || doc[selected]?.kind !== "V") return;
  pushHistory();
  doc[selected].flip = !doc[selected].flip;
  changed();
}
function placePart(key: string, kind: "R" | "V") {
  const cur = doc[key];
  if (cur && cur.kind !== "wire") { select(key); return; }
  pushHistory();
  doc[key] = { kind, name: nextName(doc, kind), known: {} };
  selected = key;
  changed();
  if (pointerType !== "touch") pendingFocus = kind === "R" ? "#ed-R" : "#ed-V";
}
function loadExample(i: number) {
  pushHistory();
  doc = orient(EXAMPLES[i].build());
  selected = null;
  changed();
  fitView();
}

// ---------------------------------------------------------------- geometry
function toWorld(e: { clientX: number; clientY: number }) {
  const r = board.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.tx) / view.k, y: (e.clientY - r.top - view.ty) / view.k };
}
function nearestPoint(w: { x: number; y: number }): Pt {
  return { x: Math.round(w.x / G), y: Math.round(w.y / G) };
}
function nearestEdge(w: { x: number; y: number }): string {
  const gx = w.x / G, gy = w.y / G;
  const dh = Math.abs(gy - Math.round(gy)); // distance to the nearest horizontal grid line
  const dv = Math.abs(gx - Math.round(gx));
  if (dh <= dv) {
    const x = Math.floor(gx), y = Math.round(gy);
    return edgeKey({ x, y }, { x: x + 1, y });
  }
  const x = Math.round(gx), y = Math.floor(gy);
  return edgeKey({ x, y }, { x, y: y + 1 });
}
function* pathBetween(a: Pt, b: Pt): Generator<string> {
  let { x, y } = a;
  const horizFirst = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const stepX = function* () { while (x !== b.x) { const nx = x + Math.sign(b.x - x); yield edgeKey({ x, y }, { x: nx, y }); x = nx; } };
  const stepY = function* () { while (y !== b.y) { const ny = y + Math.sign(b.y - y); yield edgeKey({ x, y }, { x, y: ny }); y = ny; } };
  if (horizFirst) { yield* stepX(); yield* stepY(); } else { yield* stepY(); yield* stepX(); }
}

function fitView() {
  const keys = Object.keys(doc);
  const r = board.getBoundingClientRect();
  const wide = !isPhone();
  const top = wide ? 90 : $(".topbar").getBoundingClientRect().bottom + 12;
  const bottom = wide ? r.height - 100 : Math.min($(".toolbar").getBoundingClientRect().top, resultsEl.getBoundingClientRect().top || Infinity) - 12;
  const availW = r.width - (wide ? 400 : 24);
  const availH = bottom - top;
  if (!keys.length) { view = { tx: availW / 2 + 16, ty: top + availH / 2, k: 1 }; applyView(); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of keys) for (const p of edgeEnds(k)) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  // room for labels
  x1 += wide ? 3.5 : 1; // labels hang off to the right of vertical parts
  const w = (x1 - x0 + (wide ? 2 : 1)) * G, h = (y1 - y0 + (wide ? 3 : 2)) * G;
  const k = Math.max(wide ? 0.4 : 0.5, Math.min(1.6, availW / w, availH / h));
  const cx = ((x0 + x1) / 2) * G, cy = ((y0 + y1) / 2 - 0.3) * G;
  view = { k, tx: (wide ? 16 : 12) + availW / 2 - cx * k, ty: top + availH / 2 - cy * k };
  applyView();
}

// ---------------------------------------------------------------- pointer input
let drag:
  | { mode: "pan"; sx: number; sy: number; tx: number; ty: number }
  | { mode: "wire"; last: Pt; snap: string; changed: boolean }
  | { mode: "erase"; snap: string; changed: boolean }
  | { mode: "move"; key: string; snap: string; moved: boolean }
  | null = null;
let spaceDown = false;
let pendingFocus: string | null = null;
let hover: { edge: string; pt: Pt } | null = null;

function renderOverlay() {
  const out: string[] = [];
  if (hover && !drag) {
    const item = doc[hover.edge];
    if (tool === "wire") {
      out.push(`<circle class="hover-pt" cx="${hover.pt.x * G}" cy="${hover.pt.y * G}" r="5"/>`);
    } else if (tool === "R" || tool === "V") {
      if (!item || item.kind === "wire") {
        out.push(`<g class="ghost">${partSvg(hover.edge, { kind: tool, name: "", flip: false })}</g>`);
      } else out.push(edgeLine(hover.edge, "hover-edge"));
    } else if (tool === "erase" && item) {
      out.push(edgeLine(hover.edge, "hover-edge erase"));
    } else if (tool === "select" && item && item.kind !== "wire") {
      out.push(edgeLine(hover.edge, "hover-edge"));
    }
  }
  if (selected && doc[selected]) {
    const [a, b] = edgeEnds(selected);
    out.push(`<circle class="sel-ring" cx="${((a.x + b.x) / 2) * G}" cy="${((a.y + b.y) / 2) * G}" r="${G * 0.62}"/>`);
  }
  layers.overlay.innerHTML = out.join("");
}
function edgeLine(key: string, cls: string) {
  const [a, b] = edgeEnds(key);
  return `<line class="${cls}" x1="${a.x * G}" y1="${a.y * G}" x2="${b.x * G}" y2="${b.y * G}"/>`;
}

const touches = new Map<number, { x: number; y: number }>();
let pinch: { d0: number; k0: number; wx: number; wy: number } | null = null;
let touchSnap: { doc: string; at: number } | null = null;
/** Hit distance in world units: at least `px` screen pixels on touch screens. */
const reach = (world: number, px: number) => (pointerType === "touch" ? Math.max(world, px / view.k) : world);

function startPinch() {
  // A second finger turns whatever the first one started into a pinch: undo it.
  // Only when the second finger lands right after the first: a real two-finger gesture.
  if (touchSnap && performance.now() - touchSnap.at < 350 && touchSnap.doc !== snapshot()) {
    if (undoStack[undoStack.length - 1] === touchSnap.doc) undoStack.pop();
    doc = JSON.parse(touchSnap.doc);
    if (selected && !doc[selected]) selected = null;
    changed();
  }
  drag = null;
  pendingFocus = null;
  const [p, q] = [...touches.values()];
  const r = board.getBoundingClientRect();
  const mx = (p.x + q.x) / 2 - r.left, my = (p.y + q.y) / 2 - r.top;
  pinch = { d0: Math.hypot(p.x - q.x, p.y - q.y) || 1, k0: view.k, wx: (mx - view.tx) / view.k, wy: (my - view.ty) / view.k };
}
function movePinch() {
  if (!pinch || touches.size < 2) return;
  const [p, q] = [...touches.values()];
  const r = board.getBoundingClientRect();
  const mx = (p.x + q.x) / 2 - r.left, my = (p.y + q.y) / 2 - r.top;
  const k = Math.max(0.3, Math.min(3, pinch.k0 * Math.hypot(p.x - q.x, p.y - q.y) / pinch.d0));
  // Keep the world point under the fingers' midpoint under it as they move.
  view = { k, tx: mx - pinch.wx * k, ty: my - pinch.wy * k };
  applyView();
}

board.addEventListener("pointerdown", (e) => {
  e.preventDefault(); // keeps focus where we put it
  pointerType = e.pointerType || "mouse";
  if (e.pointerType === "touch") {
    // The first finger of a new gesture: forget any touch whose lift we never heard about.
    if (e.isPrimary) { touches.clear(); pinch = null; }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) touchSnap = { doc: snapshot(), at: performance.now() };
    if (touches.size === 2) { startPinch(); return; }
    if (touches.size > 2) return;
  }
  try { board.setPointerCapture(e.pointerId); } catch { /* the window listeners still see the lift */ }
  const w = toWorld(e);
  const edge = nearestEdge(w);
  const pt = nearestPoint(w);
  if (e.button === 1 || e.button === 2 || spaceDown) {
    drag = { mode: "pan", sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
    board.classList.add("panning");
    return;
  }
  if (document.activeElement instanceof HTMLInputElement) (document.activeElement as HTMLInputElement).blur();
  // With a brush in hand, clicking an existing part (or its value label) opens it for
  // editing instead of drawing over it or swapping it for another kind of part.
  if (tool === "wire" || tool === "R" || tool === "V") {
    const labelEdge = (e.target as Element).closest?.(".label")?.getAttribute("data-edge");
    const hit = doc[edge];
    const nearPoint = Math.hypot(w.x - pt.x * G, w.y - pt.y * G) < 0.3 * G;
    const target = labelEdge && doc[labelEdge] ? labelEdge
      : hit && hit.kind !== "wire" && !nearPoint && distToEdge(w, edge) < reach(0.45 * G, 26) ? edge : null;
    if (target) {
      select(target);
      if (pointerType !== "touch") pendingFocus = doc[target].kind === "R" ? "#ed-R" : "#ed-V";
      renderOverlay();
      return;
    }
  }
  if (tool === "wire") {
    drag = { mode: "wire", last: pt, snap: snapshot(), changed: false };
  } else if (tool === "R" || tool === "V") {
    placePart(edge, tool);
  } else if (tool === "erase") {
    drag = { mode: "erase", snap: snapshot(), changed: false };
    eraseAt(edge);
  } else {
    const item = doc[edge];
    // A click on a part's value label edits that part too.
    const labelEdge = (e.target as Element).closest?.(".label")?.getAttribute("data-edge");
    if (labelEdge && doc[labelEdge]) {
      select(labelEdge);
      if (pointerType !== "touch") pendingFocus = doc[labelEdge].kind === "R" ? "#ed-R" : "#ed-V";
      renderOverlay();
      return;
    }
    const onPart = item && item.kind !== "wire" && distToEdge(w, edge) < reach(0.45 * G, 26);
    if (onPart) {
      select(edge);
      drag = { mode: "move", key: edge, snap: snapshot(), moved: false };
    } else if (item && item.kind === "wire" && distToEdge(w, edge) < reach(0.2 * G, 12)) {
      select(edge);
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
    } else {
      select(null);
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
      board.classList.add("panning");
    }
  }
  renderOverlay();
});

function distToEdge(w: { x: number; y: number }, key: string) {
  const [a, b] = edgeEnds(key);
  const ax = a.x * G, ay = a.y * G, bx = b.x * G, by = b.y * G;
  const t = Math.max(0, Math.min(1, ((w.x - ax) * (bx - ax) + (w.y - ay) * (by - ay)) / (G * G)));
  return Math.hypot(w.x - (ax + t * (bx - ax)), w.y - (ay + t * (by - ay)));
}

function eraseAt(edge: string) {
  if (!drag || drag.mode !== "erase" || !doc[edge]) return;
  delete doc[edge];
  if (selected === edge) selected = null;
  drag.changed = true;
  changed(false);
}

board.addEventListener("pointermove", (e) => {
  if (touches.has(e.pointerId)) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { movePinch(); return; }
  }
  const w = toWorld(e);
  hover = { edge: nearestEdge(w), pt: nearestPoint(w) };
  if (!drag) { renderOverlay(); return; }
  if (drag.mode === "pan") {
    view.tx = drag.tx + e.clientX - drag.sx;
    view.ty = drag.ty + e.clientY - drag.sy;
    applyView();
  } else if (drag.mode === "wire") {
    const p = hover.pt;
    if (p.x !== drag.last.x || p.y !== drag.last.y) {
      for (const key of pathBetween(drag.last, p)) {
        if (!doc[key]) { doc[key] = { kind: "wire" }; drag.changed = true; }
      }
      drag.last = p;
      changed(false);
    }
  } else if (drag.mode === "erase") {
    eraseAt(hover.edge);
  } else if (drag.mode === "move") {
    const target = hover.edge;
    const t = doc[target];
    if (target !== drag.key && (!t || t.kind === "wire")) {
      const item = doc[drag.key];
      // Leave a wire behind so sliding a part along a loop keeps it closed.
      doc[drag.key] = { kind: "wire" };
      doc[target] = item;
      drag.key = target;
      drag.moved = true;
      selected = target;
      changed(false);
    }
  }
  renderOverlay();
});

function endDrag() {
  if (pendingFocus) {
    const sel = pendingFocus;
    pendingFocus = null;
    (editorEl.querySelector(sel) as HTMLInputElement | null)?.focus();
  }
  if (!drag) return;
  if ((drag.mode === "wire" || drag.mode === "erase") && drag.changed) { pushHistory(drag.snap); saveDoc(); }
  if (drag.mode === "move" && drag.moved) { pushHistory(drag.snap); saveDoc(); }
  drag = null;
  board.classList.remove("panning");
  updateButtons();
  renderOverlay();
}
function endPointer(e: PointerEvent) {
  touches.delete(e.pointerId);
  if (pinch) {
    if (touches.size < 2) pinch = null;
    return;
  }
  if (!touches.size) touchSnap = null;
  endDrag();
}
// On the window, so a finger lifted over the editor sheet or a button still counts.
window.addEventListener("pointerup", endPointer);
window.addEventListener("pointercancel", endPointer);
board.addEventListener("pointerleave", () => { if (!drag) { hover = null; renderOverlay(); } });
board.addEventListener("contextmenu", (e) => e.preventDefault());

board.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = board.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  // Pinch (ctrl+wheel) and mouse wheels zoom; two-finger trackpad scrolls pan.
  const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50);
  if (e.ctrlKey || mouseWheel) {
    const k = Math.max(0.3, Math.min(3, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
    view.tx = mx - ((mx - view.tx) * k) / view.k;
    view.ty = my - ((my - view.ty) * k) / view.k;
    view.k = k;
  } else {
    view.tx -= e.deltaX;
    view.ty -= e.deltaY;
  }
  applyView();
}, { passive: false });

// ---------------------------------------------------------------- keyboard
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === " ") { spaceDown = true; e.preventDefault(); return; }
  const t = TOOLS.find((x) => x.key.toLowerCase() === k);
  if (t) { setTool(t.id); return; }
  if (k === "delete" || k === "backspace") deleteSelected();
  if (k === "f") flipSelected();
  if (k === "escape") select(null);
  if (k === "0") fitView();
  if (k === "enter" && selected) (editorEl.querySelector("input[data-q]") as HTMLInputElement | null)?.focus();
});
window.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });
window.addEventListener("resize", () => { renderBoard(); applyView(); });

// ---------------------------------------------------------------- chrome
function setTool(t: Tool) {
  tool = t;
  board.className.baseVal = `tool-${t}${showFlow ? "" : " flow-off"}`;
  document.querySelectorAll<HTMLButtonElement>("#tools .tool").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === t);
    b.setAttribute("aria-pressed", String(b.dataset.tool === t));
  });
  hintEl.textContent = TOOLS.find((x) => x.id === t)!.hint;
  renderOverlay();
}

function updateButtons() {
  ($("#btn-undo") as HTMLButtonElement).disabled = !undoStack.length;
  ($("#btn-redo") as HTMLButtonElement).disabled = !redoStack.length;
  renderOverlay();
}

$("#tools").innerHTML = TOOLS.map((t) =>
  `<button class="tool" type="button" data-tool="${t.id}" style="--tool-color:${t.color}" title="${t.label} (${t.key})" aria-label="${t.label}">` +
  `<svg viewBox="0 0 24 24">${t.icon}</svg><span class="key">${t.key}</span></button>`).join("");
$("#tools").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (b) setTool(b.dataset.tool as Tool);
});
$("#example-buttons").innerHTML = EXAMPLES.map((x, i) => `<button class="chip" type="button" data-i="${i}">${x.name}</button>`).join("");
$("#example-buttons").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (b) loadExample(Number(b.dataset.i));
});
$("#btn-clear").addEventListener("click", () => {
  if (!Object.keys(doc).length) return;
  pushHistory();
  doc = {};
  selected = null;
  changed();
  setTool("wire");
});
$("#btn-undo").addEventListener("click", undo);
$("#btn-redo").addEventListener("click", redo);
$("#btn-fit").addEventListener("click", fitView);
const milliBtn = $("#btn-milli") as HTMLButtonElement;
const syncMilli = () => { milliBtn.classList.toggle("on", milli); milliBtn.setAttribute("aria-pressed", String(milli)); };
syncMilli();
milliBtn.addEventListener("click", () => {
  milli = !milli;
  try { localStorage.setItem(MILLI_KEY, milli ? "1" : "0"); } catch { /* storage unavailable */ }
  syncMilli();
  if (!editorEl.hidden) { delete editorEl.dataset.edge; delete editorEl.dataset.kind; }
  changed(false);
});
$("#btn-flow").addEventListener("click", (e) => {
  showFlow = !showFlow;
  const b = e.currentTarget as HTMLButtonElement;
  b.classList.toggle("on", showFlow);
  b.setAttribute("aria-pressed", String(showFlow));
  board.classList.toggle("flow-off", !showFlow);
});
resultsEl.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("#peek")) return;
  resultsEl.classList.toggle("collapsed");
  (resultsEl.querySelector("#peek") as HTMLElement).setAttribute("aria-expanded", String(!resultsEl.classList.contains("collapsed")));
});

// Test hook: lets the screenshot script drive the app.
(window as unknown as { sandbox: unknown }).sandbox = {
  select: (name: string) => select(Object.keys(doc).find((k) => doc[k].name === name) ?? null),
  setTool, loadExample, fitView,
  get doc() { return doc; }, set doc(d: Doc) { doc = d; selected = null; changed(); fitView(); },
};

if (window.innerWidth <= 860) resultsEl.classList.add("collapsed");
setTool("select");
changed(false);
fitView();
