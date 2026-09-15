#!/usr/bin/env node
// Static prerender build + verification tool for the dc-runtime sites
// (georgeee.com, yak.ad). Config-driven; nothing site-specific lives here.
//
// Usage:
//   node build-static.mjs build  <config.json> [--pages-only]
//   node build-static.mjs verify <config.json>
//
// `build` hydrates each screen of the source dc page in headless Chromium,
// materializes CSSOM-injected stylesheets (the scp hover sheet) into their
// <style> textContent, rewrites hash navigation into real routes (own route
// table first, then a `foreign` base+routes table for hashes living on
// another domain), strips the runtime (support.js, React, the text/x-dc
// script, data-dc-tpl attrs), and emits a fully static tree with per-route head metadata, sitemap, robots.txt,
// a styled 404, and the authoring source under src/.
//
// `verify` re-serves the source and the emitted tree and runs the acceptance
// checks: no-JS render (via the CDP DOM/CSS domains — page JS is disabled, so
// Runtime.evaluate is unavailable), hover regression, full-page pixel diff at
// desktop and mobile widths, text-content equality, debris scan, link
// resolution, network audit, and byte sizes.
//
// Run inside the nix shell that provides chromium + node (and imagemagick for
// `verify`): see static.sh.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";

const MODE = process.argv[2];
const CFG_PATH = path.resolve(process.argv[3]);
const PAGES_ONLY = process.argv.includes("--pages-only");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- config ---

function loadConfig(cfgPath) {
  const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const base = path.dirname(cfgPath);
  const abs = (p) => path.resolve(base, p);
  return {
    ...raw,
    _raw: raw,
    siteDir: abs(raw.siteDir),
    outDir: abs(raw.outDir),
    // copyFiles sources resolve now, against the config's directory
    copyFiles: raw.copyFiles
      ? Object.fromEntries(Object.entries(raw.copyFiles).map(([k, v]) => [k, abs(v)]))
      : undefined,
  };
}

// Routes emit extensionless files (/about -> about.html), not directories.
// GitHub Pages resolves a request for /about to about.html, so the served URL
// carries no trailing slash. Verified against the live host before adopting.
function routeToFile(route) {
  if (route === "/") return "index.html";
  return route.replace(/^\/+/, "").replace(/\/+$/, "") + ".html";
}

// ------------------------------------------------------------------ http ---

// Static server with an ordered list of roots: first root that has the file
// wins. Used to serve the dc page together with its assets (and, in
// --pages-only mode, to overlay src/ on top of the emitted tree).
function startServer(roots) {
  const MIME = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon",
    ".json": "application/json", ".xml": "application/xml", ".txt": "text/plain",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  };
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); }
    catch { res.writeHead(400).end("bad url"); return; }
    if (p.endsWith("/")) p += "index.html";
    const tryRoots = Array.isArray(roots) ? roots : [roots];
    // Mirror GitHub Pages: an extensionless request also resolves to <p>.html,
    // so local verification exercises the same URLs visitors will.
    const candidates = path.extname(p) ? [p] : [p, p + ".html"];
    const found = tryRoots
      .flatMap((root) => candidates.map((c) => path.normalize(path.join(root, c))))
      .find((f) => f.startsWith(path.normalize(tryRoots[0])) && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!found) { res.writeHead(404, { "Content-Type": "text/plain" }).end("404 " + p); return; }
    fs.readFile(found, (err, data) => {
      if (err) { res.writeHead(404).end("404"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(found).toLowerCase()] || "application/octet-stream" });
      res.end(data);
    });
  });
  const portP = new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server.address().port)));
  return { port: portP, close: () => new Promise((ok) => server.close(ok)) };
}

// -------------------------------------------------------------- chromium ---

async function launchChromium() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dc-static-"));
  const chrome = spawn("chromium", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--window-size=1440,1000", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((ok, fail) => {
    let acc = "";
    const t = setTimeout(() => fail(new Error("chromium gave no DevTools endpoint: " + acc)), 30000);
    chrome.stderr.on("data", (d) => {
      acc += d.toString();
      const m = acc.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); ok(m[1]); }
    });
    chrome.on("exit", (c) => fail(new Error(`chromium exited ${c}: ${acc}`)));
  });
  // Chromium 153 removed browser-socket flat sessions; each tab is now its own
  // page WebSocket, reached over the DevTools HTTP endpoint.
  const httpPort = new URL(wsUrl).port;
  return {
    httpPort,
    async close() {
      chrome.kill("SIGKILL");
      // chromium's helpers can still be flushing files into the profile as we
      // tear down — retry the removal instead of failing the run on ENOTEMPTY
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch (e) {
        console.log("[cleanup] profile dir left behind:", profile, "—", String(e).slice(0, 120));
      }
    },
  };
}

// One browser tab: a direct page WebSocket. Tracks its own network/console
// traffic. close() releases the tab.
async function openTab(chrome, { url, viewport, js = true }) {
  const tabInfo = await (await fetch(`http://127.0.0.1:${chrome.httpPort}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(tabInfo.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(typeof e.data === "string" ? e.data : String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const S = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++msgId;
    pending.set(id, (m) => m.error ? fail(new Error(method + ": " + JSON.stringify(m.error))) : ok(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const tab = {
    targetId: tabInfo.id, S,
    net: [], consoleLines: [], seenReq: new Map(),
    recordEvents() {
      for (const m of events.splice(0)) {
        const { method, params } = m;
        if (method === "Network.requestWillBeSent") {
          this.seenReq.set(params.requestId, params.request.url);
          this.net.push({ phase: "request", url: params.request.url, type: params.type || "" });
        } else if (method === "Network.responseReceived") {
          this.net.push({ phase: "response", url: params.response.url, status: params.response.status });
        } else if (method === "Network.loadingFailed") {
          this.net.push({ phase: "failed", url: this.seenReq.get(params.requestId) || "?", error: params.errorText });
        } else if (method === "Runtime.consoleAPICalled") {
          this.consoleLines.push(`[console.${params.type}] ` + params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
        } else if (method === "Runtime.exceptionThrown") {
          this.consoleLines.push(`[exception] ${params.exceptionDetails.text}`);
        } else if (method === "Log.entryAdded") {
          this.consoleLines.push(`[log.${params.entry.level}] ${params.entry.text}`);
        }
      }
    },
    async close() {
      ws.close();
      await fetch(`http://127.0.0.1:${chrome.httpPort}/json/close/${tabInfo.id}`).catch(() => {});
    },
  };
  await S("Page.enable");
  await S("Runtime.enable");
  await S("Network.enable");
  await S("Log.enable");
  if (viewport) {
    await S("Emulation.setDeviceMetricsOverride", {
      width: viewport.width, height: viewport.height,
      deviceScaleFactor: viewport.dsf ?? 1, mobile: !!viewport.mobile,
    });
  }
  if (!js) await S("Emulation.setScriptExecutionDisabled", { value: true });
  await S("Page.navigate", { url });
  return tab;
}

// ------------------------------------------------------- hydration gate ---

const GATE_FN = `(() => {
  if (!document.body) return { dc: false };
  const root = document.querySelector("#dc-root");
  const imgs = [...document.images];
  return {
    dc: !!root && root.children.length > 0,
    noPlaceholder: !document.querySelector(".sc-placeholder, .sc-interp.sc-missing"),
    imgsReady: imgs.every((i) => i.complete && i.naturalWidth > 0),
    imgCount: imgs.length,
    fonts: document.fonts.status,
    noBraces: !/\\{\\{/.test(document.body.innerText),
  };
})()`;

async function waitHydrated(S, label, timeoutMs = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await S("Runtime.evaluate", { expression: GATE_FN, returnByValue: true });
    last = r.result?.value;
    if (last && last.dc && last.noPlaceholder && last.imgsReady && last.fonts === "loaded" && last.noBraces) {
      await sleep(800); // settle: last paints, font swaps, any trailing work
      return last;
    }
    await sleep(250);
  }
  throw new Error(`hydration gate timeout for ${label}: ${JSON.stringify(last)}`);
}

async function evalJs(S, expression) {
  const r = await S("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result?.value;
}

// --------------------------------------------------------- page surgery ---

// Runs INSIDE the hydrated page. Materializes CSSOM-only stylesheets, rewrites
// hash hrefs via the route table, strips the runtime, applies the per-route
// head, and returns the final HTML. Route spec comes in as `spec`.
const SURGERY_FN = `(spec) => {
  const warnings = [];
  // 1. CSSOM materialization: styles injected via insertRule (the scp hover
  // sheet) have empty textContent; outerHTML would lose their rules.
  for (const el of document.querySelectorAll("style")) {
    if (!el.textContent.trim() && el.sheet && el.sheet.cssRules.length) {
      el.textContent = [...el.sheet.cssRules].map((r) => r.cssText).join("\\n");
    }
  }
  // 2. hash hrefs -> real routes; then the foreign table (config key
  // "foreign": screens that kept their hash navigation but live on another
  // domain get base + path); genuine in-page anchors are left alone. Own
  // routes win.
  const idSet = new Set([...document.querySelectorAll("[id]")].map((e) => e.id));
  let foreignCount = 0;
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    const h = a.getAttribute("href").slice(1);
    if (spec.routeByHash[h]) a.setAttribute("href", spec.routeByHash[h]);
    else if (spec.foreignRoutes && spec.foreignRoutes[h]) {
      a.setAttribute("href", spec.foreignBase + spec.foreignRoutes[h]);
      foreignCount++;
    }
    else if (!idSet.has(h)) warnings.push("unresolvable hash href: #" + h + " (left as-is)");
  }
  if (foreignCount) warnings.push(foreignCount + " hash href(s) rewritten to " + spec.foreignBase);
  // 2b. exact-match href rewrites (config-driven CTA retargeting: e.g. a
  // placeholder mailto replaced by the real artifact URL once it exists).
  for (const r of spec.hrefRewrites || []) {
    let n = 0;
    for (const a of document.querySelectorAll("a[href]")) {
      if (a.getAttribute("href") === r.from) { a.setAttribute("href", r.to); n++; }
    }
    warnings.push("hrefRewrite " + r.from + " -> " + r.to + ": " + n + " link(s)");
  }
  // 3. relative URLs are resolved against the source page's base ("/") and
  // rewritten root-absolute, so sub-route pages (/work/) still reach assets/.
  const originBase = location.origin + "/";
  const externalSchemes = ["https:", "http:", "mailto:", "tel:", "data:"];
  const passthrough = (v) =>
    externalSchemes.some((p) => v.toLowerCase().startsWith(p)) || v.startsWith("#") || v.startsWith("//");
  for (const el of document.querySelectorAll("link[href], a[href], img[src], source[src]")) {
    const attr = el.hasAttribute("href") ? "href" : "src";
    const v = el.getAttribute(attr);
    if (!v || v.startsWith("/") || passthrough(v)) continue;
    const u = new URL(v, originBase);
    el.setAttribute(attr, u.pathname + u.search + u.hash);
  }
  for (const el of document.querySelectorAll("img[srcset], source[srcset]")) {
    const v = el.getAttribute("srcset");
    if (!v) continue;
    el.setAttribute("srcset", v.split(",").map((part) => {
      const t = part.trim().split(/\s+/);
      if (!t[0] || t[0].startsWith("/") || passthrough(t[0])) return part.trim();
      const u = new URL(t[0], originBase);
      return [u.pathname + u.search + u.hash, ...t.slice(1)].join(" ");
    }).join(", "));
  }
  // 4. strip the runtime.
  document.querySelectorAll(
    "script[src*='support.js'], script[src*='vendor/react'], script[type='text/x-dc']"
  ).forEach((s) => s.remove());
  document.querySelectorAll("[data-dc-tpl]").forEach((el) => el.removeAttribute("data-dc-tpl"));
  for (const sel of spec.dropSelectors || []) {
    document.querySelectorAll(sel).forEach((el) => { warnings.push("dropped: " + sel); el.remove(); });
  }
  // 4b. head dedupe: hydration mounts helmet copies of tags the static head
  // already carries (favicon, title, meta). Identity = rel+href for links,
  // name/property for metas — keep the first, drop later duplicates.
  const seenIcon = new Set();
  for (const el of document.querySelectorAll("head link[rel]")) {
    const k = el.getAttribute("rel") + "|" + el.getAttribute("href");
    if (k.endsWith("|") || k.endsWith("|null")) continue;
    if (seenIcon.has(k)) { warnings.push("duplicate head link dropped: " + k); el.remove(); }
    else seenIcon.add(k);
  }
  const titles = document.querySelectorAll("head title");
  for (let i = 1; i < titles.length; i++) { warnings.push("duplicate title dropped"); titles[i].remove(); }
  const seenMeta = new Set();
  for (const el of document.querySelectorAll("head meta[name], head meta[property]")) {
    const k = el.getAttribute("name") || el.getAttribute("property");
    if (seenMeta.has(k)) { warnings.push("duplicate head meta dropped: " + k); el.remove(); }
    else seenMeta.add(k);
  }
  // 5. per-route head.
  const upsertMeta = (attr, key, content) => {
    let el = document.head.querySelector("meta[" + attr + '="' + CSS.escape(key) + '"]');
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute(attr, key);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content);
  };
  const upsertLink = (rel, href) => {
    let el = document.head.querySelector('link[rel="' + rel + '"]');
    if (!el) {
      el = document.createElement("link");
      el.setAttribute("rel", rel);
      document.head.appendChild(el);
    }
    el.setAttribute("href", href);
  };
  if (spec.notFound) {
    upsertMeta("name", "robots", "noindex, nofollow");
    document.title = spec.title;
    document.querySelectorAll("nav a[aria-current]").forEach((a) => a.removeAttribute("aria-current"));
    document.querySelector("main").innerHTML = spec.bodyHtml;
    document.querySelectorAll(
      "link[rel=canonical], meta[property^='og:'], meta[name^='twitter:'], script[type='application/ld+json']"
    ).forEach((el) => el.remove());
  } else {
    document.title = spec.title;
    upsertMeta("name", "description", spec.description);
    upsertLink("canonical", spec.canonical);
    for (const [k, v] of Object.entries(spec.og || {})) upsertMeta("property", k, v);
    for (const [k, v] of Object.entries(spec.twitter || {})) upsertMeta("name", k, v);
    if (spec.jsonLd) {
      document.head.insertAdjacentHTML("beforeend",
        '<script type="application/ld+json">' + JSON.stringify(spec.jsonLd) + "<\\/script>");
    }
  }
  if (spec.injectHtml) {
    for (const html of spec.injectHtml) document.body.insertAdjacentHTML("beforeend", html);
  }
  // 6. animation markers (config-driven, applied before the injected script
  // text is emitted): tag dynamic slots with data-dc-anim so the page's own
  // small script can drive them. wrapText wraps the first matching text node
  // in a marking span; selector sets the attribute on the first match, so
  // later entries can anchor on earlier tags.
  for (const t of spec.animTags || []) {
    if (t.wrapText) {
      const scope = document.querySelector("#dc-root") || document.body;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let n = null;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.includes(t.wrapText)) break;
        n = null;
      }
      if (n) {
        const span = document.createElement("span");
        span.setAttribute("data-dc-anim", t.tag);
        n.parentNode.insertBefore(span, n);
        span.appendChild(n);
      } else warnings.push("anim wrapText not found: " + t.tag);
    } else if (t.selector) {
      const el = document.querySelector(t.selector);
      if (el) el.setAttribute("data-dc-anim", t.tag);
      else warnings.push("anim selector not found: " + t.tag + " (" + t.selector + ")");
    }
  }
  if (spec.hashRedirect) {
    // insertAdjacentHTML never executes scripts — the snippet must not fire
    // inside the build; it only runs when the emitted page is visited.
    document.body.insertAdjacentHTML("beforeend", spec.hashRedirect);
  }
  return { html: "<!DOCTYPE html>\\n" + document.documentElement.outerHTML, warnings };
}`;

// ------------------------------------------------------------- emission ---

function walkSum(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += walkSum(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function copyTree(src, dest, exclude = []) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d, exclude);
    else fs.copyFileSync(s, d);
  }
}

function sitemapXml(cfg) {
  const urls = cfg.screens.map((s) =>
    `  <url><loc>${cfg.domain}${s.route}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function robotsTxt(cfg) {
  return `User-agent: *\nDisallow: /src/\n\nSitemap: ${cfg.domain}/sitemap.xml\n`;
}

function hashRedirectSnippet(cfg) {
  if (!cfg.hashRedirect) return null;
  const routes = {};
  for (const s of cfg.screens) routes[s.hash] = s.route;
  // legacy hash links to screens that moved to the foreign domain keep
  // working: they replace straight to the foreign base + path
  const foreign = cfg.foreign ? { base: cfg.foreign.base, routes: cfg.foreign.routes } : null;
  return `<script>(function(){var r=${JSON.stringify(routes)},f=${JSON.stringify(foreign)},h=(location.hash||"").slice(1);if(r[h])location.replace(r[h]);else if(f&&f.routes[h])location.replace(f.base+f.routes[h]);})();</script>`;
}

// Minimal standalone page at a retired address (config "redirects":
// [{from, to}]): search engines consolidate on the target via canonical +
// noindex, browsers follow the instant meta refresh, and the visible line
// keeps the address working for readers with JS and refresh disabled. Styled
// with the site's own type and ground so it doesn't look broken.
function redirectStubHtml(cfg, r) {
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const to = esc(r.to);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Page moved — Yak Software</title>
<link rel="canonical" href="${to}">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=${to}">
<link rel="icon" href="/assets/yak-favicon.svg">
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<style>body{margin:0;padding:0;background:#f1ece2;color:#3a3733;-webkit-font-smoothing:antialiased;font-family:'Source Serif 4',Georgia,serif;font-size:17px;line-height:1.55}a{color:#3a3733;text-decoration:none;border-bottom:1px solid #d8d0bf;transition:border-color .15s,color .15s}a:hover{color:#c3401f;border-bottom-color:#c3401f}</style>
</head>
<body>
<main style="max-width:38em;margin:0 auto;padding:16vh min(6vw,72px) 18vh">
<p>This page has moved. The address you followed now lives at <a href="${to}">${esc(r.to)}</a>.</p>
</main>
</body>
</html>
`;
}

const SRC_README = (cfg) => `# src/ — the authoring source for ${cfg.domain}

This site is **prerendered**: the HTML files at the repository root are static
snapshots generated from the dc page in this directory. The server ships no
runtime JavaScript (except a small hash-redirect snippet on the home page, and
the page(s) explicitly listed in the config as needing it).

## What lives here

| file | role |
|---|---|
| \`index.dc.html\` | the authoring source: a dc page (\`<x-dc>\` markup + the \`text/x-dc\` component). Edit **this**, never the root HTML. |
| \`support.js\` | the dc runtime, used at build time only. Not shipped to visitors. |
| \`assets/vendor/\` | React UMD builds, used by the runtime at build time only. |
| \`build.mjs\` | the prerender build tool (generic; configured by \`build.config.json\`). |
| \`build.config.json\` | routes, per-page head metadata, 404 body, sitemap domain. |

## Regenerating the site

From the repository root:

    node src/build.mjs build src/build.config.json --pages-only

That re-hydrates every configured screen in headless Chromium, rewrites hash
navigation into real URLs, strips the runtime, and rewrites the root HTML
pages, \`sitemap.xml\`, \`robots.txt\` and \`404.html\`. It does not touch
\`assets/\`, \`CNAME\`, \`.nojekyll\` or \`src/\` itself.

Requires \`node\` and \`chromium\` on PATH. The build verifies hydration before
snapshotting (all images loaded, fonts loaded, no unresolved placeholders).

## Head metadata

Titles, descriptions, canonical URLs and OG/Twitter tags per route are in
\`build.config.json\` (\`screens[].title / .description\` + the shared og block).
Edit them there and re-run the build. The JSON-LD block (home page only) is
the \`jsonLd\` key of the home screen.
`;

async function cmdBuild(cfg) {
  if (cfg.outDir === cfg.siteDir || cfg.outDir.startsWith(cfg.siteDir + path.sep) || cfg.siteDir.startsWith(cfg.outDir + path.sep)) {
    throw new Error("outDir must be disjoint from siteDir");
  }
  const redirect = hashRedirectSnippet(cfg);
  if (!fs.existsSync(cfg.outDir)) fs.mkdirSync(cfg.outDir, { recursive: true });

  if (!PAGES_ONLY) {
    // fresh tree
    for (const entry of fs.readdirSync(cfg.outDir)) {
      fs.rmSync(path.join(cfg.outDir, entry), { recursive: true, force: true });
    }
    // copy the static payload (assets minus the build-time React vendor dir)
    for (const name of cfg.copyFromSite) {
      const s = path.join(cfg.siteDir, name), d = path.join(cfg.outDir, name);
      if (fs.statSync(s).isDirectory()) copyTree(s, d, cfg.copyExclude || []);
      else fs.copyFileSync(s, d);
    }
    // config-authored files (e.g. a CNAME this domain can't inherit from the
    // shared source dir) and verbatim copies from elsewhere (e.g. a paper PDF)
    for (const [name, content] of Object.entries(cfg.writeFiles || {})) {
      fs.mkdirSync(path.dirname(path.join(cfg.outDir, name)), { recursive: true });
      fs.writeFileSync(path.join(cfg.outDir, name), content);
    }
    for (const [name, from] of Object.entries(cfg.copyFiles || {})) {
      fs.mkdirSync(path.dirname(path.join(cfg.outDir, name)), { recursive: true });
      fs.copyFileSync(from, path.join(cfg.outDir, name));
    }
    // authoring source under src/
    const srcDir = path.join(cfg.outDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.copyFileSync(path.join(cfg.siteDir, cfg.sourcePage), path.join(srcDir, cfg.src.page));
    fs.copyFileSync(path.join(cfg.siteDir, "support.js"), path.join(srcDir, "support.js"));
    copyTree(path.join(cfg.siteDir, "assets/vendor"), path.join(srcDir, "assets/vendor"));
    fs.copyFileSync(fileURLToPath(import.meta.url), path.join(srcDir, "build.mjs"));
    const repoCfg = { ...cfg._raw, siteDir: "..", outDir: ".." };
    fs.writeFileSync(path.join(srcDir, "build.config.json"), JSON.stringify(repoCfg, null, 2) + "\n");
    fs.writeFileSync(path.join(srcDir, "README.md"), SRC_README(cfg));
  }

  // ---- hydrate + snapshot each screen -------------------------------------
  const sourcePage = PAGES_ONLY
    ? path.join(cfg.outDir, "src", cfg.src.page)
    : path.join(cfg.siteDir, cfg.sourcePage);
  const server = startServer([path.dirname(sourcePage), cfg.outDir]);
  const port = await server.port;
  const chrome = await launchChromium();
  const redirectByRoute = new Map(
    cfg.screens.filter((s) => s.hashRedirect === true).map((s) => [s.route, redirect])
  );
  try {
    for (const screen of cfg.screens) {
      const tab = await openTab(chrome, { url: `http://127.0.0.1:${port}/${path.basename(sourcePage)}#${screen.hash}` });
      await waitHydrated(tab.S, screen.hash);
      // Deterministic animation bake: for animated screens, wait until the
      // live animation reaches its idle/resting phase (config-given selector +
      // style predicate) so the baked snapshot is always the same frame and
      // the no-JS fallback look is guaranteed, not racy.
      if (screen.animIdleGate) {
        const g = screen.animIdleGate;
        const t0 = Date.now();
        let ok = false;
        while (Date.now() - t0 < 25000) {
          ok = await evalJs(tab.S, `(() => {
            const el = document.querySelector(${JSON.stringify(g.selector)});
            if (!el) return false;
            const s = el.style.cssText;
            return s.includes(${JSON.stringify(g.contains)}) && !s.includes(${JSON.stringify(g.notContains)});
          })()`);
          if (ok) break;
          await sleep(100);
        }
        if (!ok) throw new Error(`animIdleGate timeout for ${screen.route}`);
        console.log(`[build] ${screen.route}: animation idle gate reached`);
      }
      const spec = {
        routeByHash: Object.fromEntries(cfg.screens.map((s) => [s.hash, s.route])),
        foreignBase: cfg.foreign ? cfg.foreign.base : null,
        foreignRoutes: cfg.foreign ? cfg.foreign.routes : null,
        hrefRewrites: screen.hrefRewrites || cfg.hrefRewrites || null,
        title: screen.title,
        description: screen.description,
        canonical: cfg.domain + screen.route,
        og: {
          "og:title": screen.title,
          "og:description": screen.description,
          "og:url": cfg.domain + screen.route,
          ...(cfg.og || {}),
        },
        twitter: {
          "twitter:title": screen.title,
          "twitter:description": screen.description,
          ...(cfg.twitter || {}),
        },
        jsonLd: screen.jsonLd || null,
        hashRedirect: redirectByRoute.get(screen.route) || null,
        injectHtml: screen.injectHtml || null,
        animTags: screen.animTags || null,
        dropSelectors: cfg.dropSelectors || [],
      };
      const { html, warnings } = await evalJs(tab.S, `(${SURGERY_FN})(${JSON.stringify(spec)})`);
      if (warnings.length) console.log(`[build] ${screen.route} warnings:`, warnings);
      const file = path.join(cfg.outDir, routeToFile(screen.route));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html);
      console.log(`[build] ${screen.route} <- #${screen.hash} -> ${path.relative(cfg.outDir, file)} (${html.length} bytes)`);
      await tab.close(); // release the renderer — 11 live tabs OOM the cgroup
    }

    // ---- 404: real header/footer, main swapped (based on the home screen) --
    const tab = await openTab(chrome, { url: `http://127.0.0.1:${port}/${path.basename(sourcePage)}#${cfg.notFound.basedOn || cfg.screens[0].hash}` });
    await waitHydrated(tab.S, "404");
    const spec = {
      routeByHash: Object.fromEntries(cfg.screens.map((s) => [s.hash, s.route])),
      foreignBase: cfg.foreign ? cfg.foreign.base : null,
      foreignRoutes: cfg.foreign ? cfg.foreign.routes : null,
      notFound: true,
      title: cfg.notFound.title,
      bodyHtml: cfg.notFound.bodyHtml,
      dropSelectors: cfg.dropSelectors || [],
    };
    const { html, warnings } = await evalJs(tab.S, `(${SURGERY_FN})(${JSON.stringify(spec)})`);
    if (warnings.length) console.log("[build] 404 warnings:", warnings);
    fs.writeFileSync(path.join(cfg.outDir, "404.html"), html);
    console.log(`[build] /404.html (${html.length} bytes)`);
    await tab.close();

    fs.writeFileSync(path.join(cfg.outDir, "sitemap.xml"), sitemapXml(cfg));
    fs.writeFileSync(path.join(cfg.outDir, "robots.txt"), robotsTxt(cfg));
    fs.writeFileSync(path.join(cfg.outDir, ".nojekyll"), "");
    console.log("[build] sitemap.xml, robots.txt, .nojekyll written");
    // redirect stubs at retired addresses; the sitemap stays screens-only, so
    // stubs are never listed
    for (const r of cfg.redirects || []) {
      if (!/^https:\/\//.test(r.to)) throw new Error(`redirect ${r.from}: target must be an absolute https URL, got ${r.to}`);
      if (cfg.screens.some((s) => s.route === r.from)) throw new Error(`redirect ${r.from} collides with an own screen route`);
      const file = path.join(cfg.outDir, routeToFile(r.from));
      fs.writeFileSync(file, redirectStubHtml(cfg, r));
      console.log(`[build] ${r.from} -> ${r.to} (redirect stub: ${path.relative(cfg.outDir, file)})`);
    }
  } finally {
    await chrome.close();
    await server.close();
  }
  console.log(`[build] done: ${cfg.outDir} (${walkSum(cfg.outDir)} bytes total)`);
}

// ------------------------------------------------------------- verify -----

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

function normalizeText(s) {
  return s.replace(/\s+/g, " ").trim();
}

async function cmdVerify(cfg) {
  const results = { failures: [] };
  const fail = (msg) => { results.failures.push(msg); console.log("[verify] FAIL " + msg); };

  const refServer = startServer([cfg.siteDir]);
  const outServer = startServer([cfg.outDir]);
  const refPort = await refServer.port, outPort = await outServer.port;
  const chrome = await launchChromium();
  const srcBase = path.basename(cfg.sourcePage);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dc-verify-"));
  try {
    // ---- pixel/text captures: reference (hydrated current site) + output --
    // Routes listed in cfg.animatedRoutes have their live animation slots
    // hidden (cfg.animMaskCss) on BOTH sides before the screenshot, and the
    // same elements are removed from both text extractions, so comparison is
    // phase-independent; everything else is compared in full.
    const animated = new Set(cfg.animatedRoutes || []);
    const maskSelectors = cfg.animMaskCss ? cfg.animMaskCss.split("{")[0].trim() : "";
    const TEXT_FN = (maskSel) => `(() => { const b = document.body.cloneNode(true);
       [...b.children].filter((e) => e.tagName === "SCRIPT").forEach((e) => e.remove());
       ${maskSel ? `b.querySelectorAll(${JSON.stringify(maskSel)}).forEach((e) => e.remove());` : ""}
       return b.textContent; })()`;
    const captures = []; // {route, viewport, kind, png, text}
    for (const screen of cfg.screens) {
      for (const vp of VIEWPORTS) {
        const maskSel = animated.has(screen.route) ? maskSelectors : null;
        // reference
        let tab = await openTab(chrome, { url: `http://127.0.0.1:${refPort}/${srcBase}#${screen.hash}`, viewport: vp });
        const gate = await waitHydrated(tab.S, `ref ${screen.route} ${vp.name}`);
        if (maskSel) {
          await evalJs(tab.S, `document.head.insertAdjacentHTML("beforeend", "<style>${cfg.animMaskCss.replace(/"/g, "&quot;")}</style>")`);
          await sleep(300);
        }
        const text = await evalJs(tab.S, TEXT_FN(maskSel));
        tab.recordEvents();
        const shot = await tab.S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        captures.push({ kind: "ref", route: screen.route, vp: vp.name, png: Buffer.from(shot.data, "base64"), text: normalizeText(text), gate });
        await tab.close();
        // output
        tab = await openTab(chrome, { url: `http://127.0.0.1:${outPort}${screen.route}`, viewport: vp });
        await sleep(1500); // fonts/images settle (no gate possible without JS assumptions)
        if (maskSel) {
          await evalJs(tab.S, `document.head.insertAdjacentHTML("beforeend", "<style>${cfg.animMaskCss.replace(/"/g, "&quot;")}</style>")`);
          await sleep(300);
        }
        const text2 = await evalJs(tab.S, TEXT_FN(maskSel));
        tab.recordEvents();
        const shot2 = await tab.S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
        captures.push({ kind: "out", route: screen.route, vp: vp.name, png: Buffer.from(shot2.data, "base64"), text: normalizeText(text2), tab });
        await tab.close();
      }
    }

    // network audit from the JS-enabled output captures
    console.log("\n=== 7. network audit (output pages, JS enabled) ===");
    for (const c of captures.filter((c) => c.kind === "out" && c.vp === "desktop")) {
      const t = c.tab;
      const http = t.net.filter((e) => /^https?:\/\//.test(e.url || ""));
      const external = http.filter((e) => !e.url.startsWith("http://127.0.0.1"));
      const non200 = http.filter((e) => e.phase === "response" && e.status !== 200);
      const failed = t.net.filter((e) => e.phase === "failed");
      console.log(`  ${c.route}: ${t.net.length} requests, external=${external.length}, non-200=${non200.length}, aborted-local=${failed.length}, console=${t.consoleLines.length}`);
      if (external.length) fail(`${c.route}: external requests: ` + external.map((e) => e.url).join(", "));
      if (non200.length) fail(`${c.route}: non-200: ` + JSON.stringify(non200));
      for (const f of failed) console.log(`    (aborted: ${f.url} — ${f.error})`);
      if (t.consoleLines.length) fail(`${c.route}: console not empty: ${t.consoleLines.join(" | ")}`);
    }

    // ---- 1+2. no-JS render + hover (CDP DOM/CSS domains; JS disabled) -----
    console.log("\n=== 1+2. zero-JS render + hover regression (per page) ===");
    const tall = { width: 1440, height: 6000 };
    for (const screen of cfg.screens) {
      const tab = await openTab(chrome, { url: `http://127.0.0.1:${outPort}${screen.route}`, viewport: tall, js: false });
      await sleep(2000);
      const { root } = await tab.S("DOM.getDocument", { depth: -1 });
      const q = async (sel) => (await tab.S("DOM.querySelector", { nodeId: root.nodeId, selector: sel })).nodeId;
      // locate #dc-root in the returned tree (no page JS available) and count children
      let dcNode = null;
      const walk = (n) => {
        if (!n) return;
        const a = n.attributes || [];
        for (let i = 0; i < a.length; i += 2) if (a[i] === "id" && a[i + 1] === "dc-root") dcNode = n;
        (n.children || []).forEach(walk);
      };
      walk(root);
      if (!dcNode) { fail(`${screen.route}: no #dc-root with JS disabled`); continue; }
      const dcChildren = (dcNode.children || []).length;
      const dcOuter = (await tab.S("DOM.getOuterHTML", { nodeId: dcNode.nodeId })).outerHTML;
      const h1 = (await tab.S("DOM.querySelector", { nodeId: root.nodeId, selector: "h1" })).nodeId;
      const h1Text = h1
        ? (await tab.S("DOM.getOuterHTML", { nodeId: h1 })).outerHTML.replace(/<[^>]*>/g, "").trim()
        : null;
      const css = async (nodeId) => {
        const r = await tab.S("CSS.getComputedStyleForNode", { nodeId });
        return Object.fromEntries(r.computedStyle.map((p) => [p.name, p.value]));
      };
      await tab.S("CSS.enable");
      const bodyNode = await q("body");
      const bodyStyle = await css(bodyNode);
      // expected families come from the site config — georgeee sets IBM Plex
      // Sans/Newsreader, yak sets Source Serif 4 throughout
      const fonts = cfg.fonts || { body: "IBM Plex Sans", heading: "Newsreader" };
      const fontsOk = new RegExp(fonts.body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(bodyStyle["font-family"] || "");
      const h1Style = h1 ? await css(h1) : {};
      const h1FontOk = new RegExp(fonts.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(h1Style["font-family"] || "");
      const h1Ok = h1Text && h1Text.length > 0;
      const dcOk = dcOuter.length > 200;
      // hover: nav link + first main-content link
      const hoverOne = async (sel) => {
        const nodeId = await q(sel);
        if (!nodeId) return { sel, ok: false, note: "not found" };
        const before = await css(nodeId);
        const box = (await tab.S("DOM.getBoxModel", { nodeId })).model.content;
        const cx = (box[0] + box[4]) / 2, cy = (box[1] + box[5]) / 2;
        await tab.S("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
        await sleep(350);
        const after = await css(nodeId);
        const props = ["color", "border-bottom-color", "background-color"];
        const changed = props.filter((p) => before[p] !== after[p]);
        return { sel, ok: changed.length > 0, changed, before: before[changed[0] || "color"], after: after[changed[0] || "color"] };
      };
      const hovers = [];
      for (const sel of ["nav a", "main a", "footer a"]) hovers.push(await hoverOne(sel));
      console.log(`  ${screen.route}: h1="${(h1Text || "").slice(0, 50)}" dcChildren=${dcChildren} bodyFont=${fontsOk ? bodyStyle["font-family"] : "MISSING " + bodyStyle["font-family"]} h1Font=${h1FontOk ? h1Style["font-family"] : "MISSING " + (h1Style["font-family"] || "?")}`);
      console.log(`    hover: ` + hovers.map((h) => `${h.sel}:${h.ok ? `OK (${h.changed.join("+")}: ${h.before} -> ${h.after})` : "NO-CHANGE " + JSON.stringify(h.note || h.changed)}`).join("  "));
      if (!dcOk || !h1Ok || !fontsOk || !h1FontOk) fail(`${screen.route}: no-JS render check failed (dc=${dcOk} h1=${h1Ok} bodyFont=${fontsOk} h1Font=${h1FontOk})`);
      // nav hover proves the scp sheet; content/footer links prove generic
      // a:hover — some card links are designed color-stable (e.g. /finance/),
      // so at least one of main/footer must respond rather than both
      const navOk = hovers[0].ok;
      const contentOk = hovers.slice(1).some((h) => h.ok);
      if (!navOk) fail(`${screen.route}: hover produced no computed-style change on nav a`);
      if (!contentOk) fail(`${screen.route}: hover produced no computed-style change on main a / footer a`);
      await tab.close();
    }

    // ---- 3. pixel diff -----------------------------------------------------
    console.log("\n=== 3. pixel diff (static output vs current hydrated render) ===");
    for (const screen of cfg.screens) {
      for (const vp of VIEWPORTS) {
        const ref = captures.find((c) => c.kind === "ref" && c.route === screen.route && c.vp === vp.name);
        const out = captures.find((c) => c.kind === "out" && c.route === screen.route && c.vp === vp.name);
        const refPng = path.join(tmp, `ref-${screen.route.replace(/\//g, "_")}-${vp.name}.png`);
        const outPng = path.join(tmp, `out-${screen.route.replace(/\//g, "_")}-${vp.name}.png`);
        const diffPng = path.join(tmp, `diff-${screen.route.replace(/\//g, "_")}-${vp.name}.png`);
        fs.writeFileSync(refPng, ref.png);
        fs.writeFileSync(outPng, out.png);
        const run = async (cmd, args) => {
          const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
          return await new Promise((ok) => {
            let out = "", err = "";
            p.stdout.on("data", (d) => (out += d));
            p.stderr.on("data", (d) => (err += d));
            p.on("close", () => ok({ out: out.trim(), err: err.trim() }));
          });
        };
        const aeRaw = (await run("compare", ["-metric", "AE", refPng, outPng, diffPng])).err;
        const ae = parseInt(aeRaw, 10) || 0; // compare prints "count (normalized)"
        const dims = (await run("identify", ["-format", "%w %h", refPng])).out || "? ?";
        const maxD = (await run("magick", [refPng, outPng, "-compose", "difference", "-composite", "-format", "%[fx:round(255*maxima)]", "info:"])).out;
        const [w, h] = dims.split(/\s+/).map(Number);
        const pct = w && h ? (ae / (w * h) * 100) : NaN;
        let bbox = "";
        if (ae > 0) bbox = (await run("magick", [diffPng, "-format", "%@", "info:"])).out;
        console.log(`  ${screen.route} [${vp.name}]: ${w}x${h}, AE=${ae}/${w * h} differing pixels (${pct.toFixed(4)}%), maxChannelDelta=${maxD}${ae > 0 ? ` diffRegion=${bbox}` : ", pixel-identical"}`);
        fs.unlinkSync(refPng); fs.unlinkSync(outPng); fs.unlinkSync(diffPng);
        if (ae > 0) fail(`${screen.route} [${vp.name}]: ${ae} differing pixels of ${w * h} (${pct.toFixed(4)}%), max delta ${maxD}, region ${bbox}`);
      }
    }

    // ---- 4. content equality ----------------------------------------------
    console.log("\n=== 4. content equality (normalized text) ===");
    for (const screen of cfg.screens) {
      const ref = captures.find((c) => c.kind === "ref" && c.route === screen.route && c.vp === "desktop");
      const out = captures.find((c) => c.kind === "out" && c.route === screen.route && c.vp === "desktop");
      if (ref.text === out.text) console.log(`  ${screen.route}: identical (${ref.text.length} chars normalized)`);
      else {
        let d = -1;
        while (d < Math.min(ref.text.length, out.text.length) && ref.text[d + 1] === out.text[d + 1]) d++;
        fail(`${screen.route}: text differs (ref ${ref.text.length} vs out ${out.text.length} chars); first divergence at ${d}: ...${JSON.stringify(ref.text.slice(Math.max(0, d - 40), d + 40))} vs ...${JSON.stringify(out.text.slice(Math.max(0, d - 40), d + 40))}`);
      }
    }

    // ---- 8. redirect shim (needs the live browser) ----------------------------
  console.log("\n=== 8. redirect shim ===");
  {
    const home = cfg.screens.find((s) => s.hashRedirect === true);
    if (!home) console.log("  (no hashRedirect configured — skipped)");
    else {
      // drive the target from the config: first non-home screen
      const target = cfg.screens.find((s) => s.route !== home.route);
      const tab = await openTab(chrome, { url: `http://127.0.0.1:${outPort}/#${target.hash}` });
      let landed = null;
      for (let i = 0; i < 40; i++) {
        await sleep(150);
        landed = await evalJs(tab.S, "location.pathname");
        if (landed === target.route) break;
      }
      const h1 = await evalJs(tab.S, "document.querySelector('h1') ? document.querySelector('h1').textContent : null");
      console.log(`  /#${target.hash} -> pathname=${landed} (h1: ${JSON.stringify(h1)})`);
      if (landed !== target.route) fail(`redirect shim: /#${target.hash} did not land on ${target.route} (got ${landed})`);
      if (!h1 || h1.length < 2) fail(`redirect shim: /#${target.hash} landed but h1 is ${JSON.stringify(h1)}`);
      await tab.S("Page.navigate", { url: `http://127.0.0.1:${outPort}/#zzz` });
      await sleep(2500);
      const url2 = await evalJs(tab.S, "location.href");
      const h1b = await evalJs(tab.S, "document.querySelector('h1') ? document.querySelector('h1').textContent : null");
      console.log(`  /#zzz -> url unchanged: ${url2} (h1: ${JSON.stringify((h1b || "").slice(0, 40))}…)`);
      if (!/\/#zzz$/.test(url2)) fail(`redirect shim: /#zzz changed the URL (${url2})`);
      if (!h1b || h1b.length < 10) fail("redirect shim: /#zzz did not render the home page");
      await tab.close();
    }
  }

  await chrome.close();
  } finally {
    await refServer.close();
    await outServer.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }

  // ---- 5. debris scan (static, on emitted files) --------------------------
  console.log("\n=== 5. debris scan ===");
  const debrisRes = [];
  for (const rel of [...new Set(cfg.screens.map((s) => routeToFile(s.route))).add("404.html")]) {
    const html = fs.readFileSync(path.join(cfg.outDir, rel), "utf8");
    const checks = [
      ["{{ braces", /\{\{/],
      ["sc-if/for/else element", /<sc-(if|for|else)\b/],
      // plain sc-interp wrappers are legitimate: the runtime emits them around
      // interpolated text on the live site too (diane's dict text + timer)
      ["sc placeholder/interp element", /<[a-zA-Z-]*sc-(placeholder|missing)\b/],
      ["sc placeholder/interp class", /class="[^"]*\bsc-(placeholder|missing|unresolved)\b/],
      ["style-hover attr", /\sstyle-hover=/],
      ["onClick attr", /\sonClick=/],
      ["data-dc-tpl attr", /\sdata-dc-tpl=/],
      ["HTML comment", /<!--/],
      ["support.js reference", /support\.js/],
      ["unpkg reference", /unpkg\.com/],
    ];
    for (const [name, re] of checks) {
      const m = html.match(re);
      debrisRes.push({ page: rel, check: name, hits: m ? 1 : 0 });
      if (m) fail(`${rel}: debris "${name}"`);
    }
    // icon links: exactly one per page (dedupe regression guard)
    const iconCount = (html.match(/rel="icon"/g) || []).length;
    debrisRes.push({ page: rel, check: "icon-link-count!=1", hits: iconCount === 1 ? 0 : iconCount });
    if (iconCount !== 1) fail(`${rel}: expected exactly 1 icon link, found ${iconCount}`);
  }
  const byCheck = {};
  for (const r of debrisRes) byCheck[r.check] = (byCheck[r.check] || 0) + r.hits;
  console.log("  " + Object.entries(byCheck).map(([k, v]) => `${k}=${v}`).join("  "));

  // ---- 6. link resolution --------------------------------------------------
  console.log("\n=== 6. link check ===");
  const routeSet = new Set(cfg.screens.map((s) => s.route));
  let linkTotal = 0, linkBad = [];
  for (const rel of [...new Set(cfg.screens.map((s) => routeToFile(s.route))).add("404.html")]) {
    const html = fs.readFileSync(path.join(cfg.outDir, rel), "utf8");
    for (const m of html.matchAll(/href="([^"]*)"/g)) {
      const href = m[1];
      linkTotal++;
      if (/^(https?:|mailto:|tel:)/.test(href)) continue;
      let target = null;
      if (href.startsWith("#")) target = { page: rel, id: href.slice(1) };
      else if (href.startsWith("/") && routeSet.has(href)) target = { page: routeToFile(href), id: null };
      else if (href.startsWith("/")) target = { page: href.slice(1), id: null };
      else target = { page: path.posix.normalize(path.posix.join(path.posix.dirname(rel), href)), id: null };
      const pageFile = path.join(cfg.outDir, target.page);
      if (!fs.existsSync(pageFile)) { linkBad.push(`${rel} -> ${href} (missing page)`); continue; }
      if (target.id) {
        const dest = fs.readFileSync(pageFile, "utf8");
        if (!dest.includes(`id="${target.id}"`)) linkBad.push(`${rel} -> ${href} (missing id)`);
      }
    }
  }
  console.log(`  ${linkTotal} hrefs checked, ${linkBad.length} unresolved`);
  for (const b of linkBad) fail("link: " + b);

  // ---- 9. sizes -------------------------------------------------------------
  console.log("\n=== 9. sizes ===");
  const outTotal = walkSum(cfg.outDir);
  const refTotal = walkSum(cfg.siteDir);
  for (const rel of [...new Set(cfg.screens.map((s) => routeToFile(s.route))).add("404.html")]) {
    console.log(`  ${rel}: ${fs.statSync(path.join(cfg.outDir, rel)).size} bytes (current single-page build: ${fs.statSync(path.join(cfg.siteDir, cfg.sourcePage)).size})`);
  }
  console.log(`  total: new tree ${outTotal} bytes vs current build ${refTotal} bytes`);

  console.log(`\n=== verify ${results.failures.length === 0 ? "GREEN — all checks passed" : "RED — " + results.failures.length + " failure(s)"} ===`);
  process.exitCode = results.failures.length ? 1 : 0;
}

// ------------------------------------------------------------------ main ---

const cfg = loadConfig(CFG_PATH);
if (MODE === "build") await cmdBuild(cfg);
else if (MODE === "verify") await cmdVerify(cfg);
else { console.error("usage: build-static.mjs build|verify <config.json> [--pages-only]"); process.exit(2); }
process.exit(process.exitCode ?? 0);
