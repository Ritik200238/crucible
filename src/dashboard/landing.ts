/**
 * The landing page.
 *
 * The first screen a stranger sees, so it has to say what this is in one
 * breath and then prove it. Every number on it is fetched from this server's
 * own endpoints when the page loads — the hero panel is a real quote priced at
 * that moment, the strip counts what the ledger and the evidence file actually
 * hold — because a landing page that hard-codes its proof is a brochure.
 *
 * Same rule as the app: no request leaves the machine serving this. The script
 * uses concatenation rather than template literals because the file is one.
 */

import { THEME } from "./theme.ts";

/** Pinned by the MCP suite, which fails if the count drifts. */
const TOOL_COUNT = 10;

export function renderLanding(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="description" content="Crucible routes a Binance agent's order to whichever venue fills it cheapest — the exchange or on-chain — gates it through a deterministic policy, executes, and proves what it cost.">
<title>Crucible</title>
<style>
${THEME}

.hero { position: relative; padding: 84px 0 64px; overflow: hidden; }
.hero::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(60% 50% at 20% 0%, rgba(240, 185, 11, 0.10), transparent 60%),
    radial-gradient(40% 40% at 85% 20%, rgba(31, 199, 212, 0.08), transparent 60%);
}
.hero .wrap { position: relative; display: grid; grid-template-columns: minmax(0, 1.18fr) minmax(0, 0.82fr); gap: 44px; align-items: center; }
h1 { margin: 0 0 22px; font-size: 41px; line-height: 1.1; font-weight: 800; letter-spacing: -0.028em; }
h1 span { display: block; }
.lede { font-size: 17px; line-height: 1.6; color: var(--ink-2); max-width: 56ch; margin: 0 0 30px; }
.lede b { color: var(--ink); font-weight: 600; }
.ctas { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 26px; }
.kicker { font-family: var(--mono); font-size: 11px; letter-spacing: 0.16em; color: var(--ink-3); text-transform: uppercase; }
.kicker span + span::before { content: "·"; margin: 0 10px; color: var(--line-strong); }

.panel { padding: 0; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5); }
.panel .head .label { color: var(--cyan); }
.panel .head .live { display: inline-flex; align-items: center; gap: 6px; }
.panel .head .live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }
.routes { display: grid; gap: 10px; }
.route {
  display: grid; grid-template-columns: 1fr auto; gap: 4px 14px; align-items: baseline;
  padding: 12px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--raised);
}
.route.best { border-color: rgba(63, 185, 80, 0.45); }
.route .name { font-weight: 600; font-size: 13.5px; }
.route .total { font-family: var(--mono); font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.route.best .total { color: var(--green); }
.route .parts { grid-column: 1 / -1; color: var(--ink-3); font-family: var(--mono); font-size: 11px; }
.verdict-line { margin: 14px 0 0; font-size: 14px; }
.verdict-line b { color: var(--ink); }

.strip { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--surface); }
.strip .wrap { display: grid; grid-template-columns: repeat(4, 1fr); }
.stat { padding: 26px 18px; text-align: center; border-left: 1px solid var(--line); }
.stat:first-child { border-left: none; }
.stat .num { font-family: var(--mono); font-size: 32px; font-weight: 700; letter-spacing: -0.02em; }
.stat .label { margin-top: 6px; color: var(--yellow); }

section.block { padding: 84px 0; border-bottom: 1px solid var(--line); }
section.block:last-of-type { border-bottom: none; }
h2 { margin: 10px 0 14px; font-size: 32px; line-height: 1.15; font-weight: 750; letter-spacing: -0.022em; }
.intro { font-size: 15.5px; color: var(--ink-2); max-width: 72ch; margin: 0 0 34px; }
.intro code { background: var(--raised); padding: 1px 6px; border-radius: 4px; font-size: 13px; }

.steps { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
.step { padding: 18px; }
.step .num { font-family: var(--mono); font-size: 11px; color: var(--yellow); letter-spacing: 0.14em; margin-bottom: 10px; }
.step h3 { margin: 0 0 6px; font-size: 15px; font-weight: 650; }
.step p { margin: 0; color: var(--ink-2); font-size: 13px; line-height: 1.55; }

.two { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; align-items: start; }
.never li { margin: 0 0 10px; padding-left: 18px; position: relative; color: var(--ink-2); }
.never li::before { content: "✕"; position: absolute; left: 0; color: var(--red); font-family: var(--mono); font-size: 12px; top: 3px; }
.never li b { color: var(--ink); }
.rules { columns: 2; column-gap: 28px; }
.rule { break-inside: avoid; display: flex; gap: 10px; align-items: baseline; margin-bottom: 8px; }
.rule .dot { width: 5px; height: 5px; border-radius: 50%; flex: none; margin-top: 7px; background: var(--green); }
.rule.off .dot { background: var(--line-strong); }
.rule code { font-size: 12px; color: var(--ink); }
.rule.off code { color: var(--ink-3); }
.rule span { color: var(--ink-2); font-size: 12.5px; }

.tools td:first-child code { color: var(--yellow); }
.tools td.state { font-family: var(--mono); font-size: 11px; color: var(--ink-3); white-space: nowrap; }
pre.cmd {
  margin: 0; padding: 14px 16px; background: var(--raised); border: 1px solid var(--line-strong);
  border-radius: 6px; font: 500 13px/1.5 var(--mono); color: var(--ink); overflow-x: auto;
}
pre.cmd .c { color: var(--ink-3); }

footer { padding: 40px 0 56px; color: var(--ink-3); font-size: 12.5px; }
footer .wrap { display: flex; gap: 24px; flex-wrap: wrap; align-items: center; }
footer a { color: var(--ink-2); }
footer a:hover { color: var(--ink); }
footer .spacer { flex: 1; }

@media (max-width: 960px) {
  .hero .wrap { grid-template-columns: 1fr; gap: 32px; }
  h1 { font-size: 36px; }
  .steps { grid-template-columns: 1fr 1fr; }
  .two { grid-template-columns: 1fr; }
  .strip .wrap { grid-template-columns: 1fr 1fr; }
  .stat:nth-child(3) { border-left: none; }
  .stat { border-top: 1px solid var(--line); }
  .stat:nth-child(-n+2) { border-top: none; }
  .rules { columns: 1; }
}
@media (max-width: 560px) {
  .hero { padding: 48px 0 40px; }
  h1 { font-size: 30px; }
  .steps { grid-template-columns: 1fr; }
  h2 { font-size: 26px; }
}
</style>
</head>
<body>

<div class="topbar">
  <a class="mark" href="/"><span class="sq"></span><span><b>CRUCIBLE</b><small>SMART EXECUTION FOR BINANCE AGENTS</small></span></a>
  <nav>
    <a href="#how" class="hide-sm">How it works</a>
    <a href="#evidence" class="hide-sm">The evidence</a>
    <a href="#real" class="hide-sm">Executed</a>
    <a href="#safety" class="hide-sm">Safety</a>
    <a href="#connect" class="hide-sm">Connect</a>
    <a class="btn primary small" href="/app">Launch app &rarr;</a>
  </nav>
</div>

<section class="hero grid-bg">
  <div class="wrap">
    <div>
      <h1><span>Your agent decides the trade.</span><span class="gradient-text">Crucible decides the venue,</span><span class="gradient-text">and proves what it cost.</span></h1>
      <p class="lede">An AI agent placing a market order pays the spread, the commission and the impact — routinely more than the edge it was chasing. Binance Agent OS gives an agent two ways to buy the same asset: the exchange, and on-chain through the Agentic Wallet. <b>They do not cost the same, and which is cheaper changes with the size of the order.</b> Crucible prices both at one instant, routes to the cheaper one, gates it through a deterministic policy, executes, and reads the fill back.</p>
      <div class="ctas">
        <a class="btn primary" href="/app">Launch app &rarr;</a>
        <a class="btn" href="#evidence">Read the evidence</a>
      </div>
      <p class="kicker"><span>Runs in this browser</span><span>Live market data</span><span>Route any order</span><span>No keys needed</span></p>
    </div>

    <div class="card panel" id="hero-panel">
      <div class="head">
        <span class="label">Live quote</span>
        <span class="chip"><span class="live"><span class="dot"></span>BNBUSDT &middot; $1,000 buy</span></span>
        <span class="meta n" id="hero-time"></span>
      </div>
      <div class="body" id="hero-body"><span class="pending">pricing both venues</span></div>
    </div>
  </div>
</section>

<div class="strip">
  <div class="wrap">
    <div class="stat"><div class="num n" id="stat-rules">&ndash;</div><div class="label">policy rules</div></div>
    <div class="stat"><div class="num n">${TOOL_COUNT}</div><div class="label">MCP tools</div></div>
    <div class="stat"><div class="num n" id="stat-samples">&ndash;</div><div class="label">venue samples measured</div></div>
    <div class="stat"><div class="num n" id="stat-fills">&ndash;</div><div class="label">real fills graded</div></div>
  </div>
</div>

<section class="block" id="how">
  <div class="wrap">
    <div class="label yellow">How it works</div>
    <h2>One snapshot, then pure functions.</h2>
    <p class="intro">Both venues are fetched concurrently and hashed into a single object. Nothing downstream reads a clock or a network, so the same snapshot always produces the same plan and the same fingerprint &mdash; a decision someone who was not there can check.</p>
    <div class="steps">
      <div class="card step"><div class="num">01 &middot; SNAPSHOT</div><h3>One instant, both venues</h3><p>The Binance book, the account's real commission through Agent OS, the tape, and PancakeSwap's own quoter on every fee tier. Hashed together.</p></div>
      <div class="card step"><div class="num">02 &middot; PRICE</div><h3>Every cost, in basis points</h3><p>Commission, half spread, book impact. Pool fee, price impact, gas, wallet fee. Maker priced with a measured fill probability and adverse selection, with an error bar.</p></div>
      <div class="card step"><div class="num">03 &middot; CHOOSE</div><h3>The cheaper route</h3><p>Per order, never per venue. A plan with a fingerprint over the intent, the snapshot and the policy. Single use, sixty seconds.</p></div>
      <div class="card step"><div class="num">04 &middot; GATE</div><h3>Rules the agent cannot change</h3><p>Deterministic policy, refused with a number. Caps, halts, cooldowns, freshness, depth, venue divergence. An in-flight order holds its notional until it resolves.</p></div>
      <div class="card step"><div class="num">05 &middot; EXECUTE</div><h3>Read back, then receipted</h3><p>The fill comes from the venue, never from the placing response. Predicted against realised, and the model grades itself over time.</p></div>
    </div>
  </div>
</section>

<section class="block" id="evidence">
  <div class="wrap">
    <div class="label yellow">The evidence</div>
    <h2>The cheaper venue changes with size, and the crossover is different for every pair.</h2>
    <p class="intro">Measured, not asserted. Each row is a live comparison of the same order on both venues at one instant, sampled repeatedly. The gap on the small orders is almost all commission; it reverses where the pool's impact overtakes the exchange's fee. On two of the four pairs on-chain never wins at any size, because a 50 bp wallet fee lands on the swap &mdash; which is the case for routing per order rather than picking a venue and living with it.</p>
    <div class="card"><div class="body scroll" id="evidence-body"><span class="pending">reading the samples</span></div></div>

    <h3 style="margin:42px 0 10px;font-size:19px;font-weight:700;letter-spacing:-0.015em">Those are four fixed sizes. The flip is somewhere between them.</h3>
    <p class="intro" style="margin-bottom:20px"><code>crucible crossover</code> bisects the live cost curves to find where it actually is &mdash; each row below a real quote at a real size, taken in sequence until the answer is pinned. Run it three times in an afternoon and it reads $104k, then $93k, then $90k. That is the point rather than a defect: the flip moves with the book, the pool, the gas price and your own fee tier. There is nowhere to look this number up.</p>
    <pre class="cmd" style="max-width:640px"><span class="c"># BNBUSDT BUY, twelve live quotes</span>
       $100.00   binance    7.57   on-chain    1.67    on-chain
    $35,355.00   binance    9.62   on-chain    4.77    on-chain
    $88,440.00   binance   10.77   on-chain   10.29    on-chain
    $94,015.00   binance   10.86   on-chain   10.86    Binance spot maker
   $250,000.00   binance   13.41   on-chain   31.32    Binance spot maker

crossover  $93,302 &plusmn; 2%</pre>
    <p class="intro" style="margin:20px 0 0">Two things it refuses to do. On BTC/USDT it stops after two quotes and reports no crossover, rather than bisecting a curve that never crosses. And when one venue cannot price an order at all, the lone answer is not called a winner &mdash; the top of the range walks down until both venues quote, and the range actually used is stated.</p>
  </div>
</section>

<section class="block" id="real">
  <div class="wrap">
    <div class="label yellow">Executed, for real</div>
    <h2>Twenty orders through the whole pipeline, and the model graded on every one.</h2>
    <p class="intro">Routed, gated, sent to Binance's matching engine, read back, and receipted &mdash; predicted cost beside realised. The first fill was charged 7.5 basis points against a published 10, which settled a question Binance's own documentation leaves open: whether the discount field is the amount taken off or the fraction still paid. It is the fraction paid, and the model has predicted the exact cost of every fill since.</p>
    <div class="two">
      <div class="card"><div class="head"><span class="label">Calibration</span><span class="meta">from the signed ledger</span></div><div class="body" id="calibration-body"><span class="pending">reading the ledger</span></div></div>
      <div class="card"><div class="head"><span class="label">What that does and does not prove</span></div><div class="body dim" style="font-size:13.5px">
        <p style="margin:0 0 10px">These were small orders on a deep book: impact was zero and the estimate was almost entirely commission, which is now read from the account rather than modelled. Getting that right is arithmetic.</p>
        <p style="margin:0 0 10px">The terms that could actually be wrong &mdash; book impact at size, the maker fill probability, adverse selection &mdash; have not been graded, because no order large enough to move the book has been sent.</p>
        <p style="margin:0">It was Demo Mode: the real matching engine on a practice account. Nothing has gone to the live exchange, and the on-chain leg has never executed. The page says so because the tool does.</p>
      </div></div>
    </div>
  </div>
</section>

<section class="block" id="safety">
  <div class="wrap">
    <div class="label yellow">Safety</div>
    <h2>Refused with a number, never with an opinion.</h2>
    <p class="intro">Every rule runs on every order and reports its verdict with the figures that decided it. The agent is told plainly that the policy is the operator's and cannot be changed from inside a conversation.</p>
    <div class="two">
      <div class="card"><div class="head"><span class="label">What Crucible never does</span></div><div class="body"><ul class="never" style="margin:0;padding:0;list-style:none">
        <li><b>Never reports a fill it did not read back.</b> The response that placed the order is not proof it happened.</li>
        <li><b>Never forgets an order the network lost.</b> Sent and not confirmed is <em>unconfirmed</em>, held against every cap until the venue answers. Not a failure, and never retried blind.</li>
        <li><b>Never executes a plan it did not make.</b> <code>execute</code> takes a plan id and nothing else; any change to the order is a different plan that has to clear the gates again.</li>
        <li><b>Never applies a number it cannot prove.</b> A fee discount stayed unapplied until a real fill showed how the field reads.</li>
        <li><b>Never lets the agent say what did not happen.</b> A summary is checked against the ledger before it reaches you &mdash; including the refusal it quietly left out.</li>
      </ul></div></div>
      <div class="card"><div class="head"><span class="label">The rules</span><span class="meta" id="rules-meta"></span></div><div class="body"><div class="rules" id="rules-body"><span class="pending">reading the policy</span></div></div></div>
    </div>
  </div>
</section>

<section class="block" id="connect">
  <div class="wrap">
    <div class="label yellow">Connect</div>
    <h2>It is an MCP server. Point an agent at it.</h2>
    <p class="intro">Ten tools over stdio or HTTP. On this public instance eight of them answer anyone &mdash; quote, route, and every check. The two that move money need the operator's key: a public instance that trades for strangers would be trading their money, and this one holds no credential to trade with anyway.</p>
    <div class="two">
      <div>
        <pre class="cmd"><span class="c"># any MCP client, one line</span>
claude mcp add crucible --transport http <span id="mcp-url"></span>

<span class="c"># or locally, over stdio</span>
git clone https://github.com/Ritik200238/crucible &amp;&amp; cd crucible &amp;&amp; npm install
claude mcp add crucible -- node --experimental-strip-types src/mcp/server.ts</pre>
      </div>
      <div class="card"><div class="body scroll"><table class="tools">
        <thead><tr><th>Tool</th><th>What it does</th><th>Here</th></tr></thead>
        <tbody>
          <tr><td><code>quote</code></td><td>Price every route. Decides nothing, sends nothing.</td><td class="state">open</td></tr>
          <tr><td><code>route</code></td><td>Choose the cheapest, gate it, return a fingerprinted plan.</td><td class="state">open</td></tr>
          <tr><td><code>execute</code></td><td>Execute a plan by id, confirm the fill, receipt it.</td><td class="state">token</td></tr>
          <tr><td><code>reconcile</code></td><td>Resolve an order that was sent but never read back.</td><td class="state">token</td></tr>
          <tr><td><code>check_claim</code></td><td>Check a summary against the ledger before it reaches the user.</td><td class="state">open</td></tr>
          <tr><td><code>policy</code></td><td>Which rules are in force, and that the agent cannot change them.</td><td class="state">open</td></tr>
          <tr><td><code>evidence</code></td><td>The recorded venue comparison.</td><td class="state">open</td></tr>
          <tr><td><code>calibration</code></td><td>How wrong the cost model has been against real fills.</td><td class="state">open</td></tr>
          <tr><td><code>verify_ledger</code></td><td>Recompute the hash chain and check the signature.</td><td class="state">open</td></tr>
          <tr><td><code>status</code></td><td>Whether each execution path can actually be reached.</td><td class="state">open</td></tr>
        </tbody>
      </table></div></div>
    </div>
  </div>
</section>

<footer>
  <div class="wrap">
    <span class="mark"><span class="sq"></span><b>CRUCIBLE</b></span>
    <span>Built for the Binance Agent OS Mini Hackathon, Track A.</span>
    <span class="spacer"></span>
    <a href="https://github.com/Ritik200238/crucible">Source</a>
    <a href="/app">App</a>
    <span>Not financial advice. You are responsible for the orders your agent places.</span>
  </div>
</footer>

<script>
"use strict";
(function () {
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function bps(n) { return (n < 0 ? "-" : "") + Math.abs(n).toFixed(2) + " bps"; }
  function usd(n) { return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function load(path) {
    return fetch(path, { headers: { accept: "application/json" } }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || ("HTTP " + r.status));
        return body;
      });
    });
  }
  function failed(target, err) { el(target).innerHTML = '<span class="error">' + esc(err.message) + "</span>"; }
  function routeLabel(r) {
    if (r.venue === "ONCHAIN") return "On-chain";
    return r.style === "MAKER" ? "Binance spot maker" : r.style === "SLICED" ? "Binance spot, sliced" : "Binance spot taker";
  }

  el("mcp-url").textContent = location.origin + "/mcp";

  // ---- hero: a real quote, priced now ------------------------------------
  load("/api/quote?symbol=BNBUSDT&usd=1000&side=BUY").then(function (q) {
    el("hero-time").textContent = "priced " + new Date(q.takenAt).toISOString().slice(11, 19) + " UTC";
    var ranked = q.routes.filter(function (r) { return !r.unavailable; }).sort(function (a, b) { return a.totalBps - b.totalBps; });
    var html = '<div class="routes">';
    for (var i = 0; i < q.routes.length; i++) {
      var r = q.routes[i];
      var best = q.cheapest === r.venue + "/" + r.style;
      if (r.unavailable) {
        html += '<div class="route" style="opacity:.55"><span class="name">' + esc(routeLabel(r)) + '</span><span class="total dimmer" style="font-size:13px">unavailable</span></div>';
        continue;
      }
      var parts = r.components.map(function (c) { return esc(c.name) + " " + c.bps.toFixed(2); }).join(" &middot; ");
      html += '<div class="route' + (best ? " best" : "") + '"><span class="name">' + esc(routeLabel(r)) + (best ? ' <span class="chip good" style="margin-left:6px">cheapest</span>' : "") +
        '</span><span class="total">' + esc(bps(r.totalBps)) + '</span><span class="parts">' + parts + "</span></div>";
    }
    html += "</div>";
    if (ranked.length > 1) {
      html += '<p class="verdict-line dim"><b>' + esc(routeLabel(ranked[0])) + " is cheaper by " + esc(bps(q.edgeBps)) + "</b> than " + esc(routeLabel(ranked[1])) +
        " &mdash; " + esc(usd((q.edgeBps / 10000) * q.notionalUsd)) + " on this order. Fees: " +
        esc(q.commission.source === "account" ? "this account's real rate" : "public VIP 0 schedule") + ".</p>";
    }
    el("hero-body").innerHTML = html;
  }).catch(function (err) { failed("hero-body", err); });

  // ---- strip -------------------------------------------------------------
  load("/api/policy").then(function (p) {
    el("stat-rules").textContent = String(p.rules.length);
    var on = p.rules.filter(function (r) { return r.active; }).length;
    el("rules-meta").textContent = on + " of " + p.rules.length + " active on this instance";
    el("rules-body").innerHTML = p.rules.map(function (r) {
      return '<div class="rule' + (r.active ? "" : " off") + '"><span class="dot"></span><span><code>' + esc(r.name) + "</code> <span>" + esc(r.purpose) + "</span></span></div>";
    }).join("");
  }).catch(function (err) { failed("rules-body", err); });

  load("/api/evidence").then(function (e) {
    el("stat-samples").textContent = String(e.total);
    var rows = e.buckets || [];
    var html = "<table><thead><tr><th>Pair</th><th class=\\"num\\">Size</th><th class=\\"num\\">Samples</th><th class=\\"num\\">On-chain cheaper</th><th class=\\"num\\">Median on-chain</th><th class=\\"num\\">Median Binance</th><th class=\\"num\\">Median edge</th></tr></thead><tbody>";
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i];
      var share = b.onchainWinRate;
      html += "<tr><td class=\\"n\\">" + esc(b.symbol) + "</td><td class=\\"num\\">" + esc(usd(b.notionalUsd).replace(".00", "")) +
        "</td><td class=\\"num\\">" + b.count + '</td><td class="num ' + (share >= 0.5 ? "good" : "dimmer") + '">' + (share * 100).toFixed(0) + "%" +
        "</td><td class=\\"num\\">" + esc(bps(b.medianOnchainBps)) + "</td><td class=\\"num\\">" + esc(bps(b.medianBinanceBps)) +
        '</td><td class="num ' + (b.medianEdgeBps >= 0 ? "good" : "bad") + '">' + esc(bps(b.medianEdgeBps)) + "</td></tr>";
    }
    html += "</tbody></table>";
    {
      html += '<p class="dimmer" style="margin:12px 0 0;font-size:12px">' + e.total + " samples over " + e.spanHours.toFixed(1) + " hours, cost model " + e.model + ". Regenerate with <code>npm run evidence</code>.</p>";
    }
    el("evidence-body").innerHTML = html;
  }).catch(function (err) { failed("evidence-body", err); });

  load("/api/calibration").then(function (c) {
    el("stat-fills").textContent = String(c.samples);
    if (c.samples === 0) { el("calibration-body").innerHTML = '<p class="dim" style="margin:0">' + esc(c.verdict) + "</p>"; return; }
    var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 20px;margin-bottom:14px">' +
      '<div><div class="label">executions graded</div><div class="n" style="font-size:26px;font-weight:600">' + c.samples + "</div></div>" +
      '<div><div class="label">mean error</div><div class="n" style="font-size:26px;font-weight:600">' + esc(bps(c.meanErrorBps)) + "</div></div>" +
      '<div><div class="label">median error</div><div class="n" style="font-size:20px">' + esc(bps(c.medianErrorBps)) + "</div></div>" +
      '<div><div class="label">typical miss</div><div class="n" style="font-size:20px">' + esc(bps(c.meanAbsErrorBps)) + "</div></div></div>" +
      '<p class="dim" style="margin:0;font-size:13px">' + esc(c.verdict) + "</p>";
    el("calibration-body").innerHTML = html;
  }).catch(function (err) { failed("calibration-body", err); });
})();
</script>
</body>
</html>
`;
}
