-- completed hand summaries + idempotency ledger
CREATE TABLE hand_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  hand_number INTEGER NOT NULL,
  sequence_end INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (room_id, hand_number)
);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE TABLE archive_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL,
  hand_number INTEGER,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
