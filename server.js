// 煙位地圖 — 無依賴 Node 後端
// 資料存喺 data/db.json，相片存喺 data/photos/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PHOTOS = path.join(DATA, 'photos');
const DB_FILE = path.join(DATA, 'db.json');

// ---- 「要繼續分享先睇到」規則 ----
const RULES = {
  activeDays: 7,          // 最近 N 日有貢獻 = 活躍，可睇晒社群地點
  freePreview: 3,         // 唔活躍時，只顯示最近 N 個社群地點
  pointsAdd: 10,          // 新增地點
  pointsConfirm: 2,       // 確認地點仲喺度
  pointsPhoto: 3,         // 附相額外分
  maxAddDistanceM: 300,   // 只可以喺自己附近 300m 內新增
  maxConfirmDistanceM: 200,
  dupRadiusM: 15,         // 15m 內同類型當重複
  confirmCooldownH: 20,   // 同一個點每人每 20 小時確認一次
  reportsToHide: 3,       // 3 個人報告「冇咗」就隱藏
  pointsCheckin: 1,       // 「我食緊煙」打卡
  checkinCooldownMin: 30, // 每人每 30 分鐘打卡一次
  guessRadiusM: 25,       // 25m 內嘅打卡當同一個位
  guessMinUsers: 3,       // 3 個唔同用戶喺同一位打卡 → 自動變「推測煙位」
  guessWindowDays: 30,
};

fs.mkdirSync(PHOTOS, { recursive: true });
let db = { users: {}, spots: [], checkins: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
db.checkins ||= [];
for (const s of db.spots) { s.source ||= 'user'; if (s.verified === undefined) s.verified = true; }

// 禁煙區（控煙酒辦公室，經 scripts/import-hk.js 生成）
let NSA = [];
try { NSA = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'nsa.geojson'), 'utf8')).features; } catch {}
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function nsaAt(pt) {
  for (const f of NSA) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) if (poly?.[0]?.length && inRing(pt, poly[0]) && !poly.slice(1).some(h => inRing(pt, h))) return f.properties;
  }
  return null;
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 200);
}

const TYPES = new Set(['bin_ashtray', 'ashtray', 'smoking_area']);
const now = () => Date.now();
const DAY = 86400000;

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function getUser(uid, name) {
  if (!uid || typeof uid !== 'string' || uid.length > 64) return null;
  let u = db.users[uid];
  if (!u) { u = db.users[uid] = { id: uid, name: '', points: 0, lastContribAt: 0, adds: 0, confirms: 0, createdAt: now() }; save(); }
  if (name && typeof name === 'string') { u.name = name.slice(0, 20); save(); }
  return u;
}

function status(u) {
  const activeUntil = u.lastContribAt ? u.lastContribAt + RULES.activeDays * DAY : 0;
  return {
    name: u.name, points: u.points, adds: u.adds, confirms: u.confirms,
    active: activeUntil > now(), activeUntil,
    level: u.points >= 200 ? '煙位達人' : u.points >= 60 ? '熟客' : u.points >= 10 ? '新手' : '路人',
  };
}

function award(u, pts) { u.points += pts; u.lastContribAt = now(); save(); }

function publicSpot(s, uid) {
  return {
    id: s.id, lat: s.lat, lng: s.lng, type: s.type, note: s.note,
    photo: s.photo ? '/photos/' + s.photo : null,
    by: s.source === 'osm' ? 'OpenStreetMap' : s.source === 'guess' ? '多人打卡推測' : (db.users[s.by]?.name || '匿名'),
    mine: s.by === uid, source: s.source, verified: s.verified,
    createdAt: s.createdAt, lastConfirmedAt: s.lastConfirmedAt, confirmCount: s.confirms.length,
    reported: s.reports.length,
  };
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 3e6) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
  });
}

const validLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

async function api(req, res, url) {
  const uid = req.headers['x-user-id'];
  const u = getUser(uid, req.headers['x-user-name'] ? decodeURIComponent(req.headers['x-user-name']) : '');
  if (!u) return send(res, 400, { error: '缺少用戶 ID' });

  if (req.method === 'GET' && url.pathname === '/api/me') return send(res, 200, { me: status(u), rules: RULES });

  // 取附近社群地點 —— 唔活躍就鎖住大部份（喺伺服器度執行，唔係淨係前端遮）
  if (req.method === 'GET' && url.pathname === '/api/spots') {
    const c = { lat: +url.searchParams.get('lat'), lng: +url.searchParams.get('lng') };
    if (!validLatLng(c.lat, c.lng)) return send(res, 400, { error: '位置無效' });
    const radius = Math.min(+url.searchParams.get('r') || 1500, 3000);
    const near = db.spots
      .filter(s => s.reports.length < RULES.reportsToHide)
      .map(s => ({ s, d: distM(c, s) }))
      .filter(x => x.d <= radius)
      .sort((a, b) => a.d - b.d);
    const st = status(u);
    let open = near, locked = [];
    if (!st.active) {
      const community = near.filter(x => x.s.source !== 'osm');
      const preview = new Set(community.slice(0, RULES.freePreview));
      open = near.filter(x => x.s.source === 'osm' || preview.has(x) || x.s.by === u.id);
      locked = near.filter(x => !open.includes(x));
    }
    return send(res, 200, {
      me: st,
      spots: open.slice(0, 600).map(x => ({ ...publicSpot(x.s, u.id), dist: Math.round(x.d) })),
      // 鎖住嘅只俾模糊位置（約 100m 格），用嚟引人去分享
      locked: locked.map(x => ({ lat: Math.round(x.s.lat * 1000) / 1000, lng: Math.round(x.s.lng * 1000) / 1000, type: x.s.type })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/spots') {
    const b = await readBody(req);
    const spot = { lat: +b.lat, lng: +b.lng };
    const me = { lat: +b.myLat, lng: +b.myLng };
    if (!validLatLng(spot.lat, spot.lng) || !validLatLng(me.lat, me.lng)) return send(res, 400, { error: '位置無效' });
    if (!TYPES.has(b.type)) return send(res, 400, { error: '類型無效' });
    if (distM(me, spot) > RULES.maxAddDistanceM) return send(res, 400, { error: `只可以新增你附近 ${RULES.maxAddDistanceM}m 內嘅地點` });
    const nsa = nsaAt(spot);
    if (nsa && b.type !== 'bin_ashtray') return send(res, 400, { error: `呢度係法定禁煙區（${nsa.name}），唔可以標做吸煙位` });
    const dup = db.spots.find(s => s.type === b.type && s.reports.length < RULES.reportsToHide && distM(s, spot) < RULES.dupRadiusM);
    if (dup) return send(res, 409, { error: '附近已經有同一個地點，幫手按「仲喺度」確認就得', id: dup.id });

    const id = crypto.randomUUID();
    let photo = null;
    if (typeof b.photo === 'string' && b.photo.startsWith('data:image/jpeg;base64,')) {
      const buf = Buffer.from(b.photo.split(',')[1], 'base64');
      if (buf.length < 2.5e6) { photo = id + '.jpg'; fs.writeFileSync(path.join(PHOTOS, photo), buf); }
    }
    const s = {
      id, lat: spot.lat, lng: spot.lng, type: b.type, note: String(b.note || '').slice(0, 140),
      photo, by: u.id, source: 'user', verified: true, createdAt: now(), lastConfirmedAt: now(), confirms: [], reports: [],
    };
    db.spots.push(s); u.adds++;
    award(u, RULES.pointsAdd + (photo ? RULES.pointsPhoto : 0));
    return send(res, 200, { spot: publicSpot(s, u.id), me: status(u) });
  }

  // 「我食緊煙」打卡：多人喺同一位打卡 → 自動生成推測煙位
  if (req.method === 'POST' && url.pathname === '/api/checkins') {
    const b = await readBody(req);
    const me = { lat: +b.myLat, lng: +b.myLng };
    if (!validLatLng(me.lat, me.lng)) return send(res, 400, { error: '位置無效' });
    const nsa = nsaAt(me);
    const nearest = db.spots
      .filter(s => s.reports.length < RULES.reportsToHide)
      .map(s => ({ s, d: distM(me, s) })).sort((a, b) => a.d - b.d)[0];
    const last = db.checkins.filter(c => c.by === u.id).pop();
    if (last && now() - last.at < RULES.checkinCooldownMin * 60000)
      return send(res, 200, { me: status(u), counted: false, nsa, nearest: nearest && { ...publicSpot(nearest.s, u.id), dist: Math.round(nearest.d) } });
    // 只存約 10m 精度位置
    db.checkins.push({ by: u.id, lat: Math.round(me.lat * 1e4) / 1e4, lng: Math.round(me.lng * 1e4) / 1e4, at: now() });
    const since = now() - RULES.guessWindowDays * DAY;
    db.checkins = db.checkins.filter(c => c.at > since);
    award(u, RULES.pointsCheckin);
    let created = null;
    const hasSpot = nearest && nearest.d < RULES.guessRadiusM;
    if (!hasSpot && !nsa) {
      const users = new Set(db.checkins.filter(c => distM(c, me) < RULES.guessRadiusM).map(c => c.by));
      if (users.size >= RULES.guessMinUsers) {
        const pts = db.checkins.filter(c => distM(c, me) < RULES.guessRadiusM);
        const s = {
          id: crypto.randomUUID(), source: 'guess', verified: false,
          lat: pts.reduce((a, c) => a + c.lat, 0) / pts.length, lng: pts.reduce((a, c) => a + c.lng, 0) / pts.length,
          type: 'smoking_area', note: `${users.size} 個人喺度打卡食煙，未確認有冇煙灰缸`, photo: null, by: 'guess',
          createdAt: now(), lastConfirmedAt: 0, confirms: [], reports: [],
        };
        db.spots.push(s); save(); created = publicSpot(s, u.id);
      }
    }
    return send(res, 200, { me: status(u), counted: true, nsa, created, hasSpot,
      nearest: nearest && { ...publicSpot(nearest.s, u.id), dist: Math.round(nearest.d) } });
  }

  const m = url.pathname.match(/^\/api\/spots\/([\w-]+)\/(confirm|report)$/);
  if (req.method === 'POST' && m) {
    const s = db.spots.find(x => x.id === m[1]);
    if (!s) return send(res, 404, { error: '搵唔到呢個地點' });
    const b = await readBody(req);
    const me = { lat: +b.myLat, lng: +b.myLng };
    if (!validLatLng(me.lat, me.lng) || distM(me, s) > RULES.maxConfirmDistanceM)
      return send(res, 400, { error: `要行近 ${RULES.maxConfirmDistanceM}m 內先可以確認／報告` });
    if (s.by === u.id && s.source === 'user') return send(res, 400, { error: '唔可以確認自己新增嘅地點' });
    if (m[2] === 'confirm') {
      const last = s.confirms.filter(c => c.by === u.id).pop();
      if (last && now() - last.at < RULES.confirmCooldownH * 3600000) return send(res, 429, { error: '你啱啱確認過呢個點，遲啲再嚟' });
      s.confirms.push({ by: u.id, at: now() }); s.lastConfirmedAt = now(); s.verified = true;
      s.reports = s.reports.filter(r => r !== u.id); u.confirms++;
      award(u, RULES.pointsConfirm);
    } else {
      if (!s.reports.includes(u.id)) s.reports.push(u.id);
      award(u, RULES.pointsConfirm);
    }
    return send(res, 200, { spot: publicSpot(s, u.id), me: status(u) });
  }
  send(res, 404, { error: 'not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
function serveFile(res, base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/photos/')) return serveFile(res, PHOTOS, url.pathname.slice(8));
    serveFile(res, PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  } catch (e) { send(res, 500, { error: '伺服器出錯：' + e.message }); }
}).listen(PORT, () => console.log(`煙位地圖 running on http://localhost:${PORT}`));
