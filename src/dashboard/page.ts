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
:root {
  --bg: #0a0c0f;
  --panel: #0f1317;
  --line: #1b212a;
  --line-soft: #151a21;
  --ink: #dde3ea;
  --dim: #8b949e;
  --dimmer: #5c656f;
  --good: #5fb37a;
  --bad: #d9635f;
  --warn: #c8973f;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  opacity: 0;
  animation: fade 180ms ease-out forwards;
}
@keyframes fade { to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { body { animation: none; opacity: 1; } }

.wrap { max-width: 1240px; margin: 0 auto; padding: 22px 20px 60px; }

header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
h1 { font-size: 14px; letter-spacing: .22em; margin: 0; font-weight: 600; }
.tagline { color: var(--dim); font-size: 12px; }
header .right { margin-left: auto; display: flex; align-items: center; gap: 10px; }

section { border: 1px solid var(--line); background: var(--panel); margin-bottom: 14px; }
section > h2 {
  margin: 0; padding: 8px 12px; font-size: 10.5px; font-weight: 600;
  letter-spacing: .14em; text-transform: uppercase; color: var(--dim);
  border-bottom: 1px solid var(--line);
}
.body { padding: 12px; }

button {
  font: inherit; font-size: 12px; color: var(--ink); background: #151a21;
  border: 1px solid var(--line); padding: 3px 10px; cursor: pointer;
}
button:hover { border-color: #2c3540; }
button[aria-pressed="true"] { background: #1e262f; border-color: #38434f; color: #fff; }
input[type="text"] {
  font: inherit; font-family: var(--mono); font-size: 12px; color: var(--ink);
  background: #151a21; border: 1px solid var(--line); padding: 3px 8px; width: 11ch;
  text-transform: uppercase;
}
.controls { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.controls .group { display: flex; gap: 4px; align-items: center; }
.controls label { color: var(--dimmer); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; }

.n { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.dim { color: var(--dim); }
.dimmer { color: var(--dimmer); }
.good { color: var(--good); }
.bad { color: var(--bad); }
.warn { color: var(--warn); }
.note { color: var(--dim); margin: 6px 0; }
.empty { color: var(--warn); margin: 4px 0; }

table { width: 100%; border-collapse: collapse; }
th {
  text-align: left; font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--dimmer); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
td { padding: 3px 8px; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
tr:last-child td { border-bottom: none; }
th.num, td.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.scroll { overflow-x: auto; }
.detail { color: var(--dim); font-size: 12px; }

.routes { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px; }
.route { border: 1px solid var(--line); padding: 8px 10px; }
.route.best { border-color: #2f5c3f; }
.route.off { opacity: .68; }
.route-top { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.route-name { font-weight: 600; }
.route-total { margin-left: auto; font-family: var(--mono); font-size: 15px; }
.route table td { border-bottom: none; padding: 2px 6px; }
.badge {
  font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase;
  border: 1px solid currentColor; padding: 0 4px; white-space: nowrap;
}
.est { font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--warn); }

.summary { margin: 0 0 10px; }
.summary strong { font-weight: 600; }
.kv { display: flex; gap: 6px; flex-wrap: wrap; color: var(--dim); margin: 0 0 10px; }
/* Direct children only: the separator belongs between items, not between the
   number spans inside one of them. */
.kv > span + span::before { content: "·"; color: var(--dimmer); margin-right: 6px; }

.rules { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 2px 18px; margin-bottom: 12px; }
.rule { display: flex; gap: 8px; align-items: baseline; padding: 1px 0; }
.rule .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; margin-top: 5px; }
.rule.on .dot { background: var(--good); }
.rule.off .dot { background: #2b333c; }
.rule .name { font-family: var(--mono); font-size: 12px; }
.rule.off .name { color: var(--dimmer); }
.rule .purpose { color: var(--dim); font-size: 12px; }
.rule.off .purpose { color: var(--dimmer); }

.feed td:first-child { font-family: var(--mono); color: var(--dimmer); }
.verdict { display: inline-block; padding: 1px 8px; font-weight: 600; letter-spacing: .1em; font-size: 11px; }
.verdict.ok { background: #16301f; color: var(--good); }
.verdict.no { background: #331a19; color: var(--bad); }
</style>
</head>
<body>

<div class="wrap">
<header>
  <h1>CRUCIBLE</h1>
  <span class="tagline">Routes an order to whichever venue fills it cheapest, then proves the result.</span>
  <span class="right">
    <span id="loaded" class="dim n"></span>
    <button id="reload" type="button">Reload</button>
  </span>
</header>

<section>
  <h2>Live quote &mdash; both venues, every cost component</h2>
  <div class="body">
    <div class="controls">
      <span class="group"><label for="symbol">pair</label><input id="symbol" type="text" value="BNBUSDT" spellcheck="false" autocomplete="off"></span>
      <span class="group" id="sides"></span>
      <span class="group"><label>size</label><span id="sizes" class="group"></span></span>
    </div>
    <div id="quote"></div>
  </div>
</section>

<section>
  <h2>Evidence &mdash; which venue was actually cheaper</h2>
  <div class="body" id="evidence"></div>
</section>

<section>
  <h2>Risk policy &mdash; what is switched on</h2>
  <div class="body" id="policy"></div>
</section>

<section>
  <h2>Ledger &mdash; verification and the recent decision feed</h2>
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

  function routeCard(route, cheapest, precision) {
    var label = venueName(route.venue) + " " + route.style.toLowerCase();
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
        ? "read from your account"
        : "public VIP 0 schedule, not your account's") + "</span></p>";

    if (quote.onchainUnavailable) {
      head += '<p class="warn">On-chain pricing did not answer: ' + esc(quote.onchainUnavailable) + "</p>";
    }

    var cards = "";
    for (var j = 0; j < quote.routes.length; j++) {
      cards += routeCard(quote.routes[j], quote.cheapest, quote.quoteAssetPrecision);
    }

    var verdict = "";
    if (quote.cheapest !== null && quote.edgeBps !== null) {
      var saving = (quote.edgeBps / 10000) * quote.notionalUsd;
      verdict = '<p class="summary"><strong>' + esc(venueName(quote.cheapest.split("/")[0])) +
        " is cheaper by " + esc(bps(quote.edgeBps)) + "</strong> " +
        '<span class="dim">= ' + esc(usd(saving)) + " on this order.</span></p>";
    } else if (quote.cheapest !== null) {
      verdict = '<p class="summary dim">Only one route could be priced, so there is nothing to compare it against.</p>';
    }

    el("quote").innerHTML = head + '<div class="routes">' + cards + "</div>" + verdict;
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
