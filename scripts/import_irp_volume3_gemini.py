"""Use Gemini to extract clean project rows from the 2025 IRP Volume 3 PDF."""
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

from scoring import opportunity_points

from import_ctpc_gemini import (
    MODEL,
    SCHEMA,
    center_from_rows,
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
PDF = ROOT / "2025 IRP Volume 3 PUBLIC DISCLOSURE.pdf"
DB = ROOT / "db" / "data" / "gridlock.sqlite"
PROJECT_PREFIX = "IRP25"

KNOWN_SPONSORS = {
    "GPC": ("GPC", "Georgia Power", "GA"),
    "GEORGIA POWER": ("GPC", "Georgia Power", "GA"),
    "GEORGIA POWER COMPANY": ("GPC", "Georgia Power", "GA"),
    "GTC": ("GTC", "Georgia Transmission Corporation", "GA"),
    "GEORGIA TRANSMISSION": ("GTC", "Georgia Transmission Corporation", "GA"),
    "GEORGIA TRANSMISSION CORPORATION": ("GTC", "Georgia Transmission Corporation", "GA"),
    "MEAG": ("MEAG", "MEAG Power", "GA"),
    "MEAG POWER": ("MEAG", "MEAG Power", "GA"),
    "OPC": ("OPC", "Oglethorpe Power", "GA"),
    "OGLETHORPE POWER": ("OPC", "Oglethorpe Power", "GA"),
    "SAV": ("SAV", "SAV", "GA"),
    "DU": ("DU", "DU", "GA"),
    "DESC": ("DESC", "Dominion Energy SC", "SC"),
    "DOMINION": ("DESC", "Dominion Energy SC", "SC"),
    "DOMINION ENERGY": ("DESC", "Dominion Energy SC", "SC"),
    "DOMINION ENERGY SC": ("DESC", "Dominion Energy SC", "SC"),
}


def clean_teams(value: Any) -> str:
    return clean_text(value).upper()


def sponsor_info(value: str) -> tuple[str, str, str | None]:
    sponsor = clean_text(value)
    normalized = re.sub(r"[^A-Z0-9]+", " ", sponsor.upper()).strip()
    for key, info in KNOWN_SPONSORS.items():
        if key in normalized:
            return info
    if re.fullmatch(r"[A-Z0-9]{2,8}", normalized):
        return normalized, sponsor, None
    acronym = "".join(word[0] for word in normalized.split() if word and word[0].isalnum())[:10]
    code = acronym or re.sub(r"[^A-Z0-9]+", "", normalized)[:10] or "IRP"
    return code, sponsor, None


def clean_row(row: dict[str, Any]) -> dict[str, Any] | None:
    teams = clean_teams(row.get("teams") or row.get("project_id"))
    project_name = clean_text(row.get("project_name"))
    last_years_need_date = clean_text(row.get("last_years_need_date"))
    project_sponsor = clean_text(row.get("project_sponsor"))
    iso_date = parse_date(last_years_need_date)
    if not all([teams, project_name, last_years_need_date, project_sponsor, iso_date]):
        return None
    return {
        "teams": teams,
        "project_name": project_name,
        "last_years_need_date": last_years_need_date,
        "last_years_need_date_iso": iso_date,
        "project_sponsor": project_sponsor,
    }


def gemini_extract(api_key: str) -> list[dict[str, Any]]:
    pdf_b64 = base64.b64encode(PDF.read_bytes()).decode("ascii")
    prompt = """
Extract only complete project rows from the attached 2025 IRP Volume 3 public disclosure PDF.

Return JSON only, as an object with a "projects" array. Each item must have exactly:
- teams: the Teams value, also known as ProjectID
- project_name
- last_years_need_date
- project_sponsor

Rules:
- Use only rows/entries that clearly contain all four requested fields.
- Do not include headers, footers, section text, notes, page numbers, or partial fragments.
- Do not infer missing values. If Teams/ProjectID, Project Name, Last Year's Need Date, or Project Sponsor is blank, unreadable, absent, or uncertain, omit that row.
- Project Sponsor is the utility company for the row.
- Keep Last Year's Need Date exactly as shown in the PDF.
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
                                "teams": {"type": "string"},
                                "project_name": {"type": "string"},
                                "last_years_need_date": {"type": "string"},
                                "project_sponsor": {"type": "string"},
                            },
                            "required": ["teams", "project_name", "last_years_need_date", "project_sponsor"],
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


def project_db_id(teams: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9]+", "_", teams).strip("_").upper()
    return f"{PROJECT_PREFIX}_{safe}"


def ensure_utility(con: sqlite3.Connection, code: str, display_name: str, state_scope: str | None) -> None:
    con.execute(
        """
        INSERT INTO utilities(code, display_name, state_scope)
        VALUES (?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name, state_scope = excluded.state_scope
        """,
        (code, display_name, state_scope),
    )


def ensure_source_document(con: sqlite3.Connection, dataset_id: int) -> int:
    existing = con.execute(
        "SELECT id FROM source_documents WHERE dataset_id = ? AND file_name = ?",
        (dataset_id, PDF.name),
    ).fetchone()
    if existing:
        return int(existing[0])
    con.execute(
        """
        INSERT INTO source_documents(dataset_id, utility_code, file_name, file_path, document_type, parser_status)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (dataset_id, None, PDF.name, str(PDF), "pdf", "parsed-by-gemini"),
    )
    return int(con.execute("SELECT last_insert_rowid()").fetchone()[0])


def rebuild_opportunity_scores(con: sqlite3.Connection, dataset_id: int) -> int:
    profile = con.execute("SELECT id FROM scoring_profiles WHERE active = 1 ORDER BY id DESC LIMIT 1").fetchone()
    if not profile:
        return 0
    profile_id = int(profile[0])
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
            distance_points, timeline_points, compatibility_points, total_points = opportunity_points(distance, gap)
            timing_score = round(timeline_points / 50, 4)
            location_score = min(a["location_confidence"], b["location_confidence"])
            resource_score = 0
            composite = round(total_points / 100, 4)
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
    return inserted


def write_rows(rows: list[dict[str, Any]]) -> dict[str, int]:
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    dataset_id = latest_dataset_id(con)
    document_id = ensure_source_document(con, dataset_id)

    con.execute("DELETE FROM irp_volume3_projects")
    con.execute("DELETE FROM projects WHERE id LIKE ?", (f"{PROJECT_PREFIX}_%",))
    con.executemany(
        """
        INSERT INTO irp_volume3_projects(teams, project_name, last_years_need_date, project_sponsor, source_file)
        VALUES (?, ?, ?, ?, ?)
        """,
        [(row["teams"], row["project_name"], row["last_years_need_date"], row["project_sponsor"], PDF.name) for row in rows],
    )

    located_count = 0
    sponsors: set[str] = set()
    for index, row in enumerate(rows, start=1):
        utility_code, display_name, state_scope = sponsor_info(row["project_sponsor"])
        ensure_utility(con, utility_code, display_name, state_scope)
        sponsors.add(utility_code)
        project_id = project_db_id(row["teams"])
        locations = title_matches(row["project_name"], state_scope)
        if locations:
            located_count += 1
        state = locations[0][1] if locations else state_scope or "GA"
        endpoint_rows: list[tuple[int, str, float | None, float | None, str, float]] = []
        for order in (1, 2):
            if order <= len(locations[:2]):
                label, _, lon, lat = locations[order - 1]
                endpoint_rows.append((order, label, lon, lat, "project-name-place", 0.5))
            else:
                endpoint_rows.append((order, f"{row['teams']} location unresolved", None, None, "unresolved", 0.0))
        located_endpoints = min(2, len(locations))
        location_confidence = 0.6 if located_endpoints == 2 else 0.4 if located_endpoints == 1 else 0.1
        short_name = row["project_name"][:76] + ("..." if len(row["project_name"]) > 76 else "")
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
                project_id, dataset_id, utility_code, state, row["project_name"], short_name, 50000 + index,
                row["teams"], row["last_years_need_date_iso"], row["last_years_need_date"],
                document_id, None, "Last year's need date", None, "IRP Volume 3 project", row["project_sponsor"],
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
            "Parsed from the 2025 IRP Volume 3 public disclosure PDF by Gemini.",
            f"Project Sponsor: {row['project_sponsor']}.",
            f"Teams/ProjectID: {row['teams']}.",
        ]
        if not locations:
            notes.append("No recognized place name was found, so this project is searchable but not mapped.")
        con.executemany(
            "INSERT INTO project_notes(project_id, note_order, note) VALUES (?, ?, ?)",
            [(project_id, order, note) for order, note in enumerate(notes, start=1)],
        )

    opportunities = rebuild_opportunity_scores(con, dataset_id)
    con.commit()
    con.close()
    return {
        "promoted_rows": len(rows),
        "sponsor_count": len(sponsors),
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
            "last_years_need_date_iso": parse_date(row["last_years_need_date"]),
        }
        for row in con.execute(
            """
            SELECT teams, project_name, last_years_need_date, project_sponsor
            FROM irp_volume3_projects
            ORDER BY teams
            """
        )
    ]
    con.close()
    if not rows:
        raise SystemExit("No existing IRP Volume 3 rows found. Run this import with GEMINI_API_KEY first.")
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
