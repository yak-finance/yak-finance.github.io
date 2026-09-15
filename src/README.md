# src/ — the authoring source for https://yak.finance

This site is **prerendered**: the HTML files at the repository root are static
snapshots generated from the dc page in this directory. The server ships no
runtime JavaScript (except a small hash-redirect snippet on the home page, and
the page(s) explicitly listed in the config as needing it).

## What lives here

| file | role |
|---|---|
| `index.dc.html` | the authoring source: a dc page (`<x-dc>` markup + the `text/x-dc` component). Edit **this**, never the root HTML. |
| `support.js` | the dc runtime, used at build time only. Not shipped to visitors. |
| `assets/vendor/` | React UMD builds, used by the runtime at build time only. |
| `build.mjs` | the prerender build tool (generic; configured by `build.config.json`). |
| `build.config.json` | routes, per-page head metadata, 404 body, sitemap domain. |

## Regenerating the site

From the repository root:

    node src/build.mjs build src/build.config.json --pages-only

That re-hydrates every configured screen in headless Chromium, rewrites hash
navigation into real URLs, strips the runtime, and rewrites the root HTML
pages, `sitemap.xml`, `robots.txt` and `404.html`. It does not touch
`assets/`, `CNAME`, `.nojekyll` or `src/` itself.

Requires `node` and `chromium` on PATH. The build verifies hydration before
snapshotting (all images loaded, fonts loaded, no unresolved placeholders).

## Head metadata

Titles, descriptions, canonical URLs and OG/Twitter tags per route are in
`build.config.json` (`screens[].title / .description` + the shared og block).
Edit them there and re-run the build. The JSON-LD block (home page only) is
the `jsonLd` key of the home screen.
