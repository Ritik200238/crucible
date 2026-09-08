/**
 * One stylesheet for both pages.
 *
 * The palette is the one a Binance user already reads fluently: a near-black
 * ground, the exchange's yellow for the single thing on a screen that asks to
 * be pressed, green and red only for signed numbers, and a cool cyan where a
 * second accent is unavoidable. Everything that carries a figure is set in a
 * tabular monospace so columns line up down the page and a change of
 * magnitude is visible before the digits are read.
 *
 * No webfont and no request off the machine serving the page, on purpose: it
 * loads instantly, works offline, and tracks nobody. The tests pin that.
 */

export const THEME = `
:root {
  --bg: #07090f;
  --surface: #0b0e15;
  --card: #0f131b;
  --raised: #131924;
  --line: #1a2130;
  --line-strong: #263042;
  --ink: #e5e7eb;
  --ink-2: #9ca3af;
  --ink-3: #6b7280;
  --yellow: #f0b90b;
  --yellow-ink: #0b0d10;
  --cyan: #1fc7d4;
  --green: #3fb950;
  --green-dim: rgba(63, 185, 80, 0.14);
  --red: #f85149;
  --red-dim: rgba(248, 81, 73, 0.14);
  --amber: #d29922;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --radius: 8px;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 400 14px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } * { transition: none !important; animation: none !important; } }
::selection { background: rgba(240, 185, 11, 0.28); }
:focus-visible { outline: 2px solid var(--yellow); outline-offset: 2px; }
a { color: inherit; text-decoration: none; }
code, .n { font-family: var(--mono); font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }

/* ------------------------------------------------------------- text roles */
.label {
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.label.yellow { color: var(--yellow); }
.dim { color: var(--ink-2); }
.dimmer { color: var(--ink-3); }
.good { color: var(--green); }
.bad { color: var(--red); }
.warn { color: var(--amber); }
.cyan { color: var(--cyan); }

/* ------------------------------------------------------------- chrome */
.topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 22px;
  height: 56px; padding: 0 28px;
  background: rgba(7, 9, 15, 0.86);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--line);
}
.mark { display: flex; align-items: center; gap: 10px; }
.mark .sq {
  width: 22px; height: 22px; border-radius: 4px;
  background: var(--yellow);
  position: relative;
}
.mark .sq::after {
  content: ""; position: absolute; inset: 6px;
  background: var(--bg); border-radius: 2px;
}
.mark b { font-weight: 700; letter-spacing: 0.22em; font-size: 13px; }
.mark small { display: block; font-family: var(--mono); font-size: 8.5px; letter-spacing: 0.14em; color: var(--ink-3); margin-top: -2px; }
.topbar nav { margin-left: auto; display: flex; gap: 22px; align-items: center; }
.topbar nav a { color: var(--ink-2); font-size: 13.5px; }
.topbar nav a:hover { color: var(--ink); }

.chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.02em;
  padding: 3px 8px; border: 1px solid var(--line-strong); border-radius: 4px;
  color: var(--ink-2); white-space: nowrap;
}
.chip.on { color: var(--yellow); border-color: rgba(240, 185, 11, 0.45); background: rgba(240, 185, 11, 0.08); }
.chip.good { color: var(--green); border-color: rgba(63, 185, 80, 0.4); background: var(--green-dim); }
.chip.bad { color: var(--red); border-color: rgba(248, 81, 73, 0.4); background: var(--red-dim); }
.chip .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

.btn {
  display: inline-flex; align-items: center; gap: 8px;
  font: 600 14px/1 var(--sans);
  padding: 13px 20px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--line-strong); color: var(--ink); background: var(--raised);
  transition: transform 100ms ease, background 120ms ease, border-color 120ms ease;
}
.btn:hover { border-color: rgba(255, 255, 255, 0.24); }
.btn:active { transform: translateY(1px); }
.btn.primary { background: var(--yellow); color: var(--yellow-ink); border-color: var(--yellow); }
.btn.primary:hover { background: #ffc61a; }
.btn.small { font-size: 12px; padding: 7px 12px; }

button.opt {
  font: 500 12px/1 var(--mono); color: var(--ink-2);
  background: transparent; border: 1px solid var(--line-strong); border-radius: 4px;
  padding: 6px 10px; cursor: pointer;
}
button.opt:hover { color: var(--ink); }
button.opt[aria-pressed="true"] { color: var(--yellow); border-color: rgba(240, 185, 11, 0.5); background: rgba(240, 185, 11, 0.08); }
input.field {
  font: 500 12px/1 var(--mono); color: var(--ink);
  background: var(--raised); border: 1px solid var(--line-strong); border-radius: 4px;
  padding: 6px 9px; width: 11ch; text-transform: uppercase;
}

/* ------------------------------------------------------------- cards */
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.card > .head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 16px; border-bottom: 1px solid var(--line);
}
.card > .head .label { color: var(--ink-2); letter-spacing: 0.14em; }
.card > .head .meta { margin-left: auto; display: flex; gap: 8px; align-items: center; color: var(--ink-3); font-size: 12px; }
.card > .body { padding: 16px; }

.kpi { padding: 14px 16px; }
.kpi .label { margin-bottom: 8px; }
.kpi .big { font-family: var(--mono); font-size: 24px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.1; }
.kpi .big small { font-size: 13px; font-weight: 500; color: var(--ink-2); margin-left: 6px; }
.kpi .sub { color: var(--ink-3); font-size: 12px; margin-top: 6px; }

/* ------------------------------------------------------------- tables */
table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--ink-3); font-weight: 600; padding: 0 10px 8px; border-bottom: 1px solid var(--line); white-space: nowrap;
}
td { padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
th.num, td.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.scroll { overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.scroll::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 999px; }

/* ------------------------------------------------------------- verdict pills */
.verdict {
  display: inline-block; padding: 2px 8px; border-radius: 4px;
  font-family: var(--mono); font-weight: 600; letter-spacing: 0.1em; font-size: 10px; text-transform: uppercase;
}
.verdict.ok { background: var(--green-dim); color: var(--green); }
.verdict.no { background: var(--red-dim); color: var(--red); }

/* ------------------------------------------------------------- misc */
.grid-bg {
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.028) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.028) 1px, transparent 1px);
  background-size: 44px 44px;
}
.gradient-text {
  background: linear-gradient(90deg, var(--yellow) 0%, #7ee787 55%, var(--cyan) 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.wrap { max-width: 1240px; margin: 0 auto; padding: 0 28px; }
.pending { color: var(--ink-3); font-family: var(--mono); font-size: 12px; }
.pending::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--yellow); margin-right: 8px; animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.error { color: var(--red); font-size: 13px; }
@media (max-width: 720px) {
  .topbar { padding: 0 16px; gap: 12px; }
  .topbar nav { gap: 14px; }
  .topbar nav a.hide-sm { display: none; }
  .wrap { padding: 0 16px; }
}
`;
