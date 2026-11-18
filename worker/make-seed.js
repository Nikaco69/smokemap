// 由 data/db.json（scripts/import-hk.js 生成）整 worker/seed.sql，同埋將禁煙區複製去 worker/src/nsa.json
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'db.json'), 'utf8'));
const q = v => v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const rows = db.spots.filter(s => s.source === 'osm').map(s =>
  `INSERT OR IGNORE INTO spots (id, osm_id, source, verified, lat, lng, type, note, by, created_at) VALUES (${[
    s.id, s.osmId, 'osm', s.verified ? 1 : 0, s.lat, s.lng, s.type, s.note || '', 'osm', s.createdAt,
  ].map(q).join(', ')});`);
fs.writeFileSync(path.join(__dirname, 'seed.sql'), rows.join('\n') + '\n');
fs.copyFileSync(path.join(ROOT, 'public', 'nsa.geojson'), path.join(__dirname, 'src', 'nsa.json'));
console.log(`seed.sql：${rows.length} 個 OSM 地點；nsa.json 已複製`);
