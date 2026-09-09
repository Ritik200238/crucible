#!/usr/bin/env node
/**
 * Build the demo video.
 *
 * One slide per claim, a proof beside each claim, the narration burned in as a
 * caption, and a brand strip on every frame. The proofs are not illustrations:
 * every terminal block is the real output of the real command, captured into
 * the work directory before this runs, and every product shot is a screenshot
 * of the live instance. The narration is synthesised, so the timing of each
 * slide comes from the length of what is said over it rather than a guess.
 *
 * Pipeline: narration → mp3 (edge-tts) → a presenter page → recorded with a
 * real browser at 1080p30 → audio laid over it → H.264/AAC.
 *
 *   node --experimental-strip-types demo/video/build.ts
 *
 * Needs: ffmpeg and ffprobe on PATH, python with edge-tts, and the captures
 * listed in CAPTURES present in the work directory.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const WORK = join(tmpdir(), "vid");
const OUT = join(WORK, "out");
const AUDIO = join(OUT, "audio");
mkdirSync(AUDIO, { recursive: true });

const SITE = "crucible-router.vercel.app";
const VOICE = process.env.VOICE ?? "en-US-AndrewNeural";

const CAPTURES = ["agent.txt", "attack.txt", "calibration.txt", "refusal.txt", "claim.txt", "q1k.txt", "q100k.txt", "vid-landing.png", "vid-app.png"];
for (const f of CAPTURES) {
  if (!existsSync(join(WORK, f))) {
    console.error(`Missing capture: ${join(WORK, f)}. Produce it first; nothing in this video is staged.`);
    process.exit(2);
  }
}

const read = (f: string) => readFileSync(join(WORK, f), "utf8").replace(/\r/g, "");
const lines = (f: string, keep: (l: string) => boolean) => read(f).split("\n").filter(keep);

// ---------------------------------------------------------------------------
// The script. Headlines are what is read; narration is what is said and shown
// as the caption. Proofs are real captures.
// ---------------------------------------------------------------------------

type Visual =
  | { kind: "title" }
  | { kind: "image"; file: string }
  | { kind: "terminal"; title: string; text: string }
  | { kind: "big"; value: string; label: string; sub?: string }
  | { kind: "connect" };

interface Slide {
  kicker: string;
  headline: string[];
  sub?: string;
  narration: string;
  visual: Visual;
  /** Seconds added after the narration ends. */
  breath?: number;
}

const q100k = lines("q100k.txt", (l) => /CRUCIBLE|BUY |mid |[●○] |Cheapest:/.test(l)).join("\n");
const q1k = lines("q1k.txt", (l) => /CRUCIBLE|BUY |mid |[●○] |Cheapest:/.test(l)).join("\n");
const refusal = read("refusal.txt").trim();
const calibration = read("calibration.txt").trim();
const attack = lines("attack.txt", (l) => /^\s+\d+\.\s|STOPPED|All 19 attacks/.test(l))
  .map((l) => l.replace(/STOPPED.*$/, "STOPPED"))
  .join("\n");
// The replacement lists every fill; the point is the refusal and that a true
// replacement exists, so the list is cut after its first lines.
const claimLines = read("claim.txt").trim().split("\n");
const claimCut = claimLines.findIndex((l) => /Say this instead/.test(l));
const claim = (claimCut === -1 ? claimLines : claimLines.slice(0, claimCut + 2))
  .map((l) => (l.length > 170 ? l.slice(0, 170).replace(/\s+\S*$/, "") + " …" : l))
  .join("\n");
const agentStatus = lines("agent.txt", (l) => /tools offered|^\s+user\s+What would it cost|^\s+agent\s+calls quote/.test(l)).slice(0, 3).join("\n");
const agentFees = lines("agent.txt", (l) => /taker fee:|Fees:/.test(l)).slice(0, 2).map((l) => l.replace(/^\s*│\s?/, "")).join("\n");

const SLIDES: Slide[] = [
  {
    kicker: "Crucible",
    headline: ["Your agent decides the trade.", "Crucible decides the venue,", "and proves what it cost."],
    narration: "Your agent decides what to trade. Crucible decides where — and proves what it cost.",
    visual: { kind: "title" },
    breath: 1.2,
  },
  {
    kicker: "The problem",
    headline: ["An agent places a market order.", "It pays the spread, the fee,", "and the impact."],
    sub: "Routinely more than the edge it was chasing. Almost nothing measures it, and nothing chooses a venue per order.",
    narration: "An agent placing a market order pays the spread, the fee and the impact — often more than the edge it was chasing.",
    visual: { kind: "big", value: "10 bps", label: "commission alone, at the public rate", sub: "on every exchange order, before spread or impact" },
  },
  {
    kicker: "Two venues",
    headline: ["Binance Agent OS gives", "two ways to buy", "the same asset."],
    sub: "The exchange, or on-chain through the Agentic Wallet. They do not cost the same.",
    narration: "Binance Agent OS gives an agent two ways to buy the same asset: the exchange, or on-chain through the Agentic Wallet. They do not cost the same.",
    visual: { kind: "image", file: "vid-landing.png" },
  },
  {
    kicker: "Live quote · $1,000",
    headline: ["Both venues, priced", "at one instant."],
    sub: "Every cost in basis points: commission, spread, book impact. Pool fee, price impact, gas, wallet fee. With an error bar.",
    narration: "Crucible prices both at one instant, every cost in basis points. At a thousand dollars, on-chain is cheaper by about eight.",
    visual: { kind: "image", file: "vid-app.png" },
  },
  {
    kicker: "Live quote · $100,000",
    headline: ["Same pair.", "A hundred thousand.", "The answer flips."],
    sub: "The pool's impact overtakes the exchange's fee. That is the whole case for routing per order, never per venue.",
    narration: "At a hundred thousand the answer flips: the pool's impact overtakes the exchange fee. The cheaper venue changes with size — so Crucible routes every order, never a venue once.",
    visual: { kind: "terminal", title: "crucible quote --symbol BNBUSDT --usd 100000", text: q100k },
  },
  {
    kicker: "Refusal",
    headline: ["Two million.", "Every venue refuses —", "each with a reason."],
    sub: "The book cannot hold it. The pool prices it hundreds of basis points off the exchange. Nothing routes.",
    narration: "Two million dollars: every venue refuses, each with a reason. The book cannot hold it, and the pool's price is broken, not a bargain. Nothing is sent.",
    visual: { kind: "terminal", title: "crucible route --symbol BNBUSDT --usd 2000000", text: refusal },
  },
  {
    kicker: "Built on Agent OS",
    headline: ["Your real commission,", "read through Binance's", "own MCP server."],
    sub: "Not a public schedule. The account's rate, through the session the user authorised — and the on-chain leg through the Agentic Wallet.",
    narration: "Built on Binance Agent OS. Your real commission is read through Binance's own MCP server, so every quote is at your account's rate. The on-chain leg goes through the Agentic Wallet.",
    visual: { kind: "terminal", title: "an agent, over MCP", text: agentStatus + "\n\n" + agentFees },
  },
  {
    kicker: "Executed, for real",
    headline: ["Twenty real orders.", "Predicted, then measured."],
    sub: "Routed, gated, sent to Binance's matching engine, read back from the venue, and receipted.",
    narration: "Not a simulation. Twenty orders went through the whole pipeline — routed, gated, sent to Binance, read back, receipted. Mean error: eight hundredths of a basis point.",
    visual: { kind: "terminal", title: "crucible calibration", text: calibration },
  },
  {
    kicker: "Proof",
    headline: ["The first fill settled", "what the docs leave open."],
    sub: "Charged 7.5 bps against a published 10. The discount field is the fraction paid, not the amount off. One real trade proved it; the model has been exact since.",
    narration: "The first fill was charged seven and a half basis points against a published ten — and settled how Binance's discount field reads. Every fill since has been predicted exactly.",
    visual: { kind: "big", value: "7.50 bps", label: "charged on order 7070626547", sub: "predicted 10.07 · the gap was the unapplied discount · now exact" },
  },
  {
    kicker: "Attacked",
    headline: ["Nineteen attacks.", "All stopped.", "Re-run in CI."],
    sub: "Order splitting, replay, a poisoned pool, a negative book level, an order cut off before the read-back. Each worked once.",
    narration: "It was attacked, not just tested: order splitting, replay, a poisoned pool, an order whose reply was lost while the order stayed live. Nineteen attacks, all stopped, re-run in CI on every push.",
    visual: { kind: "terminal", title: "node demo/attack.ts", text: attack },
  },
  {
    kicker: "Honest",
    headline: ["It checks what the agent", "tells you, too."],
    sub: "A figure no record carries, a fill that never happened, a refusal quietly left out — refused, and replaced with what the ledger says.",
    narration: "It checks what the agent tells you, too. A figure no record carries, a fill that never happened, a refusal left out — refused, and replaced with what actually happened.",
    visual: { kind: "terminal", title: 'crucible claim --text "Bought $1,000 of BNB and saved 8 bps"', text: claim },
  },
  {
    kicker: "Connect",
    headline: ["It is an MCP server.", "Ten tools. One line."],
    sub: "Over stdio locally, or HTTP on the hosted instance — public read-only, with execute behind the operator's token.",
    narration: "It is an MCP server. Ten tools, one line to connect. On the hosted instance every read tool answers anyone; the two that move money need the operator's token.",
    visual: { kind: "connect" },
  },
  {
    kicker: "Don't take our word for it",
    headline: ["492 tests. 20 real fills.", "Live, read-only, now."],
    sub: `${SITE} · github.com/Ritik200238/crucible`,
    narration: "Four hundred and ninety-two tests. Twenty real fills. Live and read-only at crucible-router dot vercel dot app. Crucible.",
    visual: { kind: "image", file: "vid-landing.png" },
    breath: 2.0,
  },
];

// ---------------------------------------------------------------------------
// 1. Narration
// ---------------------------------------------------------------------------

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}
function durationOf(file: string): number {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim());
}

console.log(`narrating ${SLIDES.length} slides with ${VOICE}`);
const durations: number[] = [];
for (let i = 0; i < SLIDES.length; i++) {
  const mp3 = join(AUDIO, `${String(i).padStart(2, "0")}.mp3`);
  if (!existsSync(mp3)) {
    run("python", ["-m", "edge_tts", "--voice", VOICE, "--rate=-4%", "--text", SLIDES[i]!.narration, "--write-media", mp3]);
  }
  const spoken = durationOf(mp3);
  const total = Math.max(4.5, spoken + (SLIDES[i]!.breath ?? 0.7));
  durations.push(total);
  console.log(`  ${String(i).padStart(2, "0")}  ${spoken.toFixed(1)}s spoken, ${total.toFixed(1)}s on screen`);
}
const LEAD = 0.8;
const totalSeconds = LEAD + durations.reduce((a, b) => a + b, 0);
console.log(`total ${Math.floor(totalSeconds / 60)}m ${Math.round(totalSeconds % 60)}s`);

// ---------------------------------------------------------------------------
// 2. The presenter
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const imageData = (file: string) => `data:image/png;base64,${readFileSync(join(WORK, file)).toString("base64")}`;

function visualHtml(v: Visual): string {
  switch (v.kind) {
    case "title":
      return `<div class="titlecard"><div class="mark"><span class="sq"></span><b>CRUCIBLE</b></div><div class="tag">SMART EXECUTION FOR BINANCE AGENTS</div></div>`;
    case "image":
      return `<div class="shot"><img src="${imageData(v.file)}" alt=""></div>`;
    case "terminal":
      return `<div class="term"><div class="bar"><span></span><span></span><span></span><em>${esc(v.title)}</em></div><pre class="type">${esc(v.text)}</pre></div>`;
    case "big":
      return `<div class="bignum"><div class="v">${esc(v.value)}</div><div class="l">${esc(v.label)}</div>${v.sub ? `<div class="s">${esc(v.sub)}</div>` : ""}</div>`;
    case "connect":
      return `<div class="term"><div class="bar"><span></span><span></span><span></span><em>connect</em></div><pre class="type">$ claude mcp add crucible --transport http https://${SITE}/mcp

quote · route · execute · reconcile · check_claim
policy · evidence · calibration · verify_ledger · status</pre></div>`;
  }
}

const slidesHtml = SLIDES.map(
  (s, i) => `<section class="slide" id="s${i}">
  <div class="left">
    <div class="kicker">${esc(s.kicker)}</div>
    <h1>${s.headline.map((l) => `<span>${esc(l)}</span>`).join("")}</h1>
    ${s.sub ? `<p class="sub">${esc(s.sub)}</p>` : ""}
  </div>
  <div class="right">${visualHtml(s.visual)}</div>
  <div class="caption"><span>${esc(s.narration)}</span></div>
</section>`,
).join("\n");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Crucible — demo</title>
<style>
:root{--bg:#07090f;--card:#0f131b;--raised:#131924;--line:#1a2130;--line-strong:#263042;--ink:#e5e7eb;--ink-2:#9ca3af;--ink-3:#6b7280;--yellow:#f0b90b;--cyan:#1fc7d4;--green:#3fb950;--red:#f85149;
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:var(--bg);color:var(--ink);font:400 22px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
body{background-image:linear-gradient(rgba(255,255,255,.028) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.028) 1px,transparent 1px);background-size:44px 44px}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(60% 50% at 20% 0%,rgba(240,185,11,.10),transparent 60%),radial-gradient(40% 40% at 85% 20%,rgba(31,199,212,.08),transparent 60%);pointer-events:none}
.slide{position:absolute;inset:0;display:grid;grid-template-columns:720px 1fr;gap:48px;align-items:center;padding:96px 112px 160px;opacity:0;transform:translateY(14px);transition:opacity .45s ease,transform .45s ease;pointer-events:none}
.slide.on{opacity:1;transform:none}
.kicker{font:600 15px/1 var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--yellow);margin-bottom:26px}
h1{margin:0 0 22px;font-size:54px;line-height:1.1;font-weight:800;letter-spacing:-.028em}
h1 span{display:block}
h1 span:nth-child(n+2){background:linear-gradient(90deg,var(--yellow) 0%,#7ee787 55%,var(--cyan) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
#s0 h1 span{color:var(--ink);background:none}
.sub{margin:0;font-size:22px;line-height:1.55;color:var(--ink-2);max-width:40ch}
.right{display:flex;align-items:center;justify-content:center;min-width:0}
.shot{border:1px solid var(--line-strong);border-radius:12px;overflow:hidden;box-shadow:0 40px 120px rgba(0,0,0,.6);background:#000}
.shot img{display:block;width:1000px;height:auto}
.term{width:1000px;background:var(--card);border:1px solid var(--line-strong);border-radius:12px;box-shadow:0 40px 120px rgba(0,0,0,.6);overflow:hidden}
.term .bar{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--raised)}
.term .bar span{width:11px;height:11px;border-radius:50%;background:var(--line-strong)}
.term .bar em{margin-left:10px;font:500 14px/1 var(--mono);color:var(--ink-3);font-style:normal}
.term pre{margin:0;padding:24px 26px;font:500 19px/1.55 var(--mono);color:var(--ink);white-space:pre-wrap;max-height:680px;overflow:hidden}
.term pre .hl{color:var(--green)}
.bignum{text-align:center}
.bignum .v{font:700 148px/1 var(--mono);letter-spacing:-.03em;color:var(--yellow)}
.bignum .l{margin-top:18px;font:600 15px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--ink-2)}
.bignum .s{margin-top:14px;font-size:20px;color:var(--ink-3)}
.titlecard{text-align:center}
.titlecard .mark{display:inline-flex;align-items:center;gap:22px}
.titlecard .sq{width:64px;height:64px;border-radius:12px;background:var(--yellow);position:relative}
.titlecard .sq::after{content:"";position:absolute;inset:18px;background:var(--bg);border-radius:6px}
.titlecard b{font-size:44px;letter-spacing:.3em;font-weight:800}
.titlecard .tag{margin-top:22px;font:600 15px/1 var(--mono);letter-spacing:.24em;color:var(--ink-3)}
.caption{position:absolute;left:112px;right:112px;bottom:92px;text-align:center}
.caption span{display:inline-block;background:rgba(15,19,27,.92);border:1px solid var(--line-strong);border-radius:8px;padding:12px 22px;font-size:24px;line-height:1.4;color:var(--ink);max-width:1400px}
.brand{position:fixed;left:112px;right:112px;bottom:38px;display:flex;align-items:center;gap:18px;font:600 13px/1 var(--mono);letter-spacing:.18em;text-transform:uppercase;color:var(--ink-3)}
.brand .sq{width:18px;height:18px;border-radius:4px;background:var(--yellow);position:relative}.brand .sq::after{content:"";position:absolute;inset:5px;background:var(--bg);border-radius:2px}
.brand b{color:var(--ink);letter-spacing:.24em}.brand .r{margin-left:auto;color:var(--yellow)}
.pre{position:absolute;inset:0;background:var(--bg);z-index:5;transition:opacity .5s ease}
</style></head><body>
<div class="pre" id="pre"></div>
${slidesHtml}
<div class="brand"><span class="sq"></span><b>CRUCIBLE</b><span>smart execution for Binance agents</span><span class="r">${SITE}</span></div>
<script>
(function(){
  var current=null;
  function typewrite(pre,total){
    var text=pre.textContent; pre.textContent="";
    var ms=Math.min(2200,total*0.45*1000); var i=0; var step=Math.max(1,Math.ceil(text.length/(ms/16)));
    (function tick(){ i+=step; pre.textContent=text.slice(0,i); if(i<text.length) requestAnimationFrame(tick); })();
  }
  window.show=function(i,seconds){
    document.getElementById("pre").style.opacity="0";
    if(current!==null) document.getElementById("s"+current).classList.remove("on");
    var s=document.getElementById("s"+i); s.classList.add("on"); current=i;
    var pre=s.querySelector("pre.type"); if(pre&&!pre.dataset.done){pre.dataset.done="1";typewrite(pre,seconds);}
  };
})();
</script></body></html>`;

const presenter = join(OUT, "presenter.html");
writeFileSync(presenter, html);
console.log(`presenter written: ${presenter}`);

// ---------------------------------------------------------------------------
// 3. Record
// ---------------------------------------------------------------------------

console.log("recording");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
await page.goto(pathToFileURL(presenter).href);
await page.waitForTimeout(LEAD * 1000);
for (let i = 0; i < SLIDES.length; i++) {
  await page.evaluate(([idx, secs]) => (window as unknown as { show: (i: number, s: number) => void }).show(idx as number, secs as number), [i, durations[i]!]);
  await page.waitForTimeout(durations[i]! * 1000);
}
const videoPath = await page.video()!.path();
await context.close();
await browser.close();
console.log(`recorded: ${videoPath}`);

// ---------------------------------------------------------------------------
// 4. Audio track, then mux
// ---------------------------------------------------------------------------

console.log("laying the narration over it");
const parts: string[] = [];
const lead = join(AUDIO, "lead.wav");
run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", String(LEAD), lead]);
parts.push(lead);
for (let i = 0; i < SLIDES.length; i++) {
  const mp3 = join(AUDIO, `${String(i).padStart(2, "0")}.mp3`);
  const wav = join(AUDIO, `${String(i).padStart(2, "0")}.wav`);
  run("ffmpeg", ["-y", "-v", "error", "-i", mp3, "-af", `apad=whole_dur=${durations[i]}`, "-t", String(durations[i]), "-ar", "48000", "-ac", "2", wav]);
  parts.push(wav);
}
const list = join(AUDIO, "list.txt");
writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
const track = join(OUT, "track.wav");
run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", track]);

const final = join(OUT, "crucible-demo.mp4");
run("ffmpeg", [
  "-y", "-v", "error",
  "-i", videoPath, "-i", track,
  "-map", "0:v:0", "-map", "1:a:0",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "160k",
  "-shortest", "-movflags", "+faststart",
  final,
]);
const finalDuration = durationOf(final);
console.log(`done: ${final}  (${Math.floor(finalDuration / 60)}m ${Math.round(finalDuration % 60)}s, 1920x1080, H.264 + AAC)`);

const keep = join(process.cwd(), "demo", "video", "crucible-demo.mp4");
copyFileSync(final, keep);
console.log(`copied to ${keep}`);
