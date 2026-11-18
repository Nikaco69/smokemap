// 匯入香港煙位相關公開數據
//   node scripts/import-hk.js            下載 + 匯入
//   node scripts/import-hk.js --offline  只用 data/sources/ 已下載嘅檔案
//
// 來源：
// 1. OpenStreetMap（Overpass API）：垃圾桶、煙灰缸、吸煙區 — ODbL 授權，要標明 © OpenStreetMap contributors
// 2. 衞生署控煙酒辦公室（TACO）經 CSDI：公共交通設施禁煙區範圍 — 用嚟畫禁煙區同阻止喺禁煙區標吸煙點
//
// 注意：香港冇公開「街邊垃圾桶／煙灰缸」位置數據（食環署約有萬幾個垃圾桶但無發佈）。
// 香港街邊垃圾桶大部份頂部有煙灰缸，所以 OSM 嘅 waste_basket 會當「推測有煙灰缸」，要用戶確認。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'sources');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const NSA_OUT = path.join(ROOT, 'public', 'nsa.geojson');
fs.mkdirSync(SRC, { recursive: true });
const offline = process.argv.includes('--offline');

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const HK = { s: 22.15, w: 113.82, n: 22.57, e: 114.45 };
const STEP = 0.07; // 約 7km 一格

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function overpass(q) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': 'smokemap-import/0.1', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: q }),
          signal: AbortSignal.timeout(90000),
        });
        if (res.ok) return await res.json();
        process.stdout.write(` [${new URL(url).host} ${res.status}]`);
      } catch (e) { process.stdout.write(` [${new URL(url).host} ${e.name}]`); }
    }
    await sleep(5000 * (attempt + 1));
  }
  throw new Error('所有 Overpass 伺服器都失敗');
}

async function fetchOSM() {
  const cache = path.join(SRC, 'osm_hk.json');
  if (offline) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const byId = new Map();
  const tiles = [];
  for (let s = HK.s; s < HK.n; s += STEP) for (let w = HK.w; w < HK.e; w += STEP) tiles.push([s, w, Math.min(s + STEP, HK.n), Math.min(w + STEP, HK.e)]);
  let failed = 0;
  for (const [i, t] of tiles.entries()) {
    const b = t.map(x => x.toFixed(4)).join(',');
    const q = `[out:json][timeout:60];(
      nwr["amenity"="waste_basket"](${b});
      nwr["amenity"="ashtray"](${b});
      nwr["ashtray"="yes"](${b});
      nwr["amenity"="smoking_area"](${b});
      nwr["smoking"="designated"](${b});
    );out center tags;`;
    process.stdout.write(`格 ${i + 1}/${tiles.length}`);
    try {
      const d = await overpass(q);
      for (const e of d.elements) byId.set(e.type + e.id, e);
      console.log(` ✓ ${d.elements.length}`);
    } catch (e) { failed++; console.log(' ✗ ' + e.message); }
    await sleep(1500);
  }
  const out = { fetchedAt: new Date().toISOString(), failedTiles: failed, elements: [...byId.values()] };
  if (out.elements.length) fs.writeFileSync(cache, JSON.stringify(out));
  else if (fs.existsSync(cache)) { console.log('冇新數據，用返舊 cache'); return JSON.parse(fs.readFileSync(cache, 'utf8')); }
  return out;
}

async function fetchNSA() {
  const cache = path.join(SRC, 'taco_nsa.geojson');
  if (!offline) {
    const url = 'https://portal.csdi.gov.hk/server/services/common/dh_rcd_1696927675304_9364/MapServer/WFSServer'
      + '?service=wfs&version=2.0.0&request=GetFeature&typenames=csdi:DesignatedNSAs&outputFormat=geojson&srsName=EPSG:4326';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.ok) fs.writeFileSync(cache, await res.text());
    } catch (e) { console.log('禁煙區下載失敗，用舊檔：' + e.message); }
  }
  return JSON.parse(fs.readFileSync(cache, 'utf8'));
}

function classify(t) {
  if (t.amenity === 'smoking_area' || t.smoking === 'designated') return { type: 'smoking_area', verified: true };
  if (t.amenity === 'ashtray') return { type: 'ashtray', verified: true };
  if (t.amenity === 'waste_basket') {
    const sure = /cigarettes/.test(t.waste || '') || t.ashtray === 'yes';
    return { type: 'bin_ashtray', verified: sure };
  }
  if (t.ashtray === 'yes') return { type: 'ashtray', verified: true };
  return null;
}

(async () => {
  const osm = await fetchOSM();
  const nsa = await fetchNSA();

  // 禁煙區：簡化座標精度（約 1m）以減細檔案
  const round = c => (c.length === 0 || Array.isArray(c[0])) ? c.map(round) : [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
  const nsaOut = {
    type: 'FeatureCollection',
    features: nsa.features.filter(f => f.geometry?.coordinates?.length).map(f => ({ type: 'Feature', properties: pickProps(f.properties), geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } })),
  };
  fs.writeFileSync(NSA_OUT, JSON.stringify(nsaOut));

  let db = { users: {}, spots: [], checkins: [] };
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
  db.checkins ||= [];
  const existing = new Map(db.spots.filter(s => s.osmId).map(s => [s.osmId, s]));
  let added = 0, updated = 0;
  for (const e of osm.elements) {
    const t = e.tags || {};
    const c = classify(t); if (!c) continue;
    const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    if (lat == null) continue;
    const osmId = e.type + '/' + e.id;
    const note = [t.name, t.description, t.note].filter(Boolean).join(' · ').slice(0, 140);
    const prev = existing.get(osmId);
    if (prev) { Object.assign(prev, { lat, lng, type: c.type, verified: prev.verified || c.verified, note: prev.note || note }); updated++; continue; }
    db.spots.push({
      id: 'osm-' + e.type[0] + e.id, osmId, source: 'osm', verified: c.verified,
      lat, lng, type: c.type, note, photo: null, by: 'osm',
      createdAt: Date.now(), lastConfirmedAt: 0, confirms: [], reports: [],
    });
    added++;
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
  const count = k => db.spots.filter(s => s.source === 'osm' && s.type === k).length;
  console.log(`\nOSM：新增 ${added}，更新 ${updated}（垃圾桶煙灰缸 ${count('bin_ashtray')}、煙灰缸 ${count('ashtray')}、吸煙區 ${count('smoking_area')}）`);
  console.log(`禁煙區：${nsaOut.features.length} 個 → public/nsa.geojson`);
  if (osm.failedTiles) console.log(`⚠ ${osm.failedTiles} 格下載失敗，遲啲再跑一次補返`);
})();

function pickProps(p = {}) {
  return { name: p.CNAME || p.ENAME || '', remark: p.REMARKS_C || p.REMARKS || '', url: p.URL || '' };
}
