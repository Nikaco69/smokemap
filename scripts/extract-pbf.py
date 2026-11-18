"""從 Geofabrik 香港 OSM 檔案抽取煙位相關地點，輸出同 Overpass 一樣格式嘅 data/sources/osm_hk.json。

用法（Overpass 連唔到時嘅後備方案）：
  curl -L -o data/sources/hong-kong-latest.osm.pbf https://download.geofabrik.de/asia/china/hong-kong-latest.osm.pbf
  .venv/bin/python scripts/extract-pbf.py
  node scripts/import-hk.js --offline
"""
import json, os, re, sys, datetime
import osmium

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'data', 'sources')
PBF = os.path.join(SRC, 'hong-kong-latest.osm.pbf')


def wanted(t):
    a = t.get('amenity')
    return (a in ('waste_basket', 'ashtray', 'smoking_area')
            or t.get('ashtray') == 'yes'
            or t.get('smoking') == 'designated')


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.out = []

    def add(self, typ, id_, tags, lat, lon):
        self.out.append({'type': typ, 'id': id_, 'lat': lat, 'lon': lon, 'tags': tags})

    def node(self, n):
        t = dict(n.tags)
        if t and wanted(t) and n.location.valid():
            self.add('node', n.id, t, n.location.lat, n.location.lon)

    def way(self, w):
        t = dict(w.tags)
        if not (t and wanted(t)):
            return
        pts = [(nd.lat, nd.lon) for nd in w.nodes if nd.location.valid()]
        if pts:
            self.add('way', w.id, t, sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


h = H()
h.apply_file(PBF, locations=True)
json.dump({'fetchedAt': datetime.datetime.now().isoformat(), 'source': 'geofabrik', 'failedTiles': 0, 'elements': h.out},
          open(os.path.join(SRC, 'osm_hk.json'), 'w'))
print(f'抽到 {len(h.out)} 個地點')
