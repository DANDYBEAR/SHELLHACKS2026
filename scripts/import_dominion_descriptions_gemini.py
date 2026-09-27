"""Use Gemini to extract Dominion project description rows from the 2024-2028 PDF.

Required environment:
  GEMINI_API_KEY

The import is intentionally strict:
- every stored row must include all requested sections
- total project cost must be numeric
- planned in-service date must be parseable
"""
from __future__ import annotations

import base64
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from import_ctpc_gemini import (
    MODEL,
    SCHEMA,
    center_from_rows,
    clean_cost,
    clean_text,
    date_gap,
    distance_miles,
    distance_tier,
    latest_dataset_id,
    load_env,
    normalized_score,
    parse_date,
    title_matches,
)

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "2024-2028-2million-and-above-project-descriptions.pdf"
DB = ROOT / "db" / "data" / "gridlock.sqlite"
UTILITY_CODE = "DESC"
UTILITY_NAME = "Dominion Energy SC"
PROJECT_PREFIX = "DESC24"


def clean_project_id(value: Any) -> str:
    return clean_text(value).upper()


def clean_cost_usd(value: Any) -> float | None:
    cost = clean_cost(value)
    if cost is None or cost <= 0:
        return None
    text = clean_text(value).lower()
    if "million" in text or re.search(r"\bm\b", text):
        return cost * 1_000_000
    return cost


def clean_row(row: dict[str, Any]) -> dict[str, Any] | None:
    title = clean_text(row.get("bold_title_name"))
    project_id = clean_project_id(row.get("project_id"))
    description = clean_text(row.get("project_description"))
    status = clean_text(row.get("project_status"))
    planned_date = clean_text(row.get("planned_in_service_date"))
    iso_date = parse_date(planned_date)
    cost_usd = clean_cost_usd(row.get("estimated_project_cost_total_usd"))

    if not all([title, project_id, description, status, planned_date, iso_date]):
        return None
    if cost_usd is None:
        return None
    return {
        "bold_title_name": title,
        "project_id": project_id,
        "project_description": description,
        "project_status": status,
        "planned_in_service_date": planned_date,
        "planned_in_service_date_iso": iso_date,
        "estimated_project_cost_total_usd": cost_usd,
    }


def gemini_extract(api_key: str) -> list[dict[str, Any]]:
    pdf_b64 = base64.b64encode(PDF.read_bytes()).decode("ascii")
    prompt = """
Extract all complete project entries from the attached 2024-2028 project descriptions PDF.

Return JSON only, as an object with a "projects" array. Each item must have exactly:
- bold_title_name: the bold title/name at the start of the entry
- project_id
- project_description
- project_status
- planned_in_service_date
- estimated_project_cost_total_usd

Rules:
- Use only actual project description entries.
- Do not include table of contents rows, headers, footers, page numbers, explanatory text, or partial fragments.
- Do not infer missing sections. If any requested section is blank, unreadable, absent, or uncertain, omit that entry.
- "Estimated Project Cost(Total)" must be the Total value only, not annual slices or subtotals.
- Return the total cost as a number in dollars. If the PDF shows a value in millions, convert it to dollars.
- Keep the planned in-service date exactly as shown in the date field.
- Return no markdown, commentary, or explanations.
""".strip()
    body = {
        "contents": [{
            "role": "user",
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": "application/pdf", "data": pdf_b64}},
            ],
        }],
        "generationConfig": {
            "temperature": 0,
            "response_mime_type": "application/json",
            "response_schema": {
                "type": "object",
                "properties": {
                    "projects": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "bold_title_name": {"type": "string"},
                                "project_id": {"type": "string"},
                                "project_description": {"type": "string"},
                                "project_status": {"type": "string"},
                                "planned_in_service_date": {"type": "string"},
                                "estimated_project_cost_total_usd": {"type": "number"},
                            },
                            "required": [
                                "bold_title_name",
                                "project_id",
                                "project_description",
                                "project_status",
                                "planned_in_service_date",
                                "estimated_project_cost_total_usd",
                            ],
                        },
                    },
                },
                "required": ["projects"],
            },
        },
    }
    request = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Gemini API request failed: HTTP {exc.code}\n{detail}") from exc

    text = "".join(
        part.get("text", "")
        for candidate in payload.get("candidates", [])
        for part in candidate.get("content", {}).get("parts", [])
    ).strip()
    if not text:
        raise SystemExit("Gemini response did not include JSON text.")
    data = json.loads(text)
    projects = data.get("projects")
    if not isinstance(projects, list):
        raise SystemExit("Gemini response JSON did not contain a projects array.")
    return projects


def project_db_id(project_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9]+", "_", project_id).strip("_").upper()
    return f"{PROJECT_PREFIX}_{safe}"


def ensure_utility(con: sqlite3.Connection) -> None:
    con.execute(
        """
        INSERT INTO utilities(code, display_name, state_scope)
        VALUES (?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name, state_scope = excluded.state_scope
        """,
        (UTILITY_CODE, UTILITY_NAME, "SC"),
    )


def ensure_source_document(con: sqlite3.Connection, dataset_id: int) -> int:
    existing = con.execute(
        "SELECT id FROM source_documents WHERE dataset_id = ? AND utility_code = ? AND file_name = ?",
        (dataset_id, UTILITY_CODE, PDF.name),
    ).fetchone()
    if existing:
        return int(existing[0])
    con.execute(
        """
        INSERT INTO source_documents(dataset_id, utility_code, file_name, file_path, document_type, parser_status)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (dataset_id, UTILITY_CODE, PDF.name, str(PDF), "pdf", "parsed-by-gemini"),
    )
    return int(con.execute("SELECT last_insert_rowid()").fetchone()[0])


def rebuild_opportunity_scores(con: sqlite3.Connection, dataset_id: int) -> int:
    profile = con.execute("SELECT id FROM scoring_profiles WHERE active = 1 ORDER BY id DESC LIMIT 1").fetchone()
    if not profile:
        return 0
    profile_id = int(profile[0])
    weights = {
        row[0]: row[1]
        for row in con.execute("SELECT key, weight FROM scoring_parameters WHERE profile_id = ?", (profile_id,))
    }
    projects = con.execute(
        """
        SELECT id, utility_code, state, in_service_date, location_confidence
        FROM projects
        WHERE dataset_id = ?
        ORDER BY source_row, id
        """,
        (dataset_id,),
    ).fetchall()
    centers: dict[str, tuple[float, float] | None] = {}
    for project in projects:
        endpoints = con.execute(
            "SELECT longitude, latitude FROM project_endpoints WHERE project_id = ? ORDER BY endpoint_order",
            (project["id"],),
        ).fetchall()
        centers[project["id"]] = center_from_rows(endpoints)
    con.execute("DELETE FROM opportunity_scores WHERE dataset_id = ?", (dataset_id,))
    inserted = 0
    for i, a in enumerate(projects):
        for b in projects[i + 1:]:
            if a["utility_code"] == b["utility_code"] or not centers[a["id"]] or not centers[b["id"]]:
                continue
            distance = distance_miles(centers[a["id"]], centers[b["id"]])
            tier = distance_tier(distance)
            if tier is None:
                continue
            gap = date_gap(a["in_service_date"], b["in_service_date"])
            distance_score = normalized_score(distance, 25)
            timing_score = normalized_score(gap if gap is not None else 3650, 3650)
            location_score = min(a["location_confidence"], b["location_confidence"])
            resource_score = 0.5
            composite = round(
                distance_score * weights.get("distance", 0.45)
                + timing_score * weights.get("timing", 0.25)
                + location_score * weights.get("location_confidence", 0.20)
                + resource_score * weights.get("resource", 0.10),
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
                    "__".join(pair), dataset_id, profile_id, pair[0], pair[1], round(distance, 6), tier, gap,
                    int(a["state"] == b["state"]), location_score, timing_score, resource_score, composite,
                ),
            )
            inserted += 1
    return inserted


def write_rows(rows: list[dict[str, Any]]) -> dict[str, int]:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    dataset_id = latest_dataset_id(con)
    ensure_utility(con)
    document_id = ensure_source_document(con, dataset_id)

    con.execute("DELETE FROM dominion_project_descriptions")
    con.execute("DELETE FROM projects WHERE id LIKE ?", (f"{PROJECT_PREFIX}_%",))
    con.executemany(
        """
        INSERT INTO dominion_project_descriptions(
          project_id, bold_title_name, project_description, project_status,
          planned_in_service_date, estimated_project_cost_total_usd, source_file
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                row["project_id"],
                row["bold_title_name"],
                row["project_description"],
                row["project_status"],
                row["planned_in_service_date"],
                row["estimated_project_cost_total_usd"],
                PDF.name,
            )
            for row in rows
        ],
    )

    located_count = 0
    for index, row in enumerate(rows, start=1):
        project_id = project_db_id(row["project_id"])
        locations = title_matches(f"{row['bold_title_name']} {row['project_description']}", "SC")
        if locations:
            located_count += 1
        state = locations[0][1] if locations else "SC"
        endpoint_rows: list[tuple[int, str, float | None, float | None, str, float]] = []
        for order in (1, 2):
            if order <= len(locations[:2]):
                label, _, lon, lat = locations[order - 1]
                endpoint_rows.append((order, label, lon, lat, "title-description-place", 0.5))
            else:
                endpoint_rows.append((order, f"{row['project_id']} location unresolved", None, None, "unresolved", 0.0))
        located_endpoints = min(2, len(locations))
        location_confidence = 0.6 if located_endpoints == 2 else 0.4 if located_endpoints == 1 else 0.1
        short_name = row["bold_title_name"][:76] + ("..." if len(row["bold_title_name"]) > 76 else "")
        con.execute(
            """
            INSERT INTO projects(
              id, dataset_id, utility_code, state, name, short_name, source_row,
              source_project_id, in_service_date, raw_date, document_id, document_page,
              status, voltage_kv, asset_type, work_type, estimated_cost_usd,
              location_confidence, date_confidence, resource_confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id, dataset_id, UTILITY_CODE, state, row["bold_title_name"], short_name, 40000 + index,
                row["project_id"], row["planned_in_service_date_iso"], row["planned_in_service_date"],
                document_id, None, row["project_status"], None, "Dominion project description",
                "2024-2028 $2M+ project", row["estimated_project_cost_total_usd"],
                location_confidence, 0.85, 0.5,
            ),
        )
        con.executemany(
            """
            INSERT INTO project_endpoints(project_id, endpoint_order, name, longitude, latitude, coordinate_source, coordinate_confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [(project_id, order, name, lon, lat, source, confidence) for order, name, lon, lat, source, confidence in endpoint_rows],
        )
        notes = [
            "Parsed from the 2024-2028 $2M+ project descriptions PDF by Gemini.",
            f"Project Description: {row['project_description']}",
            f"Estimated Project Cost(Total): ${row['estimated_project_cost_total_usd']:,.0f}",
        ]
        if not locations:
            notes.append("No recognized Carolinas place name was found, so this project is searchable but not mapped.")
        con.executemany(
            "INSERT INTO project_notes(project_id, note_order, note) VALUES (?, ?, ?)",
            [(project_id, order, note) for order, note in enumerate(notes, start=1)],
        )

    opportunities = rebuild_opportunity_scores(con, dataset_id)
    con.commit()
    con.close()
    return {
        "promoted_rows": len(rows),
        "city_geocoded_rows": located_count,
        "unresolved_coordinate_rows": len(rows) - located_count,
        "opportunity_scores": opportunities,
    }


def existing_rows() -> list[dict[str, Any]]:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = [
        {
            **dict(row),
            "planned_in_service_date_iso": parse_date(row["planned_in_service_date"]),
        }
        for row in con.execute(
            """
            SELECT project_id, bold_title_name, project_description, project_status,
              planned_in_service_date, estimated_project_cost_total_usd
            FROM dominion_project_descriptions
            ORDER BY project_id
            """
        )
    ]
    con.close()
    if not rows:
        raise SystemExit("No existing Dominion description rows found. Run this import with GEMINI_API_KEY first.")
    return rows


def main() -> int:
    load_env()
    if not PDF.exists():
        raise SystemExit(f"Missing PDF: {PDF}")
    if "--promote-existing" in sys.argv[1:]:
        raw_rows = existing_rows()
    else:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise SystemExit("GEMINI_API_KEY is not set. Add it to .env or your shell environment.")
        raw_rows = gemini_extract(api_key)
    clean_rows = [row for row in (clean_row(row) for row in raw_rows) if row is not None]
    diagnostics = write_rows(clean_rows)
    print(json.dumps({
        "source": PDF.name,
        "raw_rows": len(raw_rows),
        "clean_inserted_rows": len(clean_rows),
        "skipped_rows": len(raw_rows) - len(clean_rows),
        **diagnostics,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
