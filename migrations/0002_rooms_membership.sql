-- rooms, invites, join requests, membership
CREATE TABLE rooms (
  id TEXT PRIMARY KEY NOT NULL,
  host_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  small_blind INTEGER NOT NULL,
  big_blind INTEGER NOT NULL,
  starting_stack INTEGER NOT NULL,
  pot_cap_multiplier REAL NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'open',
  realtimekit_meeting_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_rooms_invite ON rooms(invite_code);
CREATE INDEX idx_rooms_host ON rooms(host_user_id);

CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  seat_index INTEGER,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE join_requests (
  id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  UNIQUE (room_id, idempotency_key)
);

CREATE INDEX idx_join_requests_room ON join_requests(room_id, status);
