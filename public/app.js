// 煙位地圖 前端
const $ = s => document.querySelector(s);
const TYPE = {
  bin_ashtray: { name: '垃圾桶煙灰缸', color: 'var(--bin)', icon: '🗑️' },
  ashtray: { name: '煙灰缸', color: 'var(--tray)', icon: '🚬' },
  smoking_area: { name: '吸煙區', color: 'var(--zone)', icon: '🌿' },
};
const DEFAULT_CENTER = [22.2819, 114.1582]; // 中環

// ---- 身份（匿名，存喺本機）----
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } }
let uid = store('uid'); if (!uid) { uid = crypto.randomUUID(); store('uid', uid); }
let nick = store('nick') || '';

async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-User-Id': uid, 'X-User-Name': encodeURIComponent(nick), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '出錯'), { data });
  return data;
}

// ---- 地圖 ----
const map = L.map('map', { zoomControl: false }).setView(DEFAULT_CENTER, 17);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap contributors',
}).addTo(map);
const layers = { community: L.layerGroup().addTo(map), locked: L.layerGroup().addTo(map), nsa: L.layerGroup().addTo(map) };
let meMarker = null, myPos = null;
const filters = new Set([...Object.keys(TYPE), 'nsa']);
let lastData = { spots: [], locked: [] };

function pinIcon(type, cls = '') {
  const t = TYPE[type];
  return L.divIcon({
    className: '', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
    html: `<div class="pin ${cls}" style="background:${t.color}"><span>${cls === 'locked' ? '🔒' : t.icon}</span></div>`,
  });
}

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

const ago = ts => {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${Math.max(m, 1)} 分鐘前`;
  if (m < 1440) return `${Math.round(m / 60)} 小時前`;
  return `${Math.round(m / 1440)} 日前`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const navLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;

function communityPopup(s) {
  const div = document.createElement('div');
  div.className = 'pop';
  div.innerHTML = `
    <h3>${TYPE[s.type].icon} ${TYPE[s.type].name}${s.verified ? '' : '<span class="badge warn">推測</span>'}</h3>
    ${s.note ? `<div>${esc(s.note)}</div>` : ''}
    ${s.verified ? '' : '<div class="meta">未有人確認。行過見到幫手撳「仲喺度」+2 分。</div>'}
    ${s.photo ? `<img src="${s.photo}" alt="現場相片">` : ''}
    <div class="meta">來源：${esc(s.by)} · ${s.dist ?? '?'} 米</div>
    <div class="meta">${s.lastConfirmedAt ? `最後確認：${ago(s.lastConfirmedAt)} · ${s.confirmCount} 人確認` : '未有人確認'}${s.reported ? ` · ${s.reported} 人話冇咗` : ''}</div>
    <div class="acts">
      ${s.mine ? '<div class="meta">你分享嘅地點</div>' : '<button class="ok">✓ 仲喺度 +2</button><button class="gone">✗ 冇咗</button>'}
      <a class="nav" href="${navLink(s.lat, s.lng)}" target="_blank" rel="noopener">導航</a>
    </div>`;
  div.querySelector('.ok')?.addEventListener('click', () => vote(s.id, 'confirm'));
  div.querySelector('.gone')?.addEventListener('click', () => vote(s.id, 'report'));
  return div;
}

function render() {
  layers.community.clearLayers(); layers.locked.clearLayers();
  for (const s of lastData.spots) if (filters.has(s.type))
    L.marker([s.lat, s.lng], { icon: pinIcon(s.type, s.verified ? '' : 'guess') }).bindPopup(() => communityPopup(s)).addTo(layers.community);
  for (const s of lastData.locked) if (filters.has(s.type))
    L.marker([s.lat, s.lng], { icon: pinIcon(s.type, 'locked') })
      .bindPopup('<div class="pop"><h3>🔒 已鎖住</h3>呢個係其他用戶分享嘅煙位。分享或確認一個煙位，就可以解鎖附近所有社群煙位 7 日。</div>')
      .addTo(layers.locked);
  filters.has('nsa') ? layers.nsa.addTo(map) : layers.nsa.remove();
}

// ---- 禁煙區（控煙酒辦公室公共運輸設施禁煙區）----
fetch('nsa.geojson').then(r => r.ok ? r.json() : null).then(g => {
  if (!g) return;
  L.geoJSON(g, {
    style: { color: '#d33', weight: 1, fillColor: '#d33', fillOpacity: 0.18 },
    onEachFeature: (f, l) => l.bindPopup(`<div class="pop"><h3>🚭 ${esc(f.properties.name)}</h3><div>${esc(f.properties.remark)}</div><div class="meta">法定禁煙區，定額罰款 $3,000</div>${f.properties.url ? `<div class="acts"><a class="nav" href="${esc(f.properties.url)}" target="_blank" rel="noopener">官方圖則</a></div>` : ''}</div>`),
  }).addTo(layers.nsa);
}).catch(() => {});

function renderStatus(me) {
  const daysLeft = me.active ? Math.ceil((me.activeUntil - Date.now()) / 86400000) : 0;
  $('#status').innerHTML = `${me.active ? `<span class="pill on">已解鎖 · 剩 ${daysLeft} 日</span>` : '<span class="pill off">已鎖住</span>'}<br><b>${me.points}</b> 分 · ${me.level}`;
  const bar = $('#lockbar');
  const n = lastData.locked.length;
  if (!me.active) {
    bar.hidden = false;
    bar.innerHTML = n
      ? `附近仲有 <strong>${n} 個社群煙位</strong>被鎖住。<br>分享一個新煙位，或者確認一個舊嘅「仲喺度」，即刻解鎖 7 日。`
      : `你而家未解鎖。分享或確認一個煙位，解鎖其他人分享嘅地點 7 日。`;
  } else if (daysLeft <= 2) {
    bar.hidden = false;
    bar.innerHTML = `解鎖仲有 <strong>${daysLeft} 日</strong>就到期。行過嘅時候順手確認一個煙位就續期。`;
  } else bar.hidden = true;
}

async function loadCommunity() {
  const c = map.getCenter();
  try {
    lastData = await call(`/api/spots?lat=${c.lat}&lng=${c.lng}&r=2000`);
    render(); renderStatus(lastData.me);
  } catch (e) { toast(e.message); }
}

// ---- 定位 ----
function locate(fly = true) {
  return new Promise(resolve => {
    if (!navigator.geolocation) { toast('呢部機唔支援定位'); return resolve(null); }
    navigator.geolocation.getCurrentPosition(p => {
      myPos = { lat: p.coords.latitude, lng: p.coords.longitude };
      if (!meMarker) meMarker = L.marker([myPos.lat, myPos.lng], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [16, 16] }), zIndexOffset: 1000 }).addTo(map);
      else meMarker.setLatLng([myPos.lat, myPos.lng]);
      if (fly) map.setView([myPos.lat, myPos.lng], 17);
      resolve(myPos);
    }, () => { toast('開唔到定位，請喺瀏覽器允許位置權限'); resolve(null); }, { enableHighAccuracy: true, timeout: 10000 });
  });
}

// ---- 確認／報告 ----
async function vote(id, kind) {
  const pos = await locate(false);
  if (!pos) return;
  try {
    const r = await call(`/api/spots/${id}/${kind}`, { method: 'POST', body: JSON.stringify({ myLat: pos.lat, myLng: pos.lng }) });
    toast(kind === 'confirm' ? '多謝確認！+2 分，解鎖延長 7 日' : '已記錄，3 個人報告就會隱藏');
    map.closePopup(); renderStatus(r.me); loadCommunity();
  } catch (e) { toast(e.message); }
}

// ---- 新增 ----
let photoData = null;
function openAdd(open) {
  $('#addSheet').hidden = !open; $('#crosshair').hidden = !open;
  document.querySelector('.dock').hidden = open; $('#lockbar').hidden = open || $('#lockbar').hidden;
  if (open) { $('#nick').value = nick; photoData = null; $('#photoLabel').textContent = '影張相（+3 分）'; }
  else renderStatus(lastData.me || { active: true, points: 0, level: '' });
}

async function compress(file) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, 1024 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s;
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

$('#photo').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try { photoData = await compress(f); $('#photoLabel').textContent = '✓ 已加相片'; } catch { toast('相片讀唔到'); }
});

$('#btnAdd').addEventListener('click', async () => {
  const pos = myPos || await locate();
  if (!pos) return;
  map.setView([pos.lat, pos.lng], 18);
  openAdd(true);
});
$('#btnCancel').addEventListener('click', () => openAdd(false));
$('#addSheet').addEventListener('submit', async e => {
  e.preventDefault();
  const pos = await locate(false); if (!pos) return;
  nick = $('#nick').value.trim(); store('nick', nick);
  const c = map.getCenter();
  $('#btnSubmit').disabled = true;
  try {
    const r = await call('/api/spots', { method: 'POST', body: JSON.stringify({
      lat: c.lat, lng: c.lng, myLat: pos.lat, myLng: pos.lng,
      type: new FormData(e.target).get('type'), note: $('#note').value.trim(), photo: photoData,
    }) });
    $('#note').value = '';
    openAdd(false);
    toast(`分享咗！+${photoData ? 13 : 10} 分，附近煙位已解鎖 7 日`);
    renderStatus(r.me); loadCommunity();
  } catch (err) { toast(err.message, 4000); }
  finally { $('#btnSubmit').disabled = false; }
});

// ---- 其他 ----
$('#filters').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', on); on ? filters.add(b.dataset.type) : filters.delete(b.dataset.type);
  render();
});
$('#btnLocate').addEventListener('click', () => locate().then(p => p && loadCommunity()));
let moveT; map.on('moveend', () => { clearTimeout(moveT); moveT = setTimeout(loadCommunity, 400); });

// ---- 「我食緊煙」打卡 ----
function ask(title, body, actions, warn = false) {
  $('#askTitle').textContent = title;
  $('#askBody').textContent = body; $('#askBody').classList.toggle('ask-warn', warn);
  const box = $('#askActs'); box.innerHTML = '';
  for (const [label, fn, primary] of actions) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label;
    b.onclick = () => { $('#askSheet').hidden = true; document.querySelector('.dock').hidden = false; fn?.(); };
    box.append(b);
  }
  document.querySelector('.dock').hidden = true;
  $('#askSheet').hidden = false;
}

async function smokeCheckin() {
  const pos = await locate(false);
  if (!pos) return;
  let r;
  try { r = await call('/api/checkins', { method: 'POST', body: JSON.stringify({ myLat: pos.lat, myLng: pos.lng }) }); }
  catch (e) { return toast(e.message); }
  renderStatus(r.me);
  const n = r.nearest;
  if (r.nsa) {
    return ask('⚠️ 你喺禁煙區入面', `${r.nsa.name}係法定禁煙區，定額罰款 $3,000。${n ? `最近嘅${TYPE[n.type].name}喺 ${n.dist} 米外。` : ''}`,
      [['帶我去最近煙位', () => n && (map.setView([n.lat, n.lng], 18), loadCommunity()), true], ['知道', null]], true);
  }
  if (r.created) { toast('多人喺呢度打卡，已經自動加做「推測煙位」'); loadCommunity(); }
  if (r.hasSpot && n) {
    return ask(`${TYPE[n.type].icon} 附近 ${n.dist} 米有${TYPE[n.type].name}`, n.verified ? '佢仲喺唔喺度？確認一下幫其他人。' : '呢個位係推測，未有人確認。你見唔見到？',
      [['✓ 仲喺度 +2', () => vote(n.id, 'confirm'), true], ['✗ 冇咗', () => vote(n.id, 'report')], ['唔肯定', null]]);
  }
  ask('呢度未有記錄', `${r.counted ? '已記錄你喺度食煙（+1 分）。' : ''}你身邊有冇煙灰缸或者有煙灰缸嘅垃圾桶？`,
    [['有，分享佢 +10', () => $('#btnAdd').click(), true], ['冇，淨係食煙', () => toast('多謝！多幾個人喺度打卡就會變推測煙位')]]);
}
$('#btnSmoke').addEventListener('click', smokeCheckin);

// ---- 停留偵測：App 開住、喺同一個位停咗 4 分鐘，又唔喺已知煙位附近 → 問一次 ----
const STAY_M = 30, STAY_MS = 4 * 60000, ASK_GAP_MS = 30 * 60000;
let anchor = null;
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
if (navigator.geolocation) navigator.geolocation.watchPosition(p => {
  const here = { lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() };
  myPos = here; meMarker?.setLatLng([here.lat, here.lng]);
  if (!anchor || distM(anchor, here) > STAY_M) { anchor = here; return; }
  const lastAsk = +(store('lastAsk') || 0);
  if (here.t - anchor.t < STAY_MS || here.t - lastAsk < ASK_GAP_MS) return;
  if (!$('#askSheet').hidden || !$('#addSheet').hidden) return;
  const known = lastData.spots.some(s => distM(s, here) < STAY_M);
  if (known) return;
  store('lastAsk', String(here.t)); anchor = here;
  ask('你係咪喺度食緊煙？', '你喺呢度停咗幾分鐘。如果係食煙，打個卡幫大家搵到呢個位。',
    [['係，打卡', smokeCheckin, true], ['唔係', null]]);
}, () => {}, { enableHighAccuracy: true, maximumAge: 30000 });

loadCommunity();
locate().then(p => { if (p) loadCommunity(); });

// ---- 安裝成 App（PWA）----
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(() => {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || store('installDismissed')) return;
  const box = $('#install'), text = $('#installText');
  const close = () => { box.hidden = true; store('installDismissed', '1'); };
  $('#installClose').onclick = close;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (ios) {
    text.textContent = '裝成 App：撳 Safari 底部「分享」⬆️，再揀「加至主畫面」。';
    box.hidden = false;
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    text.textContent = '將煙位地圖裝落手機，開得快啲。';
    $('#installBtn').hidden = false; box.hidden = false;
    $('#installBtn').onclick = async () => { e.prompt(); await e.userChoice; close(); };
  });
})();
