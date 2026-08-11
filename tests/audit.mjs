// Layout audit for index.html.
//
// Re-uses the page's own data and geometry functions -- sliced straight out of
// the HTML and evaluated -- so the audit cannot drift from what the browser
// actually renders. Checks the things a colour validator cannot see: overlapping
// boxes, labels wider than their box, edges cutting through unrelated
// components, and edges stacked on the same anchor point.
//
// Run: node tests/audit.mjs [--snapshot]
// With --snapshot it also writes build/snap-{light,dark}.svg, which is handy for
// eyeballing the layout without a browser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d3 from "d3";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML = path.join(ROOT, "index.html");
const src = fs.readFileSync(HTML, "utf8");

/* ---- pull the data + geometry section out of the page ------------------- */

const START = "const H = 54;";
const END = 'const svg = d3.select("#svg");';
const i0 = src.indexOf(START);
const i1 = src.indexOf(END);
if (i0 < 0 || i1 < 0) {
  console.error("audit: could not locate the data/geometry section in index.html.");
  console.error("If you renamed the H constant or the render entry point, update START/END here.");
  process.exit(2);
}

const windowStub = { matchMedia: () => ({ matches: false, addEventListener() {} }) };
const exported = new Function("d3", "window", src.slice(i0, i1) + `
  return { CATEGORIES, LANES, NODES, EDGES, FLOWS, byId, PATH_LABEL, box, points, polyline };
`)(d3, windowStub);

const { CATEGORIES, LANES, NODES, EDGES, FLOWS, byId, PATH_LABEL, box, points, polyline } = exported;

const VIEW = (() => {
  const m = src.match(/viewBox="0 0 (\d+) (\d+)"/);
  return { w: Number(m[1]), h: Number(m[2]) };
})();

/* ---- checks ------------------------------------------------------------- */

const problems = [];
const warn = (kind, msg) => problems.push({ kind, msg });

// 1. component boxes must not overlap one another
for (let i = 0; i < NODES.length; i++) {
  for (let j = i + 1; j < NODES.length; j++) {
    const a = box(NODES[i]);
    const b = box(NODES[j]);
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ox > 0 && oy > 0) {
      warn("node-overlap",
        `${NODES[i].id} overlaps ${NODES[j].id} by ${ox.toFixed(0)}x${oy.toFixed(0)}px`);
    }
  }
}

// 2. nothing may escape the viewBox
for (const n of NODES) {
  const b = box(n);
  if (b.x0 < 0 || b.y0 < 0 || b.x1 > VIEW.w || b.y1 > VIEW.h) {
    warn("out-of-bounds",
      `${n.id} box (${b.x0},${b.y0})-(${b.x1},${b.y1}) escapes the ${VIEW.w}x${VIEW.h} viewBox`);
  }
}

// 3. labels must fit inside their box.
// system-ui at weight 600 averages ~0.55em per glyph; 0.58 is a safe bound.
const textW = (s, px) => s.length * px * 0.58;
for (const n of NODES) {
  const need = textW(n.label, 13.5) + 22;
  if (need > n.w) {
    warn("label-overflow",
      `${n.id} label "${n.label}" needs ~${need.toFixed(0)}px, box is ${n.w}px`);
  }
  if (n.sub) {
    const needSub = textW(n.sub, 10.5) + 18;
    if (needSub > n.w) {
      warn("label-overflow",
        `${n.id} sub "${n.sub}" needs ~${needSub.toFixed(0)}px, box is ${n.w}px`);
    }
  }
}

// 4. an edge must not run through a component it does not terminate on.
// Ring lines are exempt: they are thin, neutral, and free to cross, matching the
// convention in Cortex's own architecture diagram.
function segHitsBox(p, q, b, pad = 3) {
  const steps = Math.max(2, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / 3));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = p[0] + (q[0] - p[0]) * t;
    const y = p[1] + (q[1] - p[1]) * t;
    if (x > b.x0 + pad && x < b.x1 - pad && y > b.y0 + pad && y < b.y1 - pad) return [x, y];
  }
  return null;
}

for (const e of EDGES) {
  const pts = points(e);
  for (const n of NODES) {
    if (n.id === e.from || n.id === e.to) continue;
    // Straight ring lines are checked too: one passing through a box reads as a
    // connection that does not exist.
    const b = box(n);
    let hit = null;
    for (let k = 0; k < pts.length - 1 && !hit; k++) hit = segHitsBox(pts[k], pts[k + 1], b);
    if (hit) {
      warn("edge-through-node",
        `${e.id} passes through ${n.id} near (${hit[0].toFixed(0)},${hit[1].toFixed(0)})`);
    }
  }
}

// 5. two edges sharing an anchor point overlap, unless the modes make them
// mutually exclusive (v1 vs v2 queue, ruler's two evaluation modes).
const anchors = new Map();
for (const e of EDGES) {
  if (e.straight) continue;
  const pts = points(e);
  for (const [end, p] of [["from", pts[0]], ["to", pts[pts.length - 1]]]) {
    const key = `${e[end]}@${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    if (!anchors.has(key)) anchors.set(key, []);
    anchors.get(key).push(e.id + ":" + end);
  }
}
for (const [key, users] of anchors) {
  if (users.length < 2) continue;
  const gates = users.map(u => {
    const e = EDGES.find(x => x.id === u.split(":")[0]);
    if (e.mode) return ["mode", e.mode];
    if (e.rulerMode) return ["rulerMode", e.rulerMode];
    if (e.parquet) return ["parquet", e.parquet];
    return ["ungated", "ungated"];
  });
  // Sharing an anchor is only safe when every edge is gated on the *same*
  // dimension with a *different* value, so at most one is ever drawn. Two edges
  // gated on different dimensions (say frontend v1 and config store configdb)
  // can both be visible at once, and would overlap.
  const dims = new Set(gates.map(g => g[0]));
  const vals = new Set(gates.map(g => g[1]));
  const exclusive = dims.size === 1 && !dims.has("ungated") && vals.size === gates.length;
  if (!exclusive) warn("anchor-collision", `${key} shared by ${users.join(", ")}`);
}

// 5b. two edges must not share a colinear overlapping run. Where several
// connectors converge on one column, it is easy to route two of them down the
// same corridor, and one is then invisible underneath the other.
function segments(e) {
  const pts = points(e);
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 1) {
      out.push({ dir: "v", at: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) });
    } else if (Math.abs(y1 - y2) < 0.5 && Math.abs(x1 - x2) > 1) {
      out.push({ dir: "h", at: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
    }
  }
  return out;
}
const canCoexist = (a, b) => {
  // Two edges can only overlap in practice if some mode combination shows both.
  for (const k of ["mode", "rulerMode", "parquet"]) {
    if (a[k] && b[k] && a[k] !== b[k]) return false;
  }
  return true;
};
const segCache = EDGES.map(e => ({ e, segs: segments(e) }));
for (let i = 0; i < segCache.length; i++) {
  for (let j = i + 1; j < segCache.length; j++) {
    const A = segCache[i], B = segCache[j];
    if (!canCoexist(A.e, B.e)) continue;
    for (const s of A.segs) {
      for (const t of B.segs) {
        if (s.dir !== t.dir || Math.abs(s.at - t.at) > 0.5) continue;
        const overlap = Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo);
        if (overlap > 6) {
          warn("colinear-overlap",
            `${A.e.id} and ${B.e.id} share a ${overlap.toFixed(0)}px ${s.dir === "v" ? "vertical" : "horizontal"} run at ${s.at.toFixed(0)}`);
        }
      }
    }
  }
}

// 6. referential integrity, and every panel field populated
for (const e of EDGES) {
  if (!byId.has(e.from)) warn("bad-ref", `${e.id} unknown from=${e.from}`);
  if (!byId.has(e.to)) warn("bad-ref", `${e.id} unknown to=${e.to}`);
  if (!e.protocol || !e.endpoint || !e.note) warn("missing-meta", `${e.id} incomplete metadata`);
  if (!PATH_LABEL[e.path]) warn("bad-ref", `${e.id} unknown path=${e.path}`);
}
for (const n of NODES) {
  if (!CATEGORIES[n.cat]) warn("bad-ref", `${n.id} unknown cat=${n.cat}`);
  if (!n.role) warn("missing-meta", `${n.id} has no role text`);
}
const ids = new Set(NODES.map(n => n.id));
if (ids.size !== NODES.length) warn("bad-ref", "duplicate node id");
const eids = new Set(EDGES.map(e => e.id));
if (eids.size !== EDGES.length) warn("bad-ref", "duplicate edge id");

// 7. every flow step resolves, under every combination of modes
for (const f of FLOWS) {
  for (const feMode of ["v1", "v2"]) {
    for (const rulerMode of ["own", "frontend"]) {
      for (const [eid, text] of f.steps({ feMode, rulerMode })) {
        if (!eids.has(eid)) {
          warn("bad-ref", `flow ${f.id} (${feMode}/${rulerMode}) references unknown edge ${eid}`);
        }
        if (!text || text.length < 20) {
          warn("missing-meta", `flow ${f.id} step ${eid} has no usable narration`);
        }
      }
    }
  }
}

// 7b. a flow step must reference an edge that is actually visible in the mode
// combination that produced it -- otherwise the narration points at nothing.
for (const f of FLOWS) {
  for (const feMode of ["v1", "v2"]) {
    for (const rulerMode of ["own", "frontend"]) {
      for (const [eid] of f.steps({ feMode, rulerMode })) {
        const e = EDGES.find(x => x.id === eid);
        if (!e) continue;
        const gated =
          (e.mode && e.mode !== feMode) ||
          (e.rulerMode && e.rulerMode !== rulerMode) ||
          (e.parquet && e.parquet !== "off");
        if (gated) {
          warn("flow-gated",
            `flow ${f.id} in ${feMode}/${rulerMode} narrates ${eid}, which those modes hide`);
        }
      }
    }
  }
}

// 8. lane containment
for (const n of NODES) {
  const b = box(n);
  const inside = LANES.some(l =>
    b.x0 >= l.x0 - 1 && b.x1 <= l.x1 + 1 && b.y0 >= l.y0 - 1 && b.y1 <= l.y1 + 1);
  if (!inside) warn("lane", `${n.id} is not fully inside any lane`);
}

// 9. the SRI hash in the page must match the pinned d3 we test against, or the
// browser will refuse to run the script we just validated.
try {
  const tag = src.match(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/d3@([\d.]+)\/dist\/d3\.min\.js"\s+integrity="(sha384-[^"]+)"/);
  if (!tag) {
    warn("integrity", "could not find the pinned d3 script tag with an integrity attribute");
  } else {
    const [, pinned, integrity] = tag;
    const local = JSON.parse(
      fs.readFileSync(path.join(ROOT, "node_modules/d3/package.json"), "utf8")).version;
    if (local !== pinned) {
      warn("integrity", `page pins d3@${pinned} but node_modules has d3@${local}`);
    } else {
      const { createHash } = await import("node:crypto");
      const bytes = fs.readFileSync(path.join(ROOT, "node_modules/d3/dist/d3.min.js"));
      const actual = "sha384-" + createHash("sha384").update(bytes).digest("base64");
      if (actual !== integrity) {
        warn("integrity",
          `SRI mismatch for d3@${pinned}\n      page:  ${integrity}\n      local: ${actual}`);
      }
    }
  }
} catch (err) {
  warn("integrity", "could not verify the d3 SRI hash: " + err.message);
}

// 10. the lockfile must not leak a private registry into a public repo.
try {
  const lock = fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8");
  const hosts = [...lock.matchAll(/"resolved":\s*"https?:\/\/([^/"]+)/g)]
    .map(m => m[1])
    .filter(h => h !== "registry.npmjs.org");
  if (hosts.length) {
    warn("registry", `package-lock.json resolves from non-public registries: ${[...new Set(hosts)].join(", ")}`);
  }
} catch {
  warn("registry", "package-lock.json is missing -- run `npm install`");
}

/* ---- optional snapshot -------------------------------------------------- */

if (process.argv.includes("--snapshot")) {
  const THEMES = {
    light: { surface: "#fcfcfb", text: "#0b0b0b", sub: "#898781", rule: "#c3c2b7",
             lane: "rgba(11,11,11,0.022)", write: "#eb6834", read: "#2a78d6",
             blocks: "#1baf7a", ring: "#898781" },
    dark: { surface: "#1a1a19", text: "#ffffff", sub: "#898781", rule: "#383835",
            lane: "rgba(255,255,255,0.035)", write: "#d95926", read: "#3987e5",
            blocks: "#199e70", ring: "#898781" },
  };
  const xml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const snapshot = t => {
    const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW.w} ${VIEW.h}" width="${VIEW.w}" height="${VIEW.h}">`];
    o.push(`<rect width="${VIEW.w}" height="${VIEW.h}" fill="${t.surface}"/>`, "<defs>");
    for (const k of ["write", "read", "blocks", "ring"]) {
      const s = k === "ring" ? 5 : 5.5;
      o.push(`<marker id="a-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="${s}" markerHeight="${s}" orient="auto-start-reverse"><path d="M 0 1.2 L 9 5 L 0 8.8 z" fill="${t[k]}"/></marker>`);
    }
    o.push("</defs>");
    for (const l of LANES) {
      o.push(`<rect x="${l.x0}" y="${l.y0}" width="${l.x1 - l.x0}" height="${l.y1 - l.y0}" rx="12" fill="${t.lane}"/>`);
      o.push(`<text x="${l.x0 + 12}" y="${l.inside ? l.y1 - 9 : l.y0 - 9}" fill="${t.sub}" font-family="system-ui" font-size="10.5" font-weight="600" letter-spacing="0.8">${xml(l.label.toUpperCase())}</text>`);
    }
    for (const e of EDGES) {
      // Snapshot the page's default modes, so the image matches a fresh load.
      if (e.mode && e.mode !== "v2") continue;
      if (e.rulerMode && e.rulerMode !== "own") continue;
      if (e.parquet && e.parquet !== "off") continue;
      o.push(`<path d="${polyline(points(e))}" fill="none" stroke="${t[e.path]}" stroke-width="${e.path === "ring" ? 1 : 2}" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#a-${e.path})"/>`);
    }
    for (const n of NODES) {
      const b = box(n);
      const dash = n.optional ? ' stroke-dasharray="5 3.5"' : "";
      const stroke = CATEGORIES[n.cat].hued ? t[n.cat] : t.rule;
      o.push(`<rect x="${b.x0}" y="${b.y0}" width="${n.w}" height="${n.h}" rx="8" fill="${t.surface}" stroke="${stroke}" stroke-width="1.25"${dash}/>`);
      o.push(`<text x="${n.x}" y="${n.y + (n.sub ? -3 : 5)}" text-anchor="middle" fill="${t.text}" font-family="system-ui" font-size="13.5" font-weight="600">${xml(n.label)}</text>`);
      if (n.sub) o.push(`<text x="${n.x}" y="${n.y + 13}" text-anchor="middle" fill="${t.sub}" font-family="system-ui" font-size="10.5">${xml(n.sub)}</text>`);
      if (n.optional || n.beyondDocs) {
        o.push(`<text x="${b.x1 - 7}" y="${b.y0 + 12}" text-anchor="end" fill="${t.sub}" font-family="system-ui" font-size="9" font-weight="700">${n.beyondDocs ? "EXPERIMENTAL" : "OPTIONAL"}</text>`);
      }
    }
    o.push("</svg>");
    return o.join("\n");
  };

  fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
  for (const [name, t] of Object.entries(THEMES)) {
    fs.writeFileSync(path.join(ROOT, "build", `snap-${name}.svg`), snapshot(t));
  }
  console.log("wrote build/snap-light.svg and build/snap-dark.svg");
}

/* ---- report ------------------------------------------------------------- */

const counts = EDGES.reduce((a, e) => ((a[e.path] = (a[e.path] || 0) + 1), a), {});
console.log(`audit: ${NODES.length} components, ${EDGES.length} connections ` +
            `(${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}), ` +
            `${FLOWS.length} flows, viewBox ${VIEW.w}x${VIEW.h}`);

if (!problems.length) {
  console.log("audit: clean");
  process.exit(0);
}

const grouped = problems.reduce((a, p) => ((a[p.kind] = a[p.kind] || []).push(p.msg), a), {});
console.error(`\naudit: ${problems.length} finding(s)`);
for (const [kind, msgs] of Object.entries(grouped)) {
  console.error(`\n[${kind}] ${msgs.length}`);
  for (const m of msgs) console.error("   " + m);
}
process.exit(1);
