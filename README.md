# 煙位地圖

香港煙灰缸垃圾桶／煙灰缸／吸煙區地圖。用戶可以分享同確認地點。

網址：https://smokemap.smokemap.workers.dev

## 部署（Cloudflare Workers + D1）

```bash
npm install
npx wrangler login
npx wrangler d1 create smokemap          # 將 database_id 填入 wrangler.toml
npx wrangler d1 execute smokemap --remote --file worker/schema.sql
npm run seed                              # 由 data/db.json 生成 worker/seed.sql
npx wrangler d1 execute smokemap --remote --file worker/seed.sql
npx wrangler deploy
```

## 本機版（Node，無依賴）

```bash
node server.js        # http://localhost:5173
```

## 匯入香港數據

```bash
node scripts/import-hk.js            # 經 Overpass 下載（伺服器唔穩定時會好慢）
# 後備方案：
curl -L -o data/sources/hong-kong-latest.osm.pbf https://download.geofabrik.de/asia/china/hong-kong-latest.osm.pbf
python3 -m venv .venv && .venv/bin/pip install osmium
.venv/bin/python scripts/extract-pbf.py
node scripts/import-hk.js --offline
```

匯入前先停 server（server 會用記憶體中嘅數據覆蓋 `data/db.json`）。

## 數據來源

- OpenStreetMap（ODbL，© OpenStreetMap contributors）：垃圾桶、煙灰缸、吸煙區
- 衞生署控煙酒辦公室，經 CSDI：公共運輸設施法定禁煙區範圍

## 分享機制

- 其他用戶分享嘅地點：7 日內冇分享或確認，只見到最近 3 個，其餘顯示做鎖住（伺服器端執行）
- OSM／政府數據永遠公開
- 分享 +10（有相 +3）、確認 +2、打卡 +1
- 3 個唔同用戶喺 25m 內打卡「我食緊煙」→ 自動生成推測煙位
- App 開住、喺同一位停 4 分鐘，又唔喺已知煙位附近 → 問用戶係咪食緊煙
