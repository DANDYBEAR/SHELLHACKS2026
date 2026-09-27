"""Rebuild opportunity_scores for the current SQLite database without reimporting projects."""
from __future__ import annotations

import math
import sqlite3
from datetime import datetime
from pathlib import Path

from scoring import opportunity_points

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "db" / "data" / "gridlock.sqlite"
EARTH_RADIUS_MI = 3958.7613


def distance_miles(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(min(1, max(0, h))))


def date_gap(a: str | None, b: str | None) -> int | None:
    if not a or not b:
        return None
    try:
        return abs((datetime.fromisoformat(a) - datetime.fromisoformat(b)).days)
    except ValueError:
        return None


def distance_tier(distance: float) -> int | None:
    if not math.isfinite(distance) or distance < 0 or distance > 25:
        return None
    return 1 if distance < 1 else 2 if distance < 5 else 3


def ensure_score_columns(con: sqlite3.Connection) -> None:
    existing = {row["name"] for row in con.execute("PRAGMA table_info(opportunity_scores)")}
    columns = {
        "distance_score": "REAL NOT NULL DEFAULT 0",
        "timeline_score": "REAL NOT NULL DEFAULT 0",
        "compatibility_score": "REAL NOT NULL DEFAULT 0",
        "total_score": "REAL NOT NULL DEFAULT 0",
    }
    for name, definition in columns.items():
        if name not in existing:
            con.execute(f"ALTER TABLE opportunity_scores ADD COLUMN {name} {definition}")


def active_profile(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT id FROM scoring_profiles WHERE name = ?", ("prototype-v2",)).fetchone()
    if row:
        con.execute("UPDATE scoring_profiles SET active = CASE WHEN id = ? THEN 1 ELSE 0 END", (row["id"],))
        profile_id = int(row["id"])
        con.execute("UPDATE scoring_profiles SET description = ? WHERE id = ?", ("100-point opportunity score: distance 50 and timeline 50.", profile_id))
        con.execute("DELETE FROM scoring_parameters WHERE profile_id = ?", (profile_id,))
    else:
        con.execute(
            """
            INSERT INTO scoring_profiles(name, description, max_distance_mi, immediate_distance_mi, local_distance_mi, active)
            VALUES (?, ?, 25, 1, 5, 1)
            """,
            ("prototype-v2", "100-point opportunity score: distance 50 and timeline 50."),
        )
        profile_id = int(con.execute("SELECT last_insert_rowid()").fetchone()[0])
    con.execute("UPDATE scoring_profiles SET active = CASE WHEN id = ? THEN 1 ELSE 0 END", (profile_id,))
    con.executemany(
        "INSERT OR REPLACE INTO scoring_parameters(profile_id, key, weight, direction, description) VALUES (?, ?, ?, ?, ?)",
        [
            (profile_id, "distance", 50, "higher_is_better", "Center-to-center distance points. Pairs over 25 miles are excluded."),
            (profile_id, "timeline", 50, "higher_is_better", "Construction overlap/date-proximity points. Imported in-service dates currently use date proximity."),
        ],
    )
    return profile_id


def main() -> None:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    ensure_score_columns(con)
    profile_id = active_profile(con)
    dataset_id = int(con.execute("SELECT id FROM dataset_versions ORDER BY id DESC LIMIT 1").fetchone()[0])
    projects = con.execute(
        """
        SELECT p.id, p.utility_code, p.state, p.in_service_date, p.location_confidence,
          pc.longitude, pc.latitude
        FROM projects p
        JOIN project_centers pc ON pc.project_id = p.id
        WHERE p.dataset_id = ?
        ORDER BY p.source_row, p.id
        """,
        (dataset_id,),
    ).fetchall()
    con.execute("DELETE FROM opportunity_scores WHERE dataset_id = ?", (dataset_id,))
    inserted = 0
    for i, a in enumerate(projects):
        for b in projects[i + 1:]:
            if a["utility_code"] == b["utility_code"]:
                continue
            distance = distance_miles((a["longitude"], a["latitude"]), (b["longitude"], b["latitude"]))
            tier = distance_tier(distance)
            if tier is None:
                continue
            gap = date_gap(a["in_service_date"], b["in_service_date"])
            distance_points, timeline_points, compatibility_points, total_points = opportunity_points(distance, gap)
            timing_score = round(timeline_points / 50, 4)
            resource_score = 0
            composite = round(total_points / 100, 4)
            location_score = min(a["location_confidence"], b["location_confidence"])
            pair = sorted([a["id"], b["id"]])
            con.execute(
                """
                INSERT INTO opportunity_scores(
                  id, dataset_id, profile_id, project_a, project_b, center_distance_mi,
                  distance_tier, date_gap_days, same_state, location_confidence_score,
                  timing_score, resource_score, composite_score,
                  distance_score, timeline_score, compatibility_score, total_score
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "__".join(pair), dataset_id, profile_id, pair[0], pair[1], round(distance, 6), tier, gap,
                    int(a["state"] == b["state"]), location_score, timing_score, resource_score, composite,
                    distance_points, timeline_points, compatibility_points, total_points,
                ),
            )
            inserted += 1
    con.commit()
    con.close()
    print(f"Rebuilt {inserted} opportunity scores in {DB}")


if __name__ == "__main__":
    main()
