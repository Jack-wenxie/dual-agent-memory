PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 250;
PRAGMA user_version = 2;

CREATE TABLE IF NOT EXISTS projection_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS records (
  record_id TEXT PRIMARY KEY,
  record_ref TEXT NOT NULL UNIQUE CHECK (length(record_ref) = 68 AND substr(record_ref,1,4) = 'rr1_' AND substr(record_ref,5) NOT GLOB '*[^0-9a-f]*'),
  origin TEXT NOT NULL,
  kind TEXT NOT NULL,
  project_id TEXT,
  entity TEXT,
  authority TEXT NOT NULL DEFAULT 'memory',
  authority_kind TEXT NOT NULL DEFAULT 'memory',
  authority_rank INTEGER NOT NULL DEFAULT 0,
  authority_resolution TEXT NOT NULL DEFAULT 'resolved',
  status TEXT NOT NULL DEFAULT 'active',
  valid_from TEXT,
  valid_to TEXT,
  recorded_time TEXT NOT NULL,
  supersedes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supersedes)),
  superseded_by TEXT,
  canonical_record_id TEXT,
  content_hash TEXT NOT NULL,
  answerability TEXT NOT NULL DEFAULT 'evidence',
  safe_excerpt TEXT NOT NULL,
  safe_excerpt_status TEXT NOT NULL DEFAULT 'accepted',
  source_pointer TEXT NOT NULL,
  bti_anchor TEXT,
  authority_verified_at TEXT,
  fresh_until TEXT,
  search_text TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  scope TEXT NOT NULL DEFAULT 'global',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  compiled_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS record_sources (
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  root_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  merge_basis TEXT NOT NULL DEFAULT 'native_source',
  PRIMARY KEY (record_id, root_id, relative_path)
) STRICT;

CREATE TABLE IF NOT EXISTS aliases (
  alias_norm TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  PRIMARY KEY (alias_norm, record_id, alias)
) STRICT;

CREATE TABLE IF NOT EXISTS short_grams (
  gram TEXT NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (gram, record_id, source)
) STRICT;

CREATE TABLE IF NOT EXISTS supersession_edges (
  predecessor_id TEXT NOT NULL,
  successor_id TEXT NOT NULL,
  PRIMARY KEY (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
) STRICT;

CREATE TABLE IF NOT EXISTS authority_routes (
  route_id TEXT PRIMARY KEY,
  alias_norm TEXT NOT NULL,
  project_id TEXT,
  intent TEXT NOT NULL DEFAULT 'status',
  authority_target TEXT NOT NULL,
  target_ref TEXT CHECK (target_ref IS NULL OR (length(target_ref) = 68 AND substr(target_ref,1,4) = 'ar1_' AND substr(target_ref,5) NOT GLOB '*[^0-9a-f]*')),
  root_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  section TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  answerability TEXT NOT NULL DEFAULT 'route_authority',
  resolution TEXT NOT NULL DEFAULT 'resolved',
  fresh_until TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS entity_routes (
  alias_norm TEXT NOT NULL,
  entity TEXT NOT NULL,
  source_pointer TEXT NOT NULL,
  entity_ref TEXT NOT NULL CHECK (length(entity_ref) = 68 AND substr(entity_ref,1,4) = 'er1_' AND substr(entity_ref,5) NOT GLOB '*[^0-9a-f]*'),
  root_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  answerability TEXT NOT NULL DEFAULT 'pointer_only',
  resolution TEXT NOT NULL DEFAULT 'resolved',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  score REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL,
  PRIMARY KEY (alias_norm, entity, source_pointer)
) STRICT;

CREATE TABLE IF NOT EXISTS source_state (
  source_key TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  record_id TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'applied', 'failed')),
  created_at TEXT NOT NULL,
  applied_at TEXT,
  error TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS quarantine (
  source_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  source_hash TEXT,
  observed_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projection_runs (
  run_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  source_count INTEGER,
  record_count INTEGER,
  checksum TEXT,
  status TEXT NOT NULL
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  record_id UNINDEXED,
  search_text,
  tokenize = 'trigram case_sensitive 0'
);

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts_vocab USING fts5vocab(records_fts, 'row');

CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id, active);
CREATE INDEX IF NOT EXISTS idx_records_ref ON records(record_ref);
CREATE INDEX IF NOT EXISTS idx_records_answerability ON records(answerability, active);
CREATE INDEX IF NOT EXISTS idx_records_recorded_time ON records(recorded_time DESC);
CREATE INDEX IF NOT EXISTS idx_aliases_norm ON aliases(alias_norm, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_short_grams ON short_grams(gram, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_supersession_successor ON supersession_edges(successor_id);
CREATE INDEX IF NOT EXISTS idx_authority_alias ON authority_routes(alias_norm, intent, active);
CREATE INDEX IF NOT EXISTS idx_authority_ref ON authority_routes(target_ref, active);
CREATE INDEX IF NOT EXISTS idx_entity_alias ON entity_routes(alias_norm, score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_ref ON entity_routes(entity_ref, active);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state, created_at);
