CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 0,
  last_contrib_at INTEGER NOT NULL DEFAULT 0,
  adds INTEGER NOT NULL DEFAULT 0,
  confirms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY,
  osm_id TEXT UNIQUE,
  source TEXT NOT NULL,            -- user | osm | guess
  verified INTEGER NOT NULL DEFAULT 1,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  type TEXT NOT NULL,              -- bin_ashtray | ashtray | smoking_area
  note TEXT NOT NULL DEFAULT '',
  photo TEXT,
  by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL DEFAULT 0,
  confirm_count INTEGER NOT NULL DEFAULT 0,
  report_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS spots_lat_lng ON spots (lat, lng);

CREATE TABLE IF NOT EXISTS confirms (
  spot_id TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS confirms_spot_by ON confirms (spot_id, by);

CREATE TABLE IF NOT EXISTS reports (
  spot_id TEXT NOT NULL,
  by TEXT NOT NULL,
  PRIMARY KEY (spot_id, by)
);

CREATE TABLE IF NOT EXISTS checkins (
  by TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkins_lat_lng ON checkins (lat, lng);
CREATE INDEX IF NOT EXISTS checkins_by_at ON checkins (by, at);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
);
