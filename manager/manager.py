#!/usr/bin/env python3
"""SafePulse table manager.

The only process that creates event tables and assigns reports to events.

Every tick (~1 s) it:
  1. reads new unassigned reports from the `notifications` queue,
  2. JOIN pass  - routes reports that fall inside an existing event into its table,
  3. CLUSTER    - puts the rest into in-memory clusters (dict). A cluster is anchored on
                  its first report and collects reports close in space and within
                  `window_s` (5 s) of that first report. Two rules run side by side:
                  accident (tight radius) and disaster (city-wide, many reports),
  4. REGISTER   - a cluster that reaches min_count becomes an event: CREATE TABLE,
                  insert the cases, assign the reports,
  5. EXPIRE     - clusters whose window closed without reaching min_count are dropped
                  (lone reports never reach an event table),
  6. FLUSH      - unassigned notification rows older than lone_retention_s are deleted.

Changes are pushed to the Node server through Postgres NOTIFY (channel sp_events);
Node forwards them to the dashboard over SSE.
"""
import json
import logging
import math
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from dotenv import load_dotenv
from psycopg import sql
from psycopg.rows import dict_row

load_dotenv(Path(__file__).resolve().parent.parent / "server" / ".env")

DATABASE_URL = os.environ.get("DATABASE_URL")
DEMO_MODE = os.environ.get("DEMO_MODE", "false").lower() == "true"
TICK_S = float(os.environ.get("MANAGER_INTERVAL_S", "1"))
GRACE_S = 3.0          # allowance for network delay after a cluster's window closes
FLUSH_EVERY_S = 30.0
LOCK_KEY = 727001      # same advisory lock Node uses around answers
CHANNEL = "sp_events"
RULES = ("accident", "disaster")
TABLE_RE = re.compile(r"^ev(sim)?_[a-z0-9_]+$")

log = logging.getLogger("manager")


# ---------------------------------------------------------------- helpers

def iso(dt):
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def haversine(lat1, lng1, lat2, lng2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


_B32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat, lng, precision=6):
    lat_r, lng_r = [-90.0, 90.0], [-180.0, 180.0]
    bits, bit, ch, even, out = [16, 8, 4, 2, 1], 0, 0, True, []
    while len(out) < precision:
        rng, val = (lng_r, lng) if even else (lat_r, lat)
        mid = (rng[0] + rng[1]) / 2
        if val > mid:
            ch |= bits[bit]
            rng[0] = mid
        else:
            rng[1] = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            out.append(_B32[ch])
            bit, ch = 0, 0
    return "".join(out)


def event_obj(r):
    return {
        "event_id": r["event_id"],
        "type": r["type"],
        "status": r["status"],
        "center": {"lat": r["center_lat"], "lng": r["center_lng"]},
        "radius_m": r["radius_m"],
        "opened_at": iso(r["opened_at"]),
        "first_signal_ts": iso(r["first_signal_ts"]),
        "resolved_at": iso(r["resolved_at"]),
        "parent_event_id": r["parent_event_id"],
        "is_sim": r["is_sim"],
        "counts": {
            "total": r["total"], "pending": r["pending"], "safe": r["safe"],
            "unsafe": r["unsafe"], "no_response": r["no_response"], "found_safe": r["found_safe"],
        },
        "shelters_sent_at": iso(r["shelters_sent_at"]),
    }


def case_obj(r):
    return {
        "report_id": str(r["report_id"]),
        "user_short": str(r["user_id"] or "")[-6:],
        "event_ts": iso(r["event_ts"]),
        "joined_at": iso(r["joined_at"]),
        "lat": r["lat"], "lng": r["lng"], "accuracy_m": r["accuracy_m"],
        "loc_source": r["loc_source"], "score": r["score"],
        "status": r["status"], "answer": r["answer"], "answer_ts": iso(r["answer_ts"]),
        "deadline_ts": iso(r["deadline_ts"]), "late": r["late"],
        "shelters_sent_at": iso(r["shelters_sent_at"]), "found_safe_at": iso(r["found_safe_at"]),
    }


def notify(cur, name, payload):
    notify_many(cur, [(name, payload)])


def notify_many(cur, items):
    """One round trip for any number of NOTIFYs (delivered when the transaction commits)."""
    if not items:
        return
    msgs = [json.dumps({"name": n, "payload": p}) for n, p in items]
    cur.execute("SELECT pg_notify(%s, m) FROM unnest(%s::text[]) AS m", (CHANNEL, msgs))


def status_from_answer(answer):
    if answer == "safe":
        return "safe"
    if answer == "help":
        return "unsafe"
    return "pending"


def timeout_seconds(cfg):
    return 60 if DEMO_MODE else cfg["timeout_seconds"]


CREATE_TABLE_SQL = """
CREATE TABLE {t} (
  report_id uuid PRIMARY KEY, user_id uuid, event_ts timestamptz, joined_at timestamptz DEFAULT now(),
  lat double precision, lng double precision, accuracy_m double precision, loc_source text, score real,
  status text NOT NULL CHECK (status IN ('pending','safe','unsafe','no_response','found_safe')),
  answer text, answer_ts timestamptz, deadline_ts timestamptz NOT NULL,
  late boolean DEFAULT false, late_answer boolean DEFAULT false,
  shelters jsonb, shelters_sent_at timestamptz, found_safe_at timestamptz, notes text)
"""

# Copies queue rows into an event table in ONE statement. Status comes from any answer already
# given; deadline counts from the phone's event_ts; `late` is true for resolved events or slow reports.
INSERT_CASES_SQL = """
INSERT INTO {t} (report_id, user_id, event_ts, lat, lng, accuracy_m, loc_source, score,
                 status, answer, answer_ts, deadline_ts, late, shelters_sent_at)
SELECT report_id, user_id, event_ts, lat, lng, accuracy_m, loc_source, score,
       CASE answer WHEN 'safe' THEN 'safe' WHEN 'help' THEN 'unsafe' ELSE 'pending' END,
       answer, answer_ts,
       event_ts + make_interval(secs => %(timeout)s),
       (%(force_late)s OR (received_ts - event_ts) > make_interval(secs => %(late_s)s)),
       CASE WHEN answer = 'safe' AND %(auto)s THEN now() END
FROM notifications WHERE report_id = ANY(%(ids)s) AND event_id IS NULL
ON CONFLICT (report_id) DO NOTHING
RETURNING *
"""


def insert_cases(cur, t, event_id, ids, cfg, force_late, late_s):
    """Copy queue rows into the event table. Anyone already safe gets shelters_sent_at right away."""
    cur.execute(
        sql.SQL(INSERT_CASES_SQL).format(t=t),
        {
            "timeout": timeout_seconds(cfg), "force_late": force_late, "late_s": late_s, "ids": ids,
            "auto": cfg.get("auto_send_shelters", True),
        },
    )
    rows = cur.fetchall()
    if any(r["shelters_sent_at"] for r in rows):
        cur.execute(
            "UPDATE event_index SET shelters_sent_at = COALESCE(shelters_sent_at, now()) WHERE event_id = %s",
            (event_id,),
        )
    return rows


def safe_table(name):
    if not TABLE_RE.match(name):
        raise ValueError(f"invalid table name: {name}")
    return sql.Identifier(name)


# ---------------------------------------------------------------- clusters

class Cluster:
    def __init__(self, rule, n, cid):
        self.rule, self.cid = rule, cid
        self.first_event_ts = n["event_ts"]
        self.first_received = n["received_ts"]
        self.members = {}
        self.clat = self.clng = 0.0
        self.add(n)

    def add(self, n):
        self.members[n["report_id"]] = n
        k = len(self.members)
        self.clat = sum(m["lat"] for m in self.members.values()) / k
        self.clng = sum(m["lng"] for m in self.members.values()) / k

    def remove(self, ids):
        for i in ids:
            self.members.pop(i, None)
        if self.members:
            k = len(self.members)
            self.clat = sum(m["lat"] for m in self.members.values()) / k
            self.clng = sum(m["lng"] for m in self.members.values()) / k


class Manager:
    def __init__(self, conn):
        self.conn = conn
        self.clusters = {r: {} for r in RULES}
        self.next_cid = 1
        self.seen = {}               # report_id -> db time first seen (pruned)
        self.last_flush = 0.0

    # ----- settings / db time
    def load_settings(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT value FROM settings WHERE key = 'main'")
            return cur.fetchone()["value"]

    def db_now(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT now() AS t")
            return cur.fetchone()["t"]

    # ----- queue
    def fetch_new(self, horizon_s):
        with self.conn.cursor() as cur:
            cur.execute(
                """SELECT report_id, user_id, event_ts, received_ts, lat, lng, accuracy_m, loc_source,
                          score, answer, answer_ts, is_sim
                   FROM notifications
                   WHERE event_id IS NULL AND counted AND lat IS NOT NULL
                     AND received_ts > now() - make_interval(secs => %s)
                   ORDER BY received_ts""",
                (horizon_s,),
            )
            return [r for r in cur.fetchall() if r["report_id"] not in self.seen]

    def load_open_events(self, cfg):
        with self.conn.cursor() as cur:
            cur.execute(
                """SELECT * FROM event_index
                   WHERE status = 'active'
                      OR (status = 'resolved' AND resolved_at > now() - make_interval(hours => %s))""",
                (cfg.get("late_join_hours", 24),),
            )
            return cur.fetchall()

    # ----- JOIN pass (Step A)
    def find_event(self, n, events, cfg):
        best = None
        for ev in events:
            rule = cfg["rules"][ev["type"]]
            if n["accuracy_m"] is not None and n["accuracy_m"] > rule["max_accuracy_m"]:
                continue
            if haversine(n["lat"], n["lng"], ev["center_lat"], ev["center_lng"]) > ev["radius_m"]:
                continue
            if n["event_ts"] < ev["first_signal_ts"] - timedelta(seconds=rule["window_s"]):
                continue
            if ev["status"] == "resolved" and n["event_ts"] > ev["resolved_at"]:
                continue
            if best is None or ev["radius_m"] < best["radius_m"]:
                best = ev
        return best

    def join_event(self, event_id, members, cfg):
        late_threshold = cfg.get("late_threshold_s", 60)
        joined = []
        with self.conn.transaction():
            cur = self.conn.cursor()
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
            cur.execute("SELECT * FROM event_index WHERE event_id = %s", (event_id,))
            ev = cur.fetchone()
            if ev is None:
                return
            t = safe_table(ev["table_name"])
            joined = insert_cases(
                cur, t, event_id, [m["report_id"] for m in members], cfg,
                ev["status"] == "resolved", late_threshold,
            )
            ids = [r["report_id"] for r in joined]
            if ids:
                cur.execute(
                    "UPDATE notifications SET event_id = %s WHERE report_id = ANY(%s)", (event_id, ids)
                )
                ev_row = self.refresh_counts(cur, ev)
                self.log_event(cur, event_id, "joined", {"count": len(ids)})
                if ev_row["type"] == "accident" and ev_row["total"] >= cfg["rules"]["disaster"]["min_count"]:
                    cur.execute("UPDATE event_index SET type = 'disaster' WHERE event_id = %s RETURNING *", (event_id,))
                    ev_row = cur.fetchone()
                    self.log_event(cur, event_id, "type_escalated", {"total": ev_row["total"]})
                notify_many(cur, [
                    ("case_updated", {"event_id": event_id, "case": case_obj(r)}) for r in joined
                ] + [("event_updated", event_obj(ev_row))])
        if joined:
            log.info("joined %d report(s) into %s", len(joined), event_id)
            self.drop_members([r["report_id"] for r in joined])

    # ----- clustering
    def add_to_clusters(self, n, cfg):
        for rule_name in RULES:
            rule = cfg["rules"][rule_name]
            if n["accuracy_m"] is not None and n["accuracy_m"] > rule["max_accuracy_m"]:
                continue
            best, best_d = None, None
            for c in self.clusters[rule_name].values():
                if abs((n["event_ts"] - c.first_event_ts).total_seconds()) > rule["window_s"]:
                    continue
                d = haversine(n["lat"], n["lng"], c.clat, c.clng)
                if d <= rule["radius_m"] and (best is None or d < best_d):
                    best, best_d = c, d
            if best is not None:
                best.add(n)
            else:
                cid = self.next_cid
                self.next_cid += 1
                self.clusters[rule_name][cid] = Cluster(rule_name, n, cid)

    def drop_members(self, ids):
        for rule_name in RULES:
            for cid in list(self.clusters[rule_name]):
                c = self.clusters[rule_name][cid]
                c.remove(ids)
                if not c.members:
                    del self.clusters[rule_name][cid]

    def evaluate_clusters(self, cfg):
        for rule_name in RULES:
            rule = cfg["rules"][rule_name]
            for cid in list(self.clusters[rule_name]):
                c = self.clusters[rule_name].get(cid)
                if c is None or len(c.members) < rule["min_count"]:
                    continue
                ev = self.register_event(rule_name, rule, list(c.members.values()), cfg)
                if ev is not None:
                    self.drop_members([m["report_id"] for m in c.members.values()])

    def expire_clusters(self, cfg, now):
        for rule_name in RULES:
            window = cfg["rules"][rule_name]["window_s"]
            for cid in list(self.clusters[rule_name]):
                c = self.clusters[rule_name][cid]
                if (now - c.first_received).total_seconds() > window + GRACE_S:
                    if len(c.members) > 1:
                        log.info("%s cluster %d expired with %d report(s) (below minimum)",
                                 rule_name, cid, len(c.members))
                    del self.clusters[rule_name][cid]

    # ----- register (Step B)
    def register_event(self, rule_name, rule, members, cfg):
        with self.conn.transaction():
            cur = self.conn.cursor()
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
            cur.execute(
                """SELECT report_id, user_id, event_ts, received_ts, lat, lng, accuracy_m, loc_source,
                          score, answer, answer_ts, is_sim
                   FROM notifications WHERE report_id = ANY(%s) AND event_id IS NULL""",
                ([m["report_id"] for m in members],),
            )
            fresh = cur.fetchall()
            if len(fresh) < rule["min_count"]:
                return None

            clat = sum(n["lat"] for n in fresh) / len(fresh)
            clng = sum(n["lng"] for n in fresh) / len(fresh)
            max_d = max(haversine(n["lat"], n["lng"], clat, clng) for n in fresh)
            radius = max(rule["radius_m"], 1.2 * max_d)
            first_signal = min(n["event_ts"] for n in fresh)
            is_sim = any(n["is_sim"] for n in fresh)

            opened = datetime.now(timezone.utc)
            base = f"{'evsim' if is_sim else 'ev'}_{opened:%Y%m%d_%H%M%S}_{geohash(clat, clng, 6)}"
            event_id, k = base, 2
            while True:
                cur.execute("SELECT 1 FROM event_index WHERE event_id = %s", (event_id,))
                if cur.fetchone() is None:
                    break
                event_id = f"{base}_{k}"
                k += 1
            t = safe_table(event_id)

            cur.execute(sql.SQL(CREATE_TABLE_SQL).format(t=t))
            cur.execute(sql.SQL("CREATE INDEX ON {t} (status)").format(t=t))
            cur.execute(
                """INSERT INTO event_index
                     (event_id, table_name, type, status, center_lat, center_lng, radius_m,
                      opened_at, first_signal_ts, is_sim)
                   VALUES (%s,%s,%s,'active',%s,%s,%s,%s,%s,%s) RETURNING *""",
                (event_id, event_id, rule_name, clat, clng, radius, opened, first_signal, is_sim),
            )
            ev_row = cur.fetchone()
            ids = [n["report_id"] for n in fresh]
            insert_cases(cur, t, event_id, ids, cfg, False, 10 ** 9)   # registration cases are never "late"
            cur.execute("UPDATE notifications SET event_id = %s WHERE report_id = ANY(%s)", (event_id, ids))
            ev_row = self.refresh_counts(cur, ev_row)
            self.log_event(cur, event_id, "event_created", {"rule": rule_name, "members": len(fresh)})
            notify(cur, "event_created", event_obj(ev_row))
        log.info("EVENT %s created: %s, %d report(s), radius %.0f m", event_id, rule_name, len(fresh), radius)
        return ev_row

    # ----- shared bits
    def refresh_counts(self, cur, ev):
        t = safe_table(ev["table_name"])
        cur.execute(sql.SQL("SELECT status, count(*)::int AS n FROM {t} GROUP BY status").format(t=t))
        c = {"pending": 0, "safe": 0, "unsafe": 0, "no_response": 0, "found_safe": 0}
        total = 0
        for r in cur.fetchall():
            c[r["status"]] = r["n"]
            total += r["n"]
        cur.execute(
            """UPDATE event_index SET total=%s, pending=%s, safe=%s, unsafe=%s, no_response=%s, found_safe=%s
               WHERE event_id=%s RETURNING *""",
            (total, c["pending"], c["safe"], c["unsafe"], c["no_response"], c["found_safe"], ev["event_id"]),
        )
        return cur.fetchone()

    def log_event(self, cur, event_id, action, detail):
        cur.execute(
            "INSERT INTO event_log (event_id, actor, action, detail) VALUES (%s,'system',%s,%s)",
            (event_id, action, json.dumps(detail)),
        )

    def flush_lone(self, cfg):
        retention = cfg.get("lone_retention_s", 300)
        with self.conn.cursor() as cur:
            cur.execute(
                "DELETE FROM notifications WHERE event_id IS NULL AND received_ts < now() - make_interval(secs => %s)",
                (retention,),
            )
            if cur.rowcount:
                log.info("flushed %d lone report(s) older than %ds", cur.rowcount, retention)

    # ----- main tick
    def tick(self):
        cfg = self.load_settings()
        now = self.db_now()
        max_window = max(cfg["rules"][r]["window_s"] for r in RULES)
        horizon = max_window + GRACE_S + 10

        new = self.fetch_new(horizon)
        for n in new:
            self.seen[n["report_id"]] = now

        if new:
            events = self.load_open_events(cfg)
            by_id = {e["event_id"]: e for e in events}
            joins, rest = defaultdict(list), []
            for n in new:
                ev = self.find_event(n, events, cfg)
                if ev:
                    joins[ev["event_id"]].append(n)
                else:
                    rest.append(n)
            for event_id, members in joins.items():
                self.join_event(event_id, members, cfg)
            for n in rest:
                self.add_to_clusters(n, cfg)
            self.evaluate_clusters(cfg)

        self.expire_clusters(cfg, now)

        # prune the seen-set once reports are older than the horizon
        cutoff = now - timedelta(seconds=horizon + 5)
        for rid in [r for r, t in self.seen.items() if t < cutoff]:
            del self.seen[rid]

        if time.monotonic() - self.last_flush > FLUSH_EVERY_S:
            self.flush_lone(cfg)
            self.last_flush = time.monotonic()


def connect():
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s", datefmt="%H:%M:%S")
    if not DATABASE_URL:
        sys.exit("DATABASE_URL is not set (expected in server/.env)")
    log.info("table manager starting (demo_mode=%s, tick=%.1fs)", DEMO_MODE, TICK_S)
    manager = None
    while True:
        try:
            if manager is None:
                manager = Manager(connect())
                log.info("connected to database")
            manager.tick()
        except (psycopg.OperationalError, psycopg.InterfaceError) as e:
            log.error("database connection problem: %s; reconnecting in 3 s", e)
            try:
                manager.conn.close()
            except Exception:
                pass
            manager = None
            time.sleep(3)
            continue
        except Exception:
            log.exception("tick failed")
        time.sleep(TICK_S)


if __name__ == "__main__":
    main()
