#!/usr/bin/env node
// ============================================================
// Magic Deals — feed builder
// Reads curated.json + partners.json, validates / de-dupes / drops
// expired deals, stamps `added` (first-seen, for the NEW badge), wraps
// outbound links with affiliate params (Plan A), and writes public/deals.json.
// Zero external deps — Node 20+ (global fetch, URL).
//
//   node deals-feed/build-feed.mjs
//
// The Actions workflow runs this on a schedule and deploys public/ to Pages,
// so the app's DEALS_FEED_URL gets a fresh, accurate feed automatically.
// ============================================================
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, 'public');

// Where last run's feed lives — used to carry `added` (first-seen) dates
// forward so a deal isn't re-flagged NEW on every build.
const PREVIOUS_FEED_URL =
  process.env.PREVIOUS_FEED_URL || 'https://papaturner.github.io/Pixie-Path/deals.json';

const todayISO = () => new Date().toISOString().slice(0, 10);
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
const isPlaceholder = (s) => /YOUR_|REPLACE|XXXX/i.test(String(s));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

// Pull previous {id: added} so first-seen dates survive across builds.
async function fetchPreviousAdded() {
  try {
    const r = await fetch(PREVIOUS_FEED_URL, { headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) return {};
    const arr = await r.json();
    const map = {};
    if (Array.isArray(arr)) for (const d of arr) if (d && d.id && d.added) map[d.id] = d.added;
    return map;
  } catch { return {}; }
}

// Plan A: wrap a destination URL with a partner's affiliate link.
// Returns the original URL unchanged if the partner is missing/disabled or
// still holds a placeholder — so we never ship a broken affiliate link.
function wrapAffiliate(url, key, partners) {
  const cfg = key && partners[key];
  if (!cfg || cfg.enabled === false) return url;
  try {
    if (cfg.type === 'query' && cfg.params) {
      if (Object.values(cfg.params).some(isPlaceholder)) return url;
      const u = new URL(url);
      for (const [k, v] of Object.entries(cfg.params)) u.searchParams.set(k, String(v));
      return u.toString();
    }
    if (cfg.type === 'template' && cfg.template) {
      if (isPlaceholder(cfg.template)) return url;
      return cfg.template.replace('{url}', encodeURIComponent(url));
    }
  } catch { /* fall through to raw url */ }
  return url;
}

function landingHtml(count, stamp) {
  return `<!doctype html><meta charset="utf-8"><title>Pixie Path · Deals feed</title>` +
    `<body style="font-family:system-ui;background:#1a0635;color:#ffd700;text-align:center;padding:48px">` +
    `<h1>✨ Pixie Path — Magic Deals feed</h1>` +
    `<p style="color:#fff">Machine-readable feed: <a style="color:#2ea9cb" href="./deals.json">deals.json</a></p>` +
    `<p style="color:rgba(255,255,255,.6)">${count} deals · built ${stamp} UTC</p></body>`;
}

async function main() {
  const curated = await readJson(join(__dir, 'curated.json'), []);
  const partners = await readJson(join(__dir, 'partners.json'), {});
  const prevAdded = await fetchPreviousAdded();
  const today = todayISO();

  const out = [];
  const seen = new Set();
  let dropped = 0, wrapped = 0;

  for (const raw of Array.isArray(curated) ? curated : []) {
    if (!raw || typeof raw !== 'object') { dropped++; continue; }
    const d = { ...raw };
    if (!d.id || !d.title || !isHttp(d.url)) { dropped++; continue; }   // required
    if (seen.has(d.id)) { dropped++; continue; }                        // de-dupe
    seen.add(d.id);
    if (d.expires && String(d.expires).slice(0, 10) < today) { dropped++; continue; } // expired

    d.added = prevAdded[d.id] || d.added || today;                      // first-seen

    const key = d.partner || d.merchant;
    const before = d.url;
    d.url = wrapAffiliate(d.url, key, partners);
    if (d.url !== before) wrapped++;
    delete d.partner;                                                  // internal only

    out.push(d);
  }

  // Hot first, then newest-added.
  out.sort((a, b) =>
    (b.hot ? 1 : 0) - (a.hot ? 1 : 0) ||
    String(b.added).localeCompare(String(a.added)));

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'deals.json'), JSON.stringify(out, null, 2));
  await writeFile(join(OUT_DIR, 'index.html'), landingHtml(out.length, stamp));

  console.log(`Built ${out.length} deals · ${wrapped} affiliate-wrapped · ${dropped} dropped`);
  if (wrapped === 0) {
    console.log('NOTE: 0 links affiliate-wrapped — enable partners in deals-feed/partners.json to start earning (Plan A).');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
