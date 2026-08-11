// Interaction tests for index.html.
//
// Loads the real page in jsdom, runs the real render code, then drives every
// control and asserts the DOM actually changed. This is the layer that catches
// what a static audit cannot: broken selections, a filter that recolours instead
// of dimming, a mode toggle that hides the wrong edges, a flow that dead-ends.
//
// Run: node tests/smoke.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const d3src = fs.readFileSync(path.join(ROOT, "node_modules/d3/dist/d3.min.js"), "utf8");

// Swap the CDN tag for the local copy so the tests need no network. A function
// replacer is required: d3.min.js contains $ sequences that would otherwise be
// interpreted as replacement patterns.
const page = html.replace(
  /<script src="https:\/\/cdn\.jsdelivr\.net[^>]*><\/script>/,
  () => "<script>" + d3src + "<\/script>"
);
if (page === html) {
  console.error("smoke: could not find the d3 CDN script tag to substitute");
  process.exit(2);
}

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", e => errors.push("jsdomError: " + (e.message || e)));
virtualConsole.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(page, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(w) {
    // jsdom implements neither of these; the page uses matchMedia for the theme
    // and reduced-motion checks, and the path geometry APIs for the flow dots.
    w.matchMedia = () => ({
      matches: false, media: "",
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    });
  },
});

const { window } = dom;
const { document } = window;
const proto = window.SVGElement.prototype;
if (!proto.getTotalLength) proto.getTotalLength = () => 100;
if (!proto.getPointAtLength) proto.getPointAtLength = () => ({ x: 0, y: 0 });

const checks = [];
const ok = (name, cond, extra = "") => checks.push({ name, pass: !!cond, extra });
const q = sel => document.querySelectorAll(sel);
const one = sel => document.querySelector(sel);
const click = el => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const hover = el => el.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: false }));
const cls = sel => one(sel).getAttribute("class") || "";
const shown = id => one(`g.edge[data-id="${id}"]`).getAttribute("display") !== "none";

// Expected counts come from the page's own arrays rather than being hard-coded,
// so adding a component does not fail the suite for the wrong reason. Top-level
// `const` in a classic script lives in the global lexical scope, not on window,
// so it has to be reached through eval.
const NODE_COUNT = window.eval("NODES.length");
const EDGE_COUNT = window.eval("EDGES.length");

await new Promise(r => setTimeout(r, 300));

/* ---- initial render ----------------------------------------------------- */
ok("page loads with no script errors", errors.length === 0, errors.join(" | "));
ok("every component in the data is rendered",
  q("g.node").length === NODE_COUNT && NODE_COUNT > 0,
  `dom=${q("g.node").length} data=${NODE_COUNT}`);
ok("every connection in the data is rendered",
  q("g.edge").length === EDGE_COUNT && EDGE_COUNT > 0,
  `dom=${q("g.edge").length} data=${EDGE_COUNT}`);
ok("lanes rendered", q("g.lane").length > 0);
ok("one arrow marker per path type", q("marker").length === 4, `got ${q("marker").length}`);
ok("every connection has a hit target", q("g.edge path.hit").length === q("g.edge").length);
ok("every connection has an arrowhead",
  [...q("g.edge path.line")].every(p => (p.getAttribute("marker-end") || "").startsWith("url(#arrow-")));
ok("no NaN in any path geometry",
  ![...q("path")].some(p => (p.getAttribute("d") || "").includes("NaN")));

// var() is not reliably supported in SVG presentation attributes, so colour must
// come from CSS classes -- otherwise the theme toggle silently does nothing.
ok("no var() in SVG presentation attributes",
  ![...q("#svg *")].some(e =>
    (e.getAttribute("stroke") || "").includes("var(") ||
    (e.getAttribute("fill") || "").includes("var(")));
ok("category carried by class",
  q("g.node.cat-write").length > 0 && q("g.node.cat-read").length > 0 && q("g.node.cat-blocks").length > 0);

/* ---- accessibility ------------------------------------------------------ */
ok("every component is keyboard focusable",
  [...q("g.node")].every(n => n.getAttribute("tabindex") === "0"));
ok("every component has an accessible label",
  [...q("g.node")].every(n => (n.getAttribute("aria-label") || "").length > 12));
ok("diagram has a role and label",
  one("#svg").getAttribute("role") === "img" && !!one("#svg").getAttribute("aria-label"));
ok("legend is always present", q("#legend .item").length >= 7, `got ${q("#legend .item").length}`);

/* ---- table view: the contrast relief channel ---------------------------- */
ok("every component has a table row", q("#t-nodes tbody tr").length === q("g.node").length);
ok("every connection has a table row", q("#t-edges tbody tr").length === q("g.edge").length);
ok("no empty table cells",
  ![...q("#t-nodes td, #t-edges td")].some(td => !td.textContent.trim()));
ok("table view starts hidden", one("#tables").hidden === true);
const tableBtn = one("#toggle-table");
click(tableBtn);
ok("table view toggles on",
  one("#tables").hidden === false && tableBtn.getAttribute("aria-pressed") === "true");
click(tableBtn);
ok("table view toggles off",
  one("#tables").hidden === true && tableBtn.getAttribute("aria-pressed") === "false");

/* ---- theme -------------------------------------------------------------- */
const themeBtn = one("#toggle-theme");
click(themeBtn);
ok("theme toggle stamps dark and relabels",
  document.documentElement.getAttribute("data-theme") === "dark" && themeBtn.textContent === "Light mode",
  themeBtn.textContent);
click(themeBtn);
ok("theme toggle stamps light",
  document.documentElement.getAttribute("data-theme") === "light");

/* ---- filters dim, never recolour ---------------------------------------- */
const hueBefore = [...q("g.node")].map(n => (n.getAttribute("class").match(/cat-\w+/) || [""])[0]);
const readFilter = [...q("#filters button")].find(b => b.textContent.includes("Read path"));
const readTotal = q("g.edge.read").length;
click(readFilter);
ok("unchecking a filter hides that path",
  [...q("g.edge.read")].filter(e => e.getAttribute("display") === "none").length === readTotal);
ok("filter state is exposed to assistive tech",
  readFilter.getAttribute("aria-pressed") === "false");
const hueAfter = [...q("g.node")].map(n => (n.getAttribute("class").match(/cat-\w+/) || [""])[0]);
ok("filtering never recolours the survivors",
  JSON.stringify(hueBefore) === JSON.stringify(hueAfter));
click(readFilter);
// Everything comes back except what the current modes gate off.
const stillHidden = [...q("g.edge.read")]
  .filter(e => e.getAttribute("display") === "none").map(e => e.dataset.id).sort();
ok("re-checking restores all but the mode-gated edges",
  JSON.stringify(stillHidden) === JSON.stringify(["qf>qr", "ruler>qf"]), stillHidden.join(","));

/* ---- queue mode swaps the topology -------------------------------------- */
click([...q("#fe-mode button")].find(b => b.dataset.mode === "v1"));
ok("frontend-queue mode hides the scheduler hops", !shown("qf>sched") && !shown("sched>qr"));
ok("frontend-queue mode shows the direct frontend hop", shown("qf>qr"));
ok("frontend-queue mode dims the query-scheduler",
  cls('g.node[data-id="query-scheduler"]').includes("dim"));
click([...q("#fe-mode button")].find(b => b.dataset.mode === "v2"));
ok("scheduler mode restores the scheduler hops", shown("qf>sched") && shown("sched>qr"));
ok("scheduler mode hides the direct frontend hop", !shown("qf>qr"));
ok("scheduler mode undims the query-scheduler",
  !cls('g.node[data-id="query-scheduler"]').includes("dim"));

/* ---- ruler evaluation mode ---------------------------------------------- */
click([...q("#ruler-mode button")].find(b => b.dataset.mode === "frontend"));
ok("ruler-via-frontend hides the own-stack reads", !shown("ruler>ing") && !shown("ruler>sg"));
ok("ruler-via-frontend shows the frontend hop", shown("ruler>qf"));
click([...q("#ruler-mode button")].find(b => b.dataset.mode === "own"));
ok("own-stack mode restores the direct reads", shown("ruler>ing") && shown("ruler>sg"));
ok("own-stack mode hides the frontend hop", !shown("ruler>qf"));

/* ---- caches ------------------------------------------------------------- */
// Seven caches, deliberately not one box: their consumer sets all differ.
for (const id of ["results-cache", "metadata-cache", "chunks-cache", "index-cache",
                  "parquet-labels-cache", "parquet-rows-cache", "epc"]) {
  ok(`${id} is its own component`, !!one(`g.node[data-id="${id}"]`));
}
ok("the metadata cache has all three consumers wired",
  shown("qr>metadata") && shown("sg>metadata") && shown("comp>metadata"));
ok("the chunks cache has both consumers wired",
  shown("qr>chunks") && shown("sg>chunks"));
ok("the index cache has exactly one consumer",
  shown("sg>index") &&
  [...q("g.edge")].filter(e => e.dataset.id.endsWith(">index")).length === 1);
ok("the results cache belongs to the query-frontend only", shown("qf>rcache"));
// The expanded postings cache is in-process in the ingester, so it must not be
// drawn in the cache column with a network hop implied.
const epc = one('g.node[data-id="epc"] rect');
ok("expanded postings sits beside the ingester, not in the cache column",
  Number(epc.getAttribute("x")) < 600, `x=${epc.getAttribute("x")}`);
ok("expanded postings is fed by the ingester", shown("ing>epc"));

/* ---- parquet queryable toggle ------------------------------------------- */
ok("parquet caches are hidden by default",
  !shown("qr>plabels") && !shown("qr>prows") && !shown("sg>plabels") && !shown("sg>prows"));
ok("parquet components recede by default",
  cls('g.node[data-id="parquet-labels-cache"]').includes("dim") &&
  cls('g.node[data-id="parquet-rows-cache"]').includes("dim") &&
  cls('g.node[data-id="parquet"]').includes("dim"));
click([...q("#parquet-mode button")].find(b => b.dataset.mode === "on"));
ok("enabling parquet wires both caches to both consumers",
  shown("qr>plabels") && shown("qr>prows") && shown("sg>plabels") && shown("sg>prows"));
ok("enabling parquet lights up the converter and its caches",
  !cls('g.node[data-id="parquet-labels-cache"]').includes("dim") &&
  !cls('g.node[data-id="parquet"]').includes("dim") && shown("pq>obj"));
click([...q("#parquet-mode button")].find(b => b.dataset.mode === "off"));
ok("disabling parquet hides them again",
  !shown("qr>plabels") && !shown("pq>obj"));

/* ---- selection panel ---------------------------------------------------- */
const panel = one("#panel");
const ing = one('g.node[data-id="ingester"]');
click(ing);
ok("selecting marks the component", cls('g.node[data-id="ingester"]').includes("selected"));
ok("panel names the component", panel.textContent.includes("Ingester"));
ok("panel states statefulness", panel.textContent.includes("semi-stateful"));
ok("panel states the ring prefix", panel.textContent.includes("collectors/"));
ok("panel states the source file", panel.textContent.includes("pkg/ingester/ingester.go"));
ok("panel states the target flag", panel.textContent.includes("-target=ingester"));
ok("panel links to the upstream docs", !!panel.querySelector('a[href*="cortexmetrics.io"]'));
ok("selecting dims unrelated components", cls('g.node[data-id="alertmanager"]').includes("dim"));
ok("selecting keeps neighbours lit", !cls('g.node[data-id="distributor"]').includes("dim"));
click(ing);
ok("clicking again deselects", !cls('g.node[data-id="ingester"]').includes("selected"));

const panelFails = [];
for (const n of q("g.node")) {
  click(n);
  const label = n.getAttribute("aria-label").split(".")[0];
  if (!panel.textContent.includes(label)) panelFails.push(n.dataset.id);
  click(n);
}
ok("every component renders a panel naming it", panelFails.length === 0, panelFails.join(","));

/* ---- connector hover ---------------------------------------------------- */
hover(one('g.edge[data-id="dist>ing"] path.hit'));
ok("hovering states the protocol", panel.textContent.includes("gRPC"));
ok("hovering states the endpoint", panel.textContent.includes("Ingester.Push"));
ok("hovering names both ends",
  panel.textContent.includes("Distributor") && panel.textContent.includes("Ingester"));

const edgeFails = [];
for (const hit of q("g.edge path.hit")) {
  const id = hit.parentNode.dataset.id;
  try {
    hover(hit);
    if (!panel.textContent.trim()) edgeFails.push(id);
  } catch (e) {
    edgeFails.push(`${id}:${e.message}`);
  }
}
ok("every connector renders a hover panel", edgeFails.length === 0, edgeFails.join(","));

/* ---- guided flows ------------------------------------------------------- */
const flowBtns = [...q("#flows button.flow")];
ok("flows are offered", flowBtns.length >= 3, `got ${flowBtns.length}`);
const flowFails = [];
for (const btn of flowBtns) {
  const name = btn.textContent;
  click(btn);
  if (!q("#flows button.nav").length) flowFails.push(`${name}:no-nav`);
  const next = [...q("#flows button.nav")].find(b => b.textContent.includes("Next"));
  for (let i = 0; i < 10; i++) {
    if (!/step \d+ of \d+/.test(panel.textContent)) { flowFails.push(`${name}:no-step@${i}`); break; }
    click(next);
  }
  click(btn);
  if (q("#flows button.nav").length) flowFails.push(`${name}:nav-stuck`);
}
ok("every flow steps through and back round", flowFails.length === 0, flowFails.join(" | "));

// A walkthrough must override the filter row: otherwise a step narrates an edge
// the reader has hidden and the diagram disagrees with its own caption.
click([...q("#filters button")].find(b => b.textContent.includes("Ring & control")));
click(flowBtns.find(b => b.textContent.includes("Rule evaluation")));
ok("a flow overrides the filters for its own edges", shown("ruler>kv"));

ok("no script errors after driving every control", errors.length === 0, errors.join(" | "));

/* ---- report ------------------------------------------------------------- */
const failed = checks.filter(c => !c.pass);
for (const c of checks) {
  console.log(`${c.pass ? "  ok  " : "  FAIL"} ${c.name}${c.extra ? "  [" + c.extra + "]" : ""}`);
}
console.log(`\nsmoke: ${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
