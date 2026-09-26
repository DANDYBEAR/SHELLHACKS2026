-- Gridlock local database schema.
-- SQLite is the first implementation target so the prototype can stay local and reproducible.
-- The UI should read ranked projects/opportunities, not internal extraction evidence.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS dataset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  reference_date TEXT NOT NULL CHECK (reference_date GLOB '????-??-??'),
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS utilities (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  state_scope TEXT,
  utility_type TEXT DEFAULT 'electric'
);

CREATE TABLE IF NOT EXISTS source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id INTEGER NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  utility_code TEXT REFERENCES utilities(code),
  file_name TEXT NOT NULL,
  file_path TEXT,
  document_type TEXT NOT NULL DEFAULT 'unknown',
  parser_status TEXT NOT NULL DEFAULT 'pending',
  parser_model TEXT,
  parsed_at TEXT,
  UNIQUE (dataset_id, file_name)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  utility_code TEXT NOT NULL REFERENCES utilities(code),
  state TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  source_row INTEGER,
  source_project_id TEXT,
  in_service_date TEXT CHECK (in_service_date IS NULL OR in_service_date GLOB '????-??-??'),
  raw_date TEXT,
  document_id INTEGER REFERENCES source_documents(id),
  document_page INTEGER,
  status TEXT DEFAULT 'planned',
  voltage_kv REAL,
  asset_type TEXT,
  work_type TEXT,
  estimated_cost_usd REAL,
  location_confidence REAL DEFAULT 0.5 CHECK (location_confidence BETWEEN 0 AND 1),
  date_confidence REAL DEFAULT 0.5 CHECK (date_confidence BETWEEN 0 AND 1),
  resource_confidence REAL DEFAULT 0.5 CHECK (resource_confidence BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS idx_projects_dataset ON projects(dataset_id);
CREATE INDEX IF NOT EXISTS idx_projects_utility ON projects(utility_code);
CREATE INDEX IF NOT EXISTS idx_projects_date ON projects(in_service_date);

CREATE TABLE IF NOT EXISTS project_endpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  endpoint_order INTEGER NOT NULL CHECK (endpoint_order IN (1, 2)),
  name TEXT NOT NULL,
  longitude REAL CHECK (longitude BETWEEN -180 AND 180),
  latitude REAL CHECK (latitude BETWEEN -90 AND 90),
  coordinate_source TEXT DEFAULT 'workbook',
  coordinate_confidence REAL DEFAULT 0.5 CHECK (coordinate_confidence BETWEEN 0 AND 1),
  UNIQUE (project_id, endpoint_order)
);

CREATE VIEW IF NOT EXISTS project_centers AS
SELECT
  p.id AS project_id,
  AVG(e.longitude) AS longitude,
  AVG(e.latitude) AS latitude,
  COUNT(e.longitude) AS located_endpoint_count
FROM projects p
JOIN project_endpoints e ON e.project_id = p.id
WHERE e.longitude IS NOT NULL AND e.latitude IS NOT NULL
GROUP BY p.id;

CREATE TABLE IF NOT EXISTS geo_contexts (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state_fips TEXT,
  county_fips TEXT,
  county_name TEXT,
  census_place_geoid TEXT,
  tiger_linear_feature_id TEXT,
  nearest_road_mi REAL,
  nearest_substation_mi REAL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS scoring_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  max_distance_mi REAL NOT NULL DEFAULT 25,
  immediate_distance_mi REAL NOT NULL DEFAULT 1,
  local_distance_mi REAL NOT NULL DEFAULT 5,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS scoring_parameters (
  profile_id INTEGER NOT NULL REFERENCES scoring_profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  weight REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('higher_is_better', 'lower_is_better', 'categorical')),
  description TEXT,
  PRIMARY KEY (profile_id, key)
);

CREATE TABLE IF NOT EXISTS opportunity_scores (
  id TEXT PRIMARY KEY,
  dataset_id INTEGER NOT NULL REFERENCES dataset_versions(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES scoring_profiles(id) ON DELETE CASCADE,
  project_a TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_b TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  center_distance_mi REAL NOT NULL,
  distance_tier INTEGER NOT NULL CHECK (distance_tier IN (1, 2, 3)),
  date_gap_days INTEGER,
  same_state INTEGER NOT NULL DEFAULT 0 CHECK (same_state IN (0, 1)),
  location_confidence_score REAL NOT NULL DEFAULT 0,
  timing_score REAL NOT NULL DEFAULT 0,
  resource_score REAL NOT NULL DEFAULT 0,
  composite_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (dataset_id, profile_id, project_a, project_b)
);

CREATE INDEX IF NOT EXISTS idx_scores_rank ON opportunity_scores(dataset_id, profile_id, composite_score DESC, distance_tier, center_distance_mi);

CREATE TABLE IF NOT EXISTS document_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  page_number INTEGER,
  extraction_kind TEXT NOT NULL,
  extracted_json TEXT NOT NULL,
  confidence REAL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW IF NOT EXISTS dashboard_projects AS
SELECT
  p.id,
  p.utility_code,
  u.display_name AS utility_name,
  p.state,
  p.name,
  p.short_name,
  p.in_service_date,
  p.raw_date,
  p.source_row,
  p.source_project_id,
  sd.file_name AS document,
  p.document_page,
  pc.longitude AS center_longitude,
  pc.latitude AS center_latitude,
  pc.located_endpoint_count,
  p.location_confidence,
  p.date_confidence,
  p.resource_confidence
FROM projects p
JOIN utilities u ON u.code = p.utility_code
LEFT JOIN source_documents sd ON sd.id = p.document_id
LEFT JOIN project_centers pc ON pc.project_id = p.id;
