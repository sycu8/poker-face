-- Bounded membership convergence ops when DO succeeded but D1 write failed.
CREATE TABLE IF NOT EXISTS membership_ops (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_membership_ops_room ON membership_ops(room_id, created_at);
