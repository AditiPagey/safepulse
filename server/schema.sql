CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);

CREATE TABLE IF NOT EXISTS regions (code text PRIMARY KEY, name text, lat double precision, lng double precision);

CREATE TABLE IF NOT EXISTS shelters (
  shelter_id serial PRIMARY KEY, name text, address text,
  lat double precision, lng double precision, capacity int);

CREATE TABLE IF NOT EXISTS users (
  user_id uuid PRIMARY KEY, token text NOT NULL, home_region text REFERENCES regions(code),
  created_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS users_token ON users (token);

CREATE TABLE IF NOT EXISTS notifications (
  report_id uuid PRIMARY KEY, user_id uuid, event_ts timestamptz NOT NULL,
  received_ts timestamptz NOT NULL DEFAULT now(),
  lat double precision, lng double precision, accuracy_m double precision,
  loc_source text CHECK (loc_source IN ('gps','ip','region')),
  score real, peak_g real, duration_ms int, home_region text, sender_ip inet,
  counted boolean DEFAULT true, duplicate_user boolean DEFAULT false, clock_skew boolean DEFAULT false,
  answer text, answer_ts timestamptz,
  event_id text, late boolean DEFAULT false, is_sim boolean DEFAULT false);
CREATE INDEX IF NOT EXISTS notif_unassigned ON notifications (event_ts) WHERE event_id IS NULL AND counted;
CREATE INDEX IF NOT EXISTS notif_user ON notifications (user_id, event_ts);

CREATE TABLE IF NOT EXISTS event_index (
  event_id text PRIMARY KEY, table_name text UNIQUE NOT NULL,
  type text CHECK (type IN ('accident','disaster')), status text CHECK (status IN ('active','resolved')),
  center_lat double precision, center_lng double precision, radius_m double precision,
  opened_at timestamptz, first_signal_ts timestamptz, resolved_at timestamptz, resolved_by text,
  parent_event_id text, is_sim boolean DEFAULT false,
  total int DEFAULT 0, pending int DEFAULT 0, safe int DEFAULT 0, unsafe int DEFAULT 0,
  no_response int DEFAULT 0, found_safe int DEFAULT 0, shelters_sent_at timestamptz);

CREATE TABLE IF NOT EXISTS event_log (
  id bigserial PRIMARY KEY, event_id text, ts timestamptz DEFAULT now(),
  actor text, action text, detail jsonb);
