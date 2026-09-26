"""Build the local SQLite database from db/data/projects.json.

This script creates db/data/gridlock.sqlite for local development. The generated
SQLite file is intentionally reproducible from JSON and schema.sql.
"""
from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "db" / "schema.sql"
SOURCE = ROOT / "db" / "data" / "projects.json"
OUTPUT = ROOT / "db" / "data" / "gridlock.sqlite"
EARTH_RADIUS_MI = 3958.7613
UTILITY_NAMES = {
    "DESC": "Dominion Energy SC",
    "GPC": "Georgia Power",
    "SCE": "SC Electric",
    "NCE": "NC Electric",
    "GAE": "GA Electric",
    "ALE": "AL Electric",
    "FLE": "FL Electric",
}
UTILITY_STATE_SCOPE = {
    "DESC": "SC",
    "GPC": "GA",
    "SCE": "SC",
    "NCE": "NC",
    "GAE": "GA",
    "ALE": "AL",
    "FLE": "FL",
}
DOCUMENT_ROOT = ROOT / "ProjectListings"


def document_path(utility_code: str, file_name: str | None) -> str | None:
    if not file_name:
        return None
    folder = "Dominion Energy" if utility_code == "DESC" else "Georgia Power" if utility_code == "GPC" else ""
    candidate = DOCUMENT_ROOT / folder / file_name
    return str(candidate) if candidate.exists() else None


def center(project: dict) -> tuple[float, float] | None:
    points = [endpoint["coordinates"] for endpoint in project["endpoints"] if endpoint["coordinates"]]
    if not points:
        return None
    return (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))


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
    return abs((datetime.fromisoformat(a) - datetime.fromisoformat(b)).days)


def tier(distance: float) -> int | None:
    if not math.isfinite(distance) or distance < 0 or distance >= 25:
        return None
    return 1 if distance < 1 else 2 if distance < 5 else 3


def normalized_score(value: float, limit: float, lower_is_better: bool = True) -> float:
    clipped = max(0.0, min(limit, value))
    score = 1.0 - clipped / limit if lower_is_better else clipped / limit
    return round(score, 4)


def main() -> None:
    data = json.loads(SOURCE.read_text(encoding="utf-8"))
    if OUTPUT.exists():
        OUTPUT.unlink()
    con = sqlite3.connect(OUTPUT)
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA.read_text(encoding="utf-8"))

    con.execute(
        "INSERT INTO dataset_versions(name, source, reference_date, notes) VALUES (?, ?, ?, ?)",
        (data["name"], data["source"], data["referenceDate"], "Seeded from normalized prototype JSON."),
    )
    dataset_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]

    utility_codes = sorted({project["utility"] for project in data["projects"]})
    for code in utility_codes:
        con.execute(
            "INSERT INTO utilities(code, display_name, state_scope) VALUES (?, ?, ?)",
            (code, UTILITY_NAMES.get(code, code), UTILITY_STATE_SCOPE.get(code)),
        )

    documents: dict[tuple[str | None, str | None], int | None] = {}
    for project in data["projects"]:
        doc_name = project.get("document")
        key = (project["utility"], doc_name)
        if doc_name and key not in documents:
            con.execute(
                "INSERT INTO source_documents(dataset_id, utility_code, file_name, file_path, document_type, parser_status) VALUES (?, ?, ?, ?, ?, ?)",
                (dataset_id, project["utility"], doc_name, document_path(project["utility"], doc_name), "pdf", "registered"),
            )
            documents[key] = con.execute("SELECT last_insert_rowid()").fetchone()[0]
        elif key not in documents:
            documents[key] = None

        located = sum(1 for endpoint in project["endpoints"] if endpoint["coordinates"])
        location_confidence = 0.85 if located == 2 else 0.55 if located == 1 else 0.1
        con.execute(
            """
            INSERT INTO projects(
              id, dataset_id, utility_code, state, name, short_name, source_row,
              source_project_id, in_service_date, raw_date, document_id, document_page,
              status, voltage_kv, asset_type, work_type,
              location_confidence, date_confidence, resource_confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project["id"], dataset_id, project["utility"], project["state"], project["name"], project["shortName"],
                project["sourceRow"], project.get("sourceProjectId"), project.get("inServiceDate"), project.get("rawDate"),
                documents[key], project.get("documentPage"), project.get("status") or "planned", project.get("voltageKv"),
                project.get("assetType"), project.get("workType"), location_confidence, 0.7 if project.get("inServiceDate") else 0.2, 0.5,
            ),
        )
        for index, endpoint in enumerate(project["endpoints"], start=1):
            coords = endpoint["coordinates"]
            con.execute(
                """
                INSERT INTO project_endpoints(project_id, endpoint_order, name, longitude, latitude, coordinate_source, coordinate_confidence)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project["id"], index, endpoint["name"], coords[0] if coords else None, coords[1] if coords else None,
                    endpoint.get("coordinateSource", "workbook" if coords else "unresolved"),
                    0.35 if endpoint.get("coordinateSource") == "synthetic-test" else 0.75 if coords else 0.0,
                ),
            )

    con.execute(
        """
        INSERT INTO scoring_profiles(name, description, max_distance_mi, immediate_distance_mi, local_distance_mi, active)
        VALUES (?, ?, 25, 1, 5, 1)
        """,
        ("prototype-v1", "Distance-first score using timing and data-confidence signals."),
    )
    profile_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
    parameters = [
        ("distance", 0.45, "lower_is_better", "Closer project centers improve coordination potential."),
        ("timing", 0.25, "lower_is_better", "Closer planned dates improve coordination potential."),
        ("location_confidence", 0.20, "higher_is_better", "Better located projects receive higher confidence."),
        ("resource", 0.10, "higher_is_better", "Future placeholder for shared crews/equipment/material signals."),
    ]
    con.executemany(
        "INSERT INTO scoring_parameters(profile_id, key, weight, direction, description) VALUES (?, ?, ?, ?, ?)",
        [(profile_id, *row) for row in parameters],
    )

    projects = data["projects"]
    centers = {project["id"]: center(project) for project in projects}
    weights = {key: weight for key, weight, _, _ in parameters}
    for i, a in enumerate(projects):
        for b in projects[i + 1:]:
            if a["utility"] == b["utility"] or not centers[a["id"]] or not centers[b["id"]]:
                continue
            distance = distance_miles(centers[a["id"]], centers[b["id"]])
            distance_tier = tier(distance)
            if distance_tier is None:
                continue
            gap = date_gap(a.get("inServiceDate"), b.get("inServiceDate"))
            distance_score = normalized_score(distance, 25)
            timing_score = normalized_score(gap if gap is not None else 3650, 3650)
            location_score = min(
                con.execute("SELECT location_confidence FROM projects WHERE id = ?", (a["id"],)).fetchone()[0],
                con.execute("SELECT location_confidence FROM projects WHERE id = ?", (b["id"],)).fetchone()[0],
            )
            resource_score = 0.5
            composite = round(
                distance_score * weights["distance"]
                + timing_score * weights["timing"]
                + location_score * weights["location_confidence"]
                + resource_score * weights["resource"],
                4,
            )
            pair = sorted([a["id"], b["id"]])
            con.execute(
                """
                INSERT INTO opportunity_scores(
                  id, dataset_id, profile_id, project_a, project_b, center_distance_mi,
                  distance_tier, date_gap_days, same_state, location_confidence_score,
                  timing_score, resource_score, composite_score
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "__".join(pair), dataset_id, profile_id, pair[0], pair[1], round(distance, 6), distance_tier, gap,
                    int(a["state"] == b["state"]), location_score, timing_score, resource_score, composite,
                ),
            )

    con.commit()
    count = con.execute("SELECT COUNT(*) FROM opportunity_scores").fetchone()[0]
    con.close()
    print(f"Created {OUTPUT} with {len(projects)} projects and {count} scored opportunities")


if __name__ == "__main__":
    main()
