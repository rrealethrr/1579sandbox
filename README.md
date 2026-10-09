# 1579 Circuit Sandbox

Draw a DC circuit on a snap-to-grid board, type in whatever values you know, and it
solves every resistor's R, V, I and P as you go. It runs in any browser with nothing to
install: open `DCSandbox.html`.

## Using it

Toolbar, bottom left (keyboard shortcut in brackets):

| Tool | What it does |
| --- | --- |
| Select (V) | Click a part to edit its values. Drag a part to slide it along the wire. Drag empty space to pan. |
| Wire brush (W) | Drag along the grid to paint wires. Wires that meet at a grid point join into one node. |
| Resistor brush (R) | Click a wire segment to drop a resistor there. |
| Source brush (B) | Click a wire segment to place a DC source. F flips its polarity. |
| Eraser (E) | Click or drag over wires and parts to remove them. |

Also: Ctrl+Z / Ctrl+Shift+Z undo and redo, Delete removes the selected part, mouse wheel
or pinch zooms, Space+drag pans, 0 fits the drawing to the screen. The drawing is saved in
the browser between visits.

On a phone held upright, examples are drawn tall to fit the screen. Pinch to zoom, drag
with two fingers to pan, and tap a part to edit it in the sheet above the toolbar. The
results bar at the bottom shows the circuit type and totals; tap it for the full table.

Values accept engineering units: `4.7k`, `12V`, `10mA`, `220Ω`, `1meg` (a bare `M` is
rejected as ambiguous, the same as the Python tools). Leave unknowns blank. Values you
typed show in white; calculated ones in cyan.

## Real wires

Off by default: wires are perfect and nothing about them shows. Turn on **Real wires**
in the top bar to treat every drawn wire as a real conductor:

- **To scale.** Each grid square is 10 ft (change it under Scale). Painting a wire shows
  its length as you drag, and every run of wire is labeled with its length and size.
- **Defaults.** Copper with K = 12.6 Ω·cmil/ft (aluminum uses 21.2). Wire size is Auto:
  the smallest standard size that passes every check below.
- **Per run.** Click a run with the select tool to give it its own length (for runs not
  drawn to scale), size or material.
- **Solving.** Each run becomes R = K·L/CM in the circuit. Loads keep the resistance from
  the perfect-wire solve, and the panel shows the voltage each load really gets.
- **NEC checks.** Voltage drop at each load (3% recommended, 5% total, the informational
  notes to 210.19(A) and 215.2(A)), ampacity (Table 310.16, 75 °C column), the
  small-conductor limits of 240.4(D) and minimum size (310.3(A)). Runs that fail are
  marked red on the board, warnings amber. Breaker sizing and continuous-load rules
  aren't checked: the sandbox has no breakers yet.

## How it solves

1. The drawing becomes a netlist: grid points joined by wires become nodes; every
   resistor and source is an element between two nodes.
2. Parts that can't carry current are flagged on the board: open branches, parts
   shorted by a wire, and parts not connected to a source. A wire straight across a
   source is reported as a short circuit, and an unclosed loop as an open circuit.
3. The resistors seen from the source are reduced by series and parallel merges. If
   that works, the circuit is labelled **series**, **parallel** or **combination** and
   solved with the known-values rules ported from `known_values.py`, which log a
   step-by-step hand solution (the source plays the role of "Total").
4. Otherwise (a bridge, or more than one source) it's a **complex** or **multi-source
   network**, solved with modified nodal analysis ported from `mna.py`. Missing
   resistances or source voltages are found by fitting the known V, I and P values.
5. Every solved circuit finally goes through MNA to get current directions, which drive
   the current-flow animation along each wire.

**Copy netlist** puts the drawing on the clipboard in the netlist format that
`mna.py` and `cli.py` read.

## Developing

```
npm install
npm run dev          # live dev server
npm test             # 66 tests: the Python hand-solved cases plus drawn circuits
npm run build        # dist/index.html (single file) and dist/artifact.html
npm run screenshots  # needs Chromium; set CHROMIUM=/path/to/chrome if not found
```

Source layout:

- `src/solver/mna.ts` – port of `mna.py` (same tests in `test/mna.test.ts`)
- `src/solver/knownValues.ts` – port of `known_values.py` (`test/knownValues.test.ts`)
- `src/solver/circuit.ts` – drawing to circuit, shape detection, problem checks, solving
- `src/solver/units.ts` – value parsing and formatting
- `src/solver/conductor.ts`, `src/solver/nec.ts`, `src/solver/wires.ts` – real wires: K·L/CM, NEC tables and checks, runs and auto sizing (`test/wires.test.ts`)
- `src/main.ts`, `src/style.css`, `index.html` – the board and UI
- `src/examples.ts` – the example circuits (taken from the Python tests)

## Hosting on GitHub Pages

`.github/workflows/pages.yml` tests and builds the app on every push to `main` and
publishes `dist/index.html` with GitHub Pages. In the repository on GitHub, open
Settings → Pages and set Source to "GitHub Actions" once; after that each push updates
the live site at `https://<user>.github.io/<repo>/`.
