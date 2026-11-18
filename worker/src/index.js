// 煙位地圖 — Cloudflare Worker 後端（D1 數據庫）
// 靜態檔案（public/）由 Workers Assets 直接提供；冇對應檔案嘅請求（/api/*、/photos/*）先入嚟呢度。
import NSA_GEO from './nsa.json';

const RULES = {
  activeDays: 7,
  freePreview: 3,
  pointsAdd: 10,
  pointsConfirm: 2,
  pointsPhoto: 3,
  pointsCheckin: 1,
  maxAddDistanceM: 300,
  maxConfirmDistanceM: 200,
  dupRadiusM: 15,
  confirmCooldownH: 20,
  reportsToHide: 3,
  checkinCooldownMin: 30,
  guessRadiusM: 25,
  guessMinUsers: 3,
  guessWindowDays: 30,
};
const TYPES = new Set(['bin_ashtray', 'ashtray', 'smoking_area']);
const DAY = 86400000;
const now = () => Date.now();

// ---- 幾何 ----
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bbox(c, radiusM) {
  const dLat = radiusM / 111320, dLng = radiusM / (111320 * Math.cos((c.lat * Math.PI) / 180));
  return [c.lat - dLat, c.lat + dLat, c.lng - dLng, c.lng + dLng];
}
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function nsaAt(pt) {
  for (const f of NSA_GEO.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) if (poly?.[0]?.length && inRing(pt, poly[0]) && !poly.slice(1).some(h => inRing(pt, h))) return f.properties;
  }
  return null;
}
const validLatLng = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// ---- 回應 ----
const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

// ---- 用戶 ----
async function getUser(db, uid, name) {
  if (!uid || uid.length > 64) return null;
  let u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
  if (!u) {
    await db.prepare('INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)').bind(uid, (name || '').slice(0, 20), now()).run();
    u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first();
  } else if (name && name.slice(0, 20) !== u.name) {
    await db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name.slice(0, 20), uid).run();
    u.name = name.slice(0, 20);
  }
  return u;
}
function status(u) {
  const activeUntil = u.last_contrib_at ? u.last_contrib_at + RULES.activeDays * DAY : 0;
  return {
    name: u.name, points: u.points, adds: u.adds, confirms: u.confirms,
    active: activeUntil > now(), activeUntil,
    level: u.points >= 200 ? '煙位達人' : u.points >= 60 ? '熟客' : u.points >= 10 ? '新手' : '路人',
  };
}
async function award(db, u, pts, field) {
  const t = now();
  const extra = field ? `, ${field} = ${field} + 1` : '';
  await db.prepare(`UPDATE users SET points = points + ?, last_contrib_at = ?${extra} WHERE id = ?`).bind(pts, t, u.id).run();
  u.points += pts; u.last_contrib_at = t; if (field) u[field]++;
}

async function publicSpots(db, rows, uid) {
  const ids = [...new Set(rows.filter(s => s.source === 'user').map(s => s.by))];
  const names = {};
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const r = await db.prepare(`SELECT id, name FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const x of r.results) names[x.id] = x.name;
  }
  return rows.map(s => ({
    id: s.id, lat: s.lat, lng: s.lng, type: s.type, note: s.note,
    photo: s.photo ? '/photos/' + s.photo : null,
    by: s.source === 'osm' ? 'OpenStreetMap' : s.source === 'guess' ? '多人打卡推測' : (names[s.by] || '匿名'),
    mine: s.by === uid, source: s.source, verified: !!s.verified,
    createdAt: s.created_at, lastConfirmedAt: s.last_confirmed_at, confirmCount: s.confirm_count,
    reported: s.report_count, dist: s.dist,
  }));
}

async function nearby(db, c, radiusM) {
  const [a, b, d, e] = bbox(c, radiusM);
  const r = await db.prepare('SELECT * FROM spots WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND report_count < ?')
    .bind(a, b, d, e, RULES.reportsToHide).all();
  return r.results.map(s => ({ ...s, dist: Math.round(distM(c, s)) })).filter(s => s.dist <= radiusM).sort((x, y) => x.dist - y.dist);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readJson(req) {
  const len = +req.headers.get('content-length') || 0;
  if (len > 1.5e6) throw new Error('相片太大');
  return req.json().catch(() => ({}));
}

// ---- API ----
async function api(req, env, url) {
  const db = env.DB;
  const uid = req.headers.get('x-user-id');
  let name = '';
  try { name = decodeURIComponent(req.headers.get('x-user-name') || ''); } catch {}
  const u = await getUser(db, uid, name);
  if (!u) return json(400, { error: '缺少用戶 ID' });

  if (req.method === 'GET' && url.pathname === '/api/me') return json(200, { me: status(u), rules: RULES });

  if (req.method === 'GET' && url.pathname === '/api/spots') {
    const c = { lat: +url.searchParams.get('lat'), lng: +url.searchParams.get('lng') };
    if (!validLatLng(c.lat, c.lng)) return json(400, { error: '位置無效' });
    const radius = Math.min(+url.searchParams.get('r') || 1500, 3000);
    const near = await nearby(db, c, radius);
    const st = status(u);
    let open = near, locked = [];
    if (!st.active) {
      const preview = new Set(near.filter(s => s.source !== 'osm').slice(0, RULES.freePreview));
      open = near.filter(s => s.source === 'osm' || preview.has(s) || s.by === u.id);
      locked = near.filter(s => !open.includes(s));
    }
    return json(200, {
      me: st,
      spots: await publicSpots(db, open.slice(0, 600), u.id),
      locked: locked.map(s => ({ lat: Math.round(s.lat * 1000) / 1000, lng: Math.round(s.lng * 1000) / 1000, type: s.type })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/spots') {
    const b = await readJson(req);
    const spot = { lat: +b.lat, lng: +b.lng }, me = { lat: +b.myLat, lng: +b.myLng };
    if (!validLatLng(spot.lat, spot.lng) || !validLatLng(me.lat, me.lng)) return json(400, { error: '位置無效' });
    if (!TYPES.has(b.type)) return json(400, { error: '類型無效' });
    if (distM(me, spot) > RULES.maxAddDistanceM) return json(400, { error: `只可以新增你附近 ${RULES.maxAddDistanceM}m 內嘅地點` });
    const nsa = nsaAt(spot);
    if (nsa && b.type !== 'bin_ashtray') return json(400, { error: `呢度係法定禁煙區（${nsa.name}），唔可以標做吸煙位` });
    const dup = (await nearby(db, spot, RULES.dupRadiusM)).find(s => s.type === b.type);
    if (dup) return json(409, { error: '附近已經有同一個地點，幫手按「仲喺度」確認就得', id: dup.id });

    const id = crypto.randomUUID();
    let photo = null;
    if (typeof b.photo === 'string' && b.photo.startsWith('data:image/jpeg;base64,')) {
      const bytes = b64ToBytes(b.photo.split(',')[1]);
      if (bytes.length < 1e6) { photo = id; await db.prepare('INSERT INTO photos (id, data) VALUES (?, ?)').bind(id, bytes).run(); }
    }
    const t = now();
    await db.prepare(`INSERT INTO spots (id, source, verified, lat, lng, type, note, photo, by, created_at, last_confirmed_at)
      VALUES (?, 'user', 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, spot.lat, spot.lng, b.type, String(b.note || '').slice(0, 140), photo, u.id, t, t).run();
    await award(db, u, RULES.pointsAdd + (photo ? RULES.pointsPhoto : 0), 'adds');
    const s = await db.prepare('SELECT * FROM spots WHERE id = ?').bind(id).first();
    return json(200, { spot: (await publicSpots(db, [s], u.id))[0], me: status(u) });
  }

  if (req.method === 'POST' && url.pathname === '/api/checkins') {
    const b = await readJson(req);
    const me = { lat: +b.myLat, lng: +b.myLng };
    if (!validLatLng(me.lat, me.lng)) return json(400, { error: '位置無效' });
    const nsa = nsaAt(me);
    const near = await nearby(db, me, 2000);
    const nearest = near[0] ? (await publicSpots(db, [near[0]], u.id))[0] : null;
    const last = await db.prepare('SELECT at FROM checkins WHERE by = ? ORDER BY at DESC LIMIT 1').bind(u.id).first();
    if (last && now() - last.at < RULES.checkinCooldownMin * 60000) return json(200, { me: status(u), counted: false, nsa, nearest, hasSpot: !!nearest && nearest.dist < RULES.guessRadiusM });

    // 只存約 10m 精度
    await db.prepare('INSERT INTO checkins (by, lat, lng, at) VALUES (?, ?, ?, ?)')
      .bind(u.id, Math.round(me.lat * 1e4) / 1e4, Math.round(me.lng * 1e4) / 1e4, now()).run();
    await db.prepare('DELETE FROM checkins WHERE at < ?').bind(now() - RULES.guessWindowDays * DAY).run();
    await award(db, u, RULES.pointsCheckin);

    const hasSpot = !!nearest && nearest.dist < RULES.guessRadiusM;
    let created = null;
    if (!hasSpot && !nsa) {
      const [a, bb, d, e] = bbox(me, RULES.guessRadiusM);
      const pts = (await db.prepare('SELECT * FROM checkins WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?').bind(a, bb, d, e).all())
        .results.filter(c => distM(c, me) < RULES.guessRadiusM);
      const users = new Set(pts.map(c => c.by));
      if (users.size >= RULES.guessMinUsers) {
        const id = crypto.randomUUID();
        await db.prepare(`INSERT INTO spots (id, source, verified, lat, lng, type, note, by, created_at)
          VALUES (?, 'guess', 0, ?, ?, 'smoking_area', ?, 'guess', ?)`)
          .bind(id, pts.reduce((s, c) => s + c.lat, 0) / pts.length, pts.reduce((s, c) => s + c.lng, 0) / pts.length,
            `${users.size} 個人喺度打卡食煙，未確認有冇煙灰缸`, now()).run();
        created = { id };
      }
    }
    return json(200, { me: status(u), counted: true, nsa, created, hasSpot, nearest });
  }

  const m = url.pathname.match(/^\/api\/spots\/([\w-]+)\/(confirm|report)$/);
  if (req.method === 'POST' && m) {
    const s = await db.prepare('SELECT * FROM spots WHERE id = ?').bind(m[1]).first();
    if (!s) return json(404, { error: '搵唔到呢個地點' });
    const b = await readJson(req);
    const me = { lat: +b.myLat, lng: +b.myLng };
    if (!validLatLng(me.lat, me.lng) || distM(me, s) > RULES.maxConfirmDistanceM)
      return json(400, { error: `要行近 ${RULES.maxConfirmDistanceM}m 內先可以確認／報告` });
    if (s.by === u.id && s.source === 'user') return json(400, { error: '唔可以確認自己新增嘅地點' });
    if (m[2] === 'confirm') {
      const last = await db.prepare('SELECT at FROM confirms WHERE spot_id = ? AND by = ? ORDER BY at DESC LIMIT 1').bind(s.id, u.id).first();
      if (last && now() - last.at < RULES.confirmCooldownH * 3600000) return json(429, { error: '你啱啱確認過呢個點，遲啲再嚟' });
      const t = now();
      const del = await db.prepare('DELETE FROM reports WHERE spot_id = ? AND by = ?').bind(s.id, u.id).run();
      await db.batch([
        db.prepare('INSERT INTO confirms (spot_id, by, at) VALUES (?, ?, ?)').bind(s.id, u.id, t),
        db.prepare('UPDATE spots SET confirm_count = confirm_count + 1, last_confirmed_at = ?, verified = 1, report_count = MAX(0, report_count - ?) WHERE id = ?')
          .bind(t, del.meta.changes || 0, s.id),
      ]);
      await award(db, u, RULES.pointsConfirm, 'confirms');
    } else {
      const ins = await db.prepare('INSERT OR IGNORE INTO reports (spot_id, by) VALUES (?, ?)').bind(s.id, u.id).run();
      if (ins.meta.changes) await db.prepare('UPDATE spots SET report_count = report_count + 1 WHERE id = ?').bind(s.id).run();
      await award(db, u, RULES.pointsConfirm);
    }
    const s2 = await db.prepare('SELECT * FROM spots WHERE id = ?').bind(s.id).first();
    return json(200, { spot: (await publicSpots(db, [s2], u.id))[0], me: status(u) });
  }
  return json(404, { error: 'not found' });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, env, url);
      const p = url.pathname.match(/^\/photos\/([\w-]+)(\.jpg)?$/);
      if (p) {
        const row = await env.DB.prepare('SELECT data FROM photos WHERE id = ?').bind(p[1]).first();
        if (!row) return new Response('not found', { status: 404 });
        return new Response(new Uint8Array(row.data), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
      }
      return env.ASSETS.fetch(req);
    } catch (e) {
      return json(500, { error: '伺服器出錯：' + e.message });
    }
  },
};
