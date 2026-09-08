/**
 * The dashboard page.
 *
 * One document, no requests off this machine: styles and script are inline, the
 * type is whatever the operating system already has, and every figure arrives
 * from this server's own /api endpoints. Nothing is baked into the markup, so a
 * panel with no data behind it says so rather than showing a number nobody
 * measured.
 *
 * The script inside deliberately avoids template literals, because this file is
 * one, and escaping them everywhere would make the page harder to read than the
 * concatenation it replaces.
 */

import { DEFAULT_SIZES } from "../sampler/run.ts";
import { THEME } from "./theme.ts";

export function renderPage(): string {
  // A complete document, not a fragment. Without a doctype a browser falls back
  // to quirks mode, where the box model and table layout differ enough to move
  // columns of numbers around — which is the one thing this page exists to keep
  // aligned.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Crucible</title>
<style>
${THEME}

/* ------------------------------------------------------------- app layout */
.wrap { padding-top: 22px; padding-bottom: 80px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }
section { margin-bottom: 22px; }
section > h2 { margin: 0; }
section > .body { padding: 16px; }

/* the page's own controls, in the theme's clothes */
.controls { display: flex; gap: 22px; align-items: center; flex-wrap: wrap; margin-bottom: 18px; }
.controls .group { display: flex; gap: 6px; align-items: center; }
.controls label { font-family: var(--mono); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-3); }
.controls button { font: 500 12px/1 var(--mono); color: var(--ink-2); background: transparent; border: 1px solid var(--line-strong); border-radius: 4px; padding: 6px 10px; cursor: pointer; }
.controls button:hover { color: var(--ink); }
.controls button[aria-pressed="true"] { color: var(--yellow); border-color: rgba(240, 185, 11, 0.5); background: rgba(240, 185, 11, 0.08); }
.controls input[type="text"] { font: 500 12px/1 var(--mono); color: var(--ink); background: var(--raised); border: 1px solid var(--line-strong); border-radius: 4px; padding: 6px 9px; width: 11ch; text-transform: uppercase; }
#reload { font: 500 12px/1 var(--mono); color: var(--ink-2); background: transparent; border: 1px solid var(--line-strong); border-radius: 4px; padding: 6px 10px; cursor: pointer; }
#reload:hover { color: var(--ink); }

.note { color: var(--ink-2); margin: 8px 0 0; font-size: 12.5px; }
.empty { color: var(--amber); margin: 6px 0; }
.detail { color: var(--ink-3); font-size: 12px; }

.summary { margin: 0 0 12px; }
.summary strong { display: block; font-size: 20px; line-height: 1.3; font-weight: 650; letter-spacing: -0.012em; margin-bottom: 3px; }
.summary strong + .dim { font-size: 13px; }
.verdict-line { padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.kv { display: flex; gap: 8px; flex-wrap: wrap; color: var(--ink-3); margin: 0 0 14px; font-size: 12.5px; }
.kv > span + span::before { content: "·"; color: var(--line-strong); margin-right: 8px; }

.routes { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 12px; }
.route { background: var(--raised); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px 8px; }
.route.best { border-color: rgba(63, 185, 80, 0.45); box-shadow: inset 0 0 0 1px rgba(63, 185, 80, 0.08); }
.route.off { opacity: 0.55; }
.route-top { display: flex; align-items: baseline; gap: 9px; margin-bottom: 8px; flex-wrap: wrap; }
.route-name { font-weight: 600; font-size: 13.5px; }
.route-total { margin-left: auto; font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 24px; font-weight: 600; letter-spacing: -0.015em; line-height: 1; }
.route.best .route-total { color: var(--green); }
.route .kv { margin-bottom: 10px; }
.route table { border-top: 1px solid var(--line); }
.route table td { border-bottom: none; padding: 5px 0 0; }
.route table tr:nth-child(even) td { padding: 0 0 7px; }
.route table td:first-child { color: var(--ink-2); }
.badge { font-family: var(--mono); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 600; border: 1px solid currentColor; border-radius: 999px; padding: 2px 7px; white-space: nowrap; opacity: 0.85; }
.est { font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--amber); margin-left: 4px; }

.rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 8px 28px; margin-bottom: 16px; }
.rule { display: flex; gap: 10px; align-items: baseline; }
.rule .dot { width: 5px; height: 5px; border-radius: 50%; flex: none; margin-top: 7px; }
.rule.on .dot { background: var(--green); }
.rule.off .dot { background: var(--line-strong); }
.rule .name { font-family: var(--mono); font-size: 12px; color: var(--ink); }
.rule.off .name { color: var(--ink-3); }
.rule .purpose { color: var(--ink-2); font-size: 12.5px; }
.rule.off .purpose { color: var(--ink-3); }

#ledger .scroll { max-height: 420px; overflow-y: auto; }
#ledger .scroll thead th { position: sticky; top: 0; background: var(--card); z-index: 1; }
.feed td:first-child { font-family: var(--mono); color: var(--ink-3); white-space: nowrap; }

@media (max-width: 960px) { .kpis { grid-template-columns: 1fr 1fr; } }
@media (max-width: 640px) { .kpis { grid-template-columns: 1fr; } .routes { grid-template-columns: 1fr; } .route-total { font-size: 21px; } .summary strong { font-size: 17px; } }
</style>
</head>
<body>

<div class="wrap">
<div class="topbar">
  <a class="mark" href="/"><span class="sq"></span><span><b>CRUCIBLE</b><small>SMART EXECUTION FOR BINANCE AGENTS</small></span></a>
  <span id="chips" style="display:flex;gap:8px;flex-wrap:wrap"></span>
  <nav>
    <span id="loaded" class="dimmer n" style="font-size:11px"></span>
    <button id="reload" type="button">Reload</button>
    <a href="/" class="hide-sm">Overview</a>
  </nav>
</div>

<div class="wrap">
<div class="kpis" id="kpis">
  <div class="card kpi"><div class="label">Cheapest route</div><div class="big" id="kpi-route">&ndash;</div><div class="sub" id="kpi-route-sub">at the selected size</div></div>
  <div class="card kpi"><div class="label">Edge on this order</div><div class="big" id="kpi-edge">&ndash;</div><div class="sub" id="kpi-edge-sub">against the next best route</div></div>
  <div class="card kpi"><div class="label">Real fills graded</div><div class="big" id="kpi-fills">&ndash;</div><div class="sub" id="kpi-fills-sub">from the signed ledger</div></div>
  <div class="card kpi"><div class="label">Venue samples</div><div class="big" id="kpi-samples">&ndash;</div><div class="sub" id="kpi-samples-sub">live comparisons recorded</div></div>
</div>

<section class="card">
  <div class="head"><span class="label">Live quote</span><span class="meta">both venues, one instant, every cost component</span></div>
  <div class="body">
    <div class="controls">
      <span class="group"><label for="symbol">pair</label><input id="symbol" type="text" value="BNBUSDT" spellcheck="false" autocomplete="off"></span>
      <span class="group" id="sides"></span>
      <span class="group"><label>size</label><span id="sizes" class="group"></span></span>
    </div>
    <div id="quote"></div>
  </div>
</section>

<section class="card">
  <div class="head"><span class="label">Evidence</span><span class="meta">which venue was actually cheaper, per pair and size</span></div>
  <div class="body" id="evidence"></div>
</section>

<section class="card">
  <div class="head"><span class="label">Risk policy</span><span class="meta">every rule an order clears, and its limit</span></div>
  <div class="body" id="policy"></div>
</section>

<section class="card">
  <div class="head"><span class="label">Ledger</span><span class="meta">hash-chained, signed, verified on load</span></div>
  <div class="body" id="ledger"></div>
</section>
</div>

<script>
"use strict";
(function () {
  var SIZES = ${JSON.stringify(DEFAULT_SIZES)};
  var state = { symbol: "BNBUSDT", side: "BUY", usd: SIZES.length > 1 ? SIZES[1] : SIZES[0] };

  function esc(value) {
    return String(value).replace(/[&<>"]/g, function (ch) {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      if (ch === ">") return "&gt;";
      return "&quot;";
    });
  }
  function num(value) { return '<span class="n">' + esc(value) + "</span>"; }

  function bps(v) { return (v < 0 ? "-" : "") + Math.abs(v).toFixed(2) + " bps"; }
  function usd(v) { return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function usdWhole(v) { return "$" + v.toLocaleString("en-US", { maximumFractionDigits: 0 }); }
  function pct(v) { return (v * 100).toFixed(1) + "%"; }
  function count(v) { return v.toLocaleString("en-US"); }
  // UTC throughout, because the sample file and the ledger are both written in
  // it and a mix of zones on one screen is how two times get compared wrongly.
  function clock(ms) { return new Date(ms).toISOString().slice(11, 19) + " UTC"; }
  function stamp(iso) {
    return String(iso).replace("T", " ").replace(/\\.\\d+Z$/, " UTC").replace(/Z$/, " UTC");
  }
  function venueName(v) { return v === "ONCHAIN" ? "on-chain" : v === "BINANCE_SPOT" ? "Binance spot" : v; }
  function sizeLabel(v) { return v >= 1000 ? "$" + v / 1000 + "k" : "$" + v; }

  /** Units come off the config key, so a limit never appears as a bare number. */
  function limitText(key, value) {
    if (Array.isArray(value)) {
      return value.map(function (item) {
        if (item && typeof item === "object") {
          return (item.start || "?") + "-" + (item.end || "?") + (item.label ? " " + item.label : "");
        }
        return String(item);
      }).join(", ");
    }
    if (value === null || typeof value === "object") return JSON.stringify(value);
    if (typeof value !== "number") return String(value);
    return numberWithUnit(key, value);
  }
  function numberWithUnit(key, value) {
    if (/Usd$/.test(key)) return usdWhole(value);
    if (/Bps$/.test(key)) return bps(value);
    if (/Ms$/.test(key)) return count(value) + " ms";
    if (/Pct$/.test(key) || /PctOfEquity$/.test(key)) return value.toFixed(1) + "%";
    if (/Minutes$/.test(key)) return count(value) + " min";
    if (/PerHour$/.test(key)) return count(value) + " per hour";
    if (/Qty$/.test(key)) return value.toFixed(8);
    if (/Price$/.test(key)) return String(value);
    return count(value);
  }

  function load(path) {
    return fetch(path, { headers: { accept: "application/json" } }).then(function (res) {
      return res.text().then(function (raw) {
        var body = null;
        try { body = JSON.parse(raw); } catch (err) { body = null; }
        if (!res.ok) {
          throw new Error(body && body.error ? body.error : "The server answered " + res.status + " and gave no reason.");
        }
        if (body === null) throw new Error("The server answered " + res.status + " with something that is not JSON.");
        return body;
      });
    });
  }

  function el(id) { return document.getElementById(id); }
  function pending(target, what) { target.innerHTML = '<p class="note">Reading ' + esc(what) + "...</p>"; }
  function failed(target, err) {
    target.innerHTML = '<p class="bad">' + esc(err && err.message ? err.message : String(err)) + "</p>";
  }

  // -------------------------------------------------------------------------
  // Quote
  // -------------------------------------------------------------------------

  function routeLabel(route) { return venueName(route.venue) + " " + route.style.toLowerCase(); }

  function routeCard(route, cheapest, precision) {
    var label = routeLabel(route);
    if (route.unavailable) {
      return '<div class="route off"><div class="route-top"><span class="route-name">' + esc(label) +
        '</span><span class="badge dimmer">no route</span></div><p class="note">' + esc(route.unavailable) + "</p></div>";
    }

    var best = cheapest === route.venue + "/" + route.style;
    var rows = "";
    for (var i = 0; i < route.components.length; i++) {
      var comp = route.components[i];
      rows += "<tr><td>" + esc(comp.name) + (comp.estimated ? ' <span class="est">modelled</span>' : "") +
        '</td><td class="num">' + num(bps(comp.bps)) + '</td></tr><tr><td colspan="2" class="detail">' +
        esc(comp.detail) + "</td></tr>";
    }

    return '<div class="route' + (best ? " best" : "") + '">' +
      '<div class="route-top"><span class="route-name">' + esc(label) + "</span>" +
      (best ? '<span class="badge good">cheapest</span>' : "") +
      (route.hasEstimates ? '<span class="badge warn">modelled</span>' : "") +
      '<span class="route-total">' + esc(bps(route.totalBps)) + "</span></div>" +
      '<div class="kv"><span>' + esc(usd(route.totalUsd)) + " on this order</span><span>effective price " +
      esc(route.effectivePrice.toFixed(precision)) + "</span></div><table>" + rows + "</table></div>";
  }

  function renderQuote(quote) {
    var head = '<p class="summary">' + num(quote.symbol) + " " + esc(quote.side) + " " +
      num(quote.baseQty.toFixed(6)) + " " + esc(quote.baseAsset) + " &mdash; " + num(usd(quote.notionalUsd)) +
      " at a mid of " + num(quote.mid.toFixed(quote.quoteAssetPrecision)) + "</p>";

    head += '<p class="kv"><span>spread ' + num(bps(quote.spreadBps)) + "</span>" +
      "<span>flow " + num(quote.flowPerSec.toFixed(2)) + " " + esc(quote.baseAsset) + "/s over " +
      num(quote.flowWindowSec.toFixed(0) + " s") + "</span>" +
      "<span>snapshot " + num(quote.snapshotHash) + "</span>" +
      "<span>taken " + num(clock(quote.takenAt)) + "</span>" +
      "<span>fees " + esc(quote.commission.source === "account"
        ? (quote.commission.via === "agent-os" ? "your account's, via Binance Agent OS" : "your account's, via API key")
        : "public VIP 0 schedule, not your account's") + "</span></p>";

    if (quote.onchainUnavailable) {
      head += '<p class="warn">On-chain pricing did not answer: ' + esc(quote.onchainUnavailable) + "</p>";
    }

    var cards = "";
    for (var j = 0; j < quote.routes.length; j++) {
      cards += routeCard(quote.routes[j], quote.cheapest, quote.quoteAssetPrecision);
    }

    // Named down to the style, because two of the three routes are the same
    // venue: "Binance is cheaper" would not say which way the order goes.
    var ranked = [];
    for (var k = 0; k < quote.routes.length; k++) {
      if (!quote.routes[k].unavailable) ranked.push(quote.routes[k]);
    }
    ranked.sort(function (a, b) { return a.totalBps - b.totalBps; });

    var verdict;
    if (ranked.length > 1) {
      var saving = (quote.edgeBps / 10000) * quote.notionalUsd;
      verdict = '<p class="summary verdict-line"><strong>' + esc(routeLabel(ranked[0])) + " is cheaper by " +
        esc(bps(quote.edgeBps)) + " than " + esc(routeLabel(ranked[1])) + "</strong> " +
        '<span class="dim">= ' + esc(usd(saving)) + " on this order.</span></p>";
    } else if (ranked.length === 1) {
      verdict = '<p class="summary verdict-line dim">Only ' + esc(routeLabel(ranked[0])) +
        " could be priced, so there is nothing to compare it against.</p>";
    } else {
      verdict = '<p class="empty">Neither venue could price this order. Each route above says why.</p>';
    }

    // The verdict leads. It is the one sentence this panel exists to produce,
    // and printing it under the three cards made the reader assemble it
    // themselves from a grid of numbers first.
    el("quote").innerHTML = head + verdict + '<div class="routes">' + cards + "</div>";

    // The tiles at the top say the answer before the panel explains it.
    if (ranked.length > 0) {
      el("kpi-route").textContent = routeLabel(ranked[0]);
      el("kpi-route-sub").textContent = bps(ranked[0].totalBps) + " all-in at " + usd(quote.notionalUsd);
    }
    if (ranked.length > 1) {
      el("kpi-edge").textContent = bps(quote.edgeBps);
      el("kpi-edge").className = "big " + (quote.edgeBps > 0 ? "good" : "");
      el("kpi-edge-sub").textContent = usd((quote.edgeBps / 10000) * quote.notionalUsd) + " against " + routeLabel(ranked[1]);
    }
    el("chips").innerHTML =
      '<span class="chip' + (quote.commission.source === "account" ? " on" : "") + '">fees ' +
      esc(quote.commission.source === "account" ? "account" : "VIP 0") + "</span>";
  }

  function loadQuote() {
    var target = el("quote");
    pending(target, "both venues at " + sizeLabel(state.usd));
    var query = "/api/quote?symbol=" + encodeURIComponent(state.symbol) +
      "&usd=" + encodeURIComponent(state.usd) + "&side=" + encodeURIComponent(state.side);
    return load(query).then(renderQuote).catch(function (err) { failed(target, err); });
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  function renderKpisFromReports() {
    load("/api/calibration").then(function (c) {
      el("kpi-fills").textContent = String(c.samples);
      el("kpi-fills-sub").textContent = c.samples > 0 ? "mean error " + bps(c.meanErrorBps) : "no execution graded yet";
    }).catch(function () {});
    load("/api/evidence").then(function (e) {
      el("kpi-samples").textContent = String(e.total);
      el("kpi-samples-sub").textContent = e.spanHours.toFixed(1) + " hours, cost model " + e.model;
    }).catch(function () {});
  }

  function renderEvidence(report) {
    var target = el("evidence");
    if (!report.total) {
      var why = "The sampler has not collected a usable sample yet, so there is nothing here to summarise.";
      if (report.failures) {
        why += " " + count(report.failures) + " sampling attempt(s) ran and failed, which is why the file is not empty.";
      }
      target.innerHTML = '<p class="empty">' + esc(why) + "</p>" +
        '<p class="note">Run the sampler to start collecting. Until then this panel stays blank rather than showing zeros.</p>';
      return;
    }

    var head = '<p class="summary"><strong>On-chain was cheaper in ' + esc(pct(report.onchainWinRate)) +
      " of " + esc(count(report.total)) + " samples</strong> " +
      '<span class="dim">(median edge ' + esc(bps(report.medianEdgeBps)) + " in on-chain's favour).</span></p>";

    head += '<p class="kv"><span>' + esc(count(report.total)) + " usable samples</span><span>" +
      esc(count(report.failures)) + " failed</span><span>" + esc(report.spanHours.toFixed(1)) +
      " hours</span><span>" + esc(stamp(report.from)) + " to " + esc(stamp(report.to)) + "</span></p>";

    if (report.crossoverNote) head += '<p class="note">' + esc(report.crossoverNote) + "</p>";

    var rows = "";
    for (var i = 0; i < report.buckets.length; i++) {
      var b = report.buckets[i];
      rows += "<tr><td>" + esc(b.symbol) + '</td><td class="num">' + num(usdWhole(b.notionalUsd)) +
        '</td><td class="num">' + num("n=" + count(b.count)) +
        '</td><td class="num">' + num(pct(b.onchainWinRate)) +
        '</td><td class="num">' + num(pct(1 - b.onchainWinRate)) +
        '</td><td class="num">' + num(bps(b.medianEdgeBps)) +
        '</td><td class="num">' + num(bps(b.medianOnchainBps)) +
        '</td><td class="num">' + num(bps(b.medianBinanceBps)) + "</td></tr>";
    }

    var table = '<div class="scroll"><table><thead><tr><th>pair</th><th class="num">size</th>' +
      '<th class="num">samples</th><th class="num">on-chain cheaper</th><th class="num">binance or tie</th>' +
      '<th class="num">median edge</th><th class="num">median on-chain</th><th class="num">median binance</th>' +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>";

    // Column set comes from the samples themselves, so a component the cost
    // model stops emitting simply stops appearing here.
    var names = [];
    for (var j = 0; j < report.buckets.length; j++) {
      var parts = report.buckets[j].medianOnchainParts || {};
      for (var name in parts) {
        if (Object.prototype.hasOwnProperty.call(parts, name) && names.indexOf(name) === -1) names.push(name);
      }
    }

    var attribution = "";
    if (names.length) {
      var header = '<tr><th>pair</th><th class="num">size</th><th class="num">samples</th>';
      for (var k = 0; k < names.length; k++) header += '<th class="num">' + esc(names[k]) + "</th>";
      header += "</tr>";

      var body = "";
      for (var m = 0; m < report.buckets.length; m++) {
        var bucket = report.buckets[m];
        body += "<tr><td>" + esc(bucket.symbol) + '</td><td class="num">' + num(usdWhole(bucket.notionalUsd)) +
          '</td><td class="num">' + num("n=" + count(bucket.count)) + "</td>";
        for (var p = 0; p < names.length; p++) {
          var value = (bucket.medianOnchainParts || {})[names[p]];
          body += '<td class="num">' + (typeof value === "number" ? num(bps(value)) : '<span class="dimmer">not seen</span>') + "</td>";
        }
        body += "</tr>";
      }
      attribution = '<h3 class="note">Median on-chain cost by component</h3><div class="scroll"><table><thead>' +
        header + "</thead><tbody>" + body + "</tbody></table></div>";
    }

    target.innerHTML = head + table + attribution;
  }

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  function renderPolicy(policy) {
    var active = 0;
    for (var i = 0; i < policy.rules.length; i++) if (policy.rules[i].active) active++;

    var head = '<p class="summary"><strong>' + esc(count(active)) + " of " + esc(count(policy.rules.length)) +
      " rules active</strong> " + '<span class="dim">in ' + esc(policy.mode) + " mode &mdash; " +
      esc(policy.live
        ? "live execution is enabled, so a cleared order can be transmitted."
        : "nothing will be transmitted.") + "</span></p>";

    head += '<p class="kv"><span>policy version ' + num(policy.version) + "</span><span>" + esc(policy.source) + "</span></p>";

    var rules = "";
    for (var j = 0; j < policy.rules.length; j++) {
      var rule = policy.rules[j];
      rules += '<div class="rule ' + (rule.active ? "on" : "off") + '"><span class="dot"></span>' +
        '<span class="name">' + esc(rule.name) + '</span> <span class="purpose">' +
        esc(rule.active ? rule.purpose : "not configured") + "</span></div>";
    }

    var keys = Object.keys(policy.limits).sort();
    var limits = "";
    for (var k = 0; k < keys.length; k++) {
      limits += '<tr><td class="n">' + esc(keys[k]) + '</td><td class="num">' +
        num(limitText(keys[k], policy.limits[keys[k]])) + "</td></tr>";
    }
    var limitTable = keys.length
      ? '<div class="scroll"><table><thead><tr><th>limit</th><th class="num">value</th></tr></thead><tbody>' +
        limits + "</tbody></table></div>"
      : '<p class="empty">This policy sets no limits at all, so no rule can fire.</p>';

    el("policy").innerHTML = head + '<div class="rules">' + rules + "</div>" + limitTable;
  }

  // -------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------

  function payloadText(payload) {
    if (payload === null || typeof payload !== "object") return String(payload);
    if (Array.isArray(payload)) return payload.length + " entries";
    var parts = [];
    var keys = Object.keys(payload);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var value = payload[key];
      if (value === null) { parts.push(key + " none"); continue; }
      if (Array.isArray(value)) { parts.push(key + " x" + value.length); continue; }
      if (typeof value === "object") { parts.push(key + " {...}"); continue; }
      parts.push(key + " " + (typeof value === "number" ? numberWithUnit(key, value) : value));
    }
    return parts.join("   ");
  }

  function renderLedger(ledger) {
    var badge = ledger.ok
      ? '<span class="verdict ok">VERIFIED</span>'
      : '<span class="verdict no">FAILED</span>';

    var head = '<p class="summary">' + badge + " " + num(count(ledger.records)) + " record(s), " +
      "hash chain " + (ledger.brokenAt === null ? "unbroken" : "cut at index " + esc(ledger.brokenAt)) + ", " +
      "signature " + (ledger.signatureValid ? "valid" : "not valid") + ".</p>";

    head += '<p class="kv"><span>' + esc(ledger.path) + "</span></p>";
    if (ledger.reason) head += '<p class="' + (ledger.ok ? "note" : "bad") + '">' + esc(ledger.reason) + "</p>";

    var feed;
    if (ledger.recentUnavailable) {
      feed = '<p class="bad">' + esc(ledger.recentUnavailable) + "</p>";
    } else if (!ledger.recent.length) {
      feed = '<p class="empty">No decisions have been recorded yet. The feed fills in as executions are written to the ledger.</p>';
    } else {
      var rows = "";
      for (var i = 0; i < ledger.recent.length; i++) {
        var record = ledger.recent[i];
        rows += "<tr><td>" + esc(record.seq) + '</td><td class="n">' + esc(stamp(record.timestamp)) +
          "</td><td>" + esc(record.kind) + '</td><td class="detail">' + esc(payloadText(record.payload)) +
          '</td><td class="n dimmer">' + esc(String(record.hash).slice(0, 12)) + "</td></tr>";
      }
      feed = '<div class="scroll"><table class="feed"><thead><tr><th>seq</th><th>written</th><th>kind</th>' +
        "<th>payload</th><th>hash</th></tr></thead><tbody>" + rows + "</tbody></table></div>";
    }

    el("ledger").innerHTML = head + feed;
  }

  // -------------------------------------------------------------------------
  // Controls and loading
  // -------------------------------------------------------------------------

  function drawControls() {
    var sides = ["BUY", "SELL"];
    var sideHtml = "";
    for (var i = 0; i < sides.length; i++) {
      sideHtml += '<button type="button" data-side="' + sides[i] + '" aria-pressed="' +
        (state.side === sides[i] ? "true" : "false") + '">' + sides[i] + "</button>";
    }
    el("sides").innerHTML = sideHtml;

    var sizeHtml = "";
    for (var j = 0; j < SIZES.length; j++) {
      sizeHtml += '<button type="button" data-usd="' + SIZES[j] + '" aria-pressed="' +
        (state.usd === SIZES[j] ? "true" : "false") + '">' + sizeLabel(SIZES[j]) + "</button>";
    }
    el("sizes").innerHTML = sizeHtml;
  }

  function loadPanel(path, target, what, render) {
    pending(target, what);
    return load(path).then(render).catch(function (err) { failed(target, err); });
  }

  function loadAll() {
    renderKpisFromReports();
    el("loaded").textContent = "loading";
    return Promise.all([
      loadQuote(),
      loadPanel("/api/evidence", el("evidence"), "the sample file", renderEvidence),
      loadPanel("/api/policy", el("policy"), "the policy", renderPolicy),
      loadPanel("/api/ledger", el("ledger"), "the ledger", renderLedger)
    ]).then(function () {
      el("loaded").textContent = "loaded " + clock(Date.now());
    });
  }

  el("sides").addEventListener("click", function (event) {
    var side = event.target.getAttribute && event.target.getAttribute("data-side");
    if (!side || side === state.side) return;
    state.side = side;
    drawControls();
    loadQuote();
  });

  el("sizes").addEventListener("click", function (event) {
    var size = event.target.getAttribute && event.target.getAttribute("data-usd");
    if (!size) return;
    if (Number(size) === state.usd) return;
    state.usd = Number(size);
    drawControls();
    loadQuote();
  });

  el("symbol").addEventListener("change", function (event) {
    var symbol = String(event.target.value || "").trim().toUpperCase();
    event.target.value = symbol;
    if (!symbol || symbol === state.symbol) return;
    state.symbol = symbol;
    loadQuote();
  });

  el("reload").addEventListener("click", function () { loadAll(); });

  drawControls();
  loadAll();
})();
</script>
</body>
</html>
`;
}
