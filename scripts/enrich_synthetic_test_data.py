"""Add deterministic synthetic test data for projects with incomplete locations.

This is intentionally a test-data layer. It never claims generated coordinates
are source facts; notes and coordinateSource mark every generated value.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "db" / "data" / "projects.json"
WORK = ROOT / "work"
TARGET_PER_UTILITY = 20
EDGE_CASES_PER_UTILITY = 5
PDF_SAMPLE_PER_UTILITY = TARGET_PER_UTILITY - 5 - EDGE_CASES_PER_UTILITY

STATE_REGIONS = {
    "DESC": [
        ("SC", [-81.05, 33.90]),  # central South Carolina
        ("SC", [-80.35, 33.10]),  # Lowcountry / Midlands
        ("NC", [-79.05, 35.10]),  # southern North Carolina
        ("VA", [-77.45, 37.25]),  # central Virginia
        ("WV", [-81.60, 38.35]),  # West Virginia edge case
    ],
    "GPC": [
        ("GA", [-84.39, 33.75]),  # Atlanta
        ("GA", [-83.63, 32.84]),  # Macon
        ("GA", [-81.12, 32.08]),  # Savannah, south of SC border
        ("AL", [-85.40, 32.38]),  # eastern Alabama
        ("FL", [-82.45, 30.55]),  # north Florida
    ],
}

IMPORTANT_PDF_IDS = {
    "DESC": {"DESC_PDF_0167C_D", "DESC_PDF_6809_E", "DESC_PDF_6810_A", "DESC_PDF_06367_D_G"},
    "GPC": {"GPC_PDF_20785", "GPC_PDF_21116", "GPC_PDF_21922", "GPC_PDF_21548"},
}


def seed(value: str) -> int:
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:12], 16)


def fraction(value: str, salt: str) -> float:
    return (seed(f"{value}:{salt}") % 10000) / 10000


def synthetic_point(project_id: str, utility: str, salt: str = "a") -> tuple[str, list[float]]:
    regions = STATE_REGIONS[utility]
    index = seed(f"{project_id}:{salt}:region") % len(regions)
    state, anchor = regions[index]
    # Keep the jitter small enough to stay visually tied to the intended state
    # cluster while still avoiding stacked markers.
    lon_jitter = (fraction(project_id, f"lon-{salt}") - 0.5) * 0.36
    lat_jitter = (fraction(project_id, f"lat-{salt}") - 0.5) * 0.28
    return state, [round(anchor[0] + lon_jitter, 6), round(anchor[1] + lat_jitter, 6)]


def offset_point(point: list[float], miles: float, bearing_degrees: float = 75) -> list[float]:
    lat = math.radians(point[1])
    bearing = math.radians(bearing_degrees)
    dlat = miles * math.cos(bearing) / 69.0
    dlon = miles * math.sin(bearing) / (69.0 * max(0.25, math.cos(lat)))
    return [round(point[0] + dlon, 6), round(point[1] + dlat, 6)]


def note(project: dict[str, Any], text: str) -> None:
    project.setdefault("notes", [])
    if text not in project["notes"]:
        project["notes"].append(text)


def generated_endpoint(name: str, coords: list[float] | None) -> dict[str, Any]:
    return {
        "name": name,
        "coordinates": coords,
        "coordinateSource": "synthetic-test" if coords else "unresolved",
    }


def set_project_region(project: dict[str, Any], state: str | None = None) -> None:
    if state:
        project["state"] = state


def trim_projects(projects: list[dict[str, Any]]) -> dict[str, int]:
    projects[:] = [project for project in projects if not project["id"].startswith(("DESC_SYN_", "GPC_SYN_"))]
    selected: list[dict[str, Any]] = []
    removed = 0
    for utility in ("DESC", "GPC"):
        utility_projects = [project for project in projects if project["utility"] == utility]
        workbook = [project for project in utility_projects if project.get("sourceRow", 0) <= 11]
        pdf = [project for project in utility_projects if project.get("sourceRow", 0) > 11]
        important = [project for project in pdf if project["id"] in IMPORTANT_PDF_IDS[utility]]
        filler = [project for project in pdf if project["id"] not in IMPORTANT_PDF_IDS[utility]]
        pdf_sample = (important + filler)[:PDF_SAMPLE_PER_UTILITY]
        selected.extend(workbook + pdf_sample)
        removed += max(0, len(utility_projects) - len(workbook) - len(pdf_sample))
    projects[:] = selected
    return {"trimmed_pdf_projects": removed}


def enrich_pdf_projects(projects: list[dict[str, Any]]) -> dict[str, int]:
    generated_projects = adjusted_projects = partially_generated = left_unresolved = generated_endpoints = 0
    for index, project in enumerate(projects):
        located = [endpoint for endpoint in project["endpoints"] if endpoint.get("coordinates")]
        if project.get("sourceRow", 0) > 11 and not located and index % 17 == 0:
            note(project, "Synthetic test enrichment intentionally left this project unresolved to exercise no-location behavior.")
            left_unresolved += 1
            continue

        if len(located) == 0 or project.get("sourceRow", 0) <= 11:
            state, first = synthetic_point(project["id"], project["utility"], "first")
            one_endpoint_only = project.get("sourceRow", 0) > 11 and index % 7 == 0
            second = None if one_endpoint_only else offset_point(first, 3 + (seed(project["id"]) % 17), 35 + (seed(project["id"]) % 80))
            project["endpoints"] = [
                generated_endpoint(project["endpoints"][0]["name"], first),
                generated_endpoint(project["endpoints"][1]["name"], second),
            ]
            set_project_region(project, state)
            generated_projects += 1
            generated_endpoints += 1 + int(second is not None)
            if second is None:
                partially_generated += 1
            if project.get("sourceRow", 0) <= 11:
                adjusted_projects += 1
                note(project, "Workbook coordinates adjusted as synthetic test data to keep utility regions separated on the map.")
            else:
                note(project, "Synthetic test coordinates generated from project ID and utility region; not source-verified.")
        elif len(located) == 1 and index % 13 != 0:
            existing = located[0]["coordinates"]
            missing = next(endpoint for endpoint in project["endpoints"] if not endpoint.get("coordinates"))
            missing["coordinates"] = offset_point(existing, 4 + (seed(project["id"]) % 12), 80)
            missing["coordinateSource"] = "synthetic-test"
            generated_projects += 1
            generated_endpoints += 1
            note(project, "Missing endpoint coordinate generated as synthetic test data; not source-verified.")
        elif len(located) == 1:
            note(project, "Synthetic test enrichment kept one endpoint unresolved to exercise partial-location behavior.")
            partially_generated += 1
    return {
        "generated_coordinate_projects": generated_projects,
        "generated_endpoint_coordinates": generated_endpoints,
        "adjusted_seed_projects": adjusted_projects,
        "partial_location_projects": partially_generated,
        "intentionally_unresolved_projects": left_unresolved,
    }


def edge_project(
    project_id: str,
    utility: str,
    name: str,
    date: str | None,
    endpoints: list[dict[str, Any]],
    source_row: int,
    notes: list[str],
) -> dict[str, Any]:
    return {
        "id": project_id,
        "utility": utility,
        "state": "SC" if utility == "DESC" else "GA",
        "name": name,
        "shortName": name,
        "endpoints": endpoints,
        "inServiceDate": date,
        "rawDate": date or "",
        "sourceRow": source_row,
        "sourceProjectId": project_id.replace("_", "-"),
        "document": None,
        "documentPage": None,
        "status": "synthetic-test",
        "voltageKv": 115,
        "assetType": "synthetic test project",
        "workType": "test scenario",
        "sponsor": "Synthetic Test Data",
        "notes": [
            "Synthetic edge-case record for dashboard and scoring tests; not source-verified.",
            *notes,
        ],
    }


def add_edge_cases(projects: list[dict[str, Any]]) -> int:
    projects[:] = [project for project in projects if not project["id"].startswith(("DESC_SYN_", "GPC_SYN_"))]
    next_row = max(int(project.get("sourceRow") or 0) for project in projects) + 1
    rows: list[dict[str, Any]] = []

    cases = [
        ("DESC_SYN_IMMEDIATE", "DESC", "SC", "Synthetic Immediate DESC", "2028-01-15", [-81.976, 33.492], offset_point([-81.976, 33.492], 1.5), ["SC side of a border-comparison pair."]),
        ("GPC_SYN_IMMEDIATE", "GPC", "GA", "Synthetic Immediate GPC", "2028-01-20", [-81.982, 33.486], offset_point([-81.982, 33.486], 1.7), ["GA side of a border-comparison pair."]),
        ("DESC_SYN_LOCAL", "DESC", "SC", "Synthetic Local DESC", "2029-03-01", [-81.94, 33.53], offset_point([-81.94, 33.53], 2.5), ["SC side of a one-to-five-mile comparison pair."]),
        ("GPC_SYN_LOCAL", "GPC", "GA", "Synthetic Local GPC", "2029-03-15", [-81.98, 33.49], offset_point([-81.98, 33.49], 4.4), ["GA side of a one-to-five-mile comparison pair."]),
        ("DESC_SYN_REGIONAL", "DESC", "SC", "Synthetic Regional DESC", "2030-06-01", [-81.12, 32.24], offset_point([-81.12, 32.24], 8), ["SC side of a five-to-twenty-five-mile coastal comparison pair."]),
        ("GPC_SYN_REGIONAL", "GPC", "GA", "Synthetic Regional GPC", "2030-09-01", [-81.12, 32.08], offset_point([-81.12, 32.08], 16), ["GA side of a five-to-twenty-five-mile coastal comparison pair."]),
        ("DESC_SYN_EXCLUDED", "DESC", "VA", "Synthetic Excluded Distance DESC", "2031-01-01", [-77.45, 37.25], offset_point([-77.45, 37.25], 1), ["Far-field Dominion edge case."]),
        ("GPC_SYN_EXCLUDED", "GPC", "FL", "Synthetic Excluded Distance GPC", "2031-01-01", [-82.45, 30.55], offset_point([-82.45, 30.55], 1), ["Far-field Georgia Power edge case."]),
        ("DESC_SYN_NO_DATE", "DESC", "Synthetic Unknown Date DESC", None, [-82.0, 32.9], None, ["Missing date edge case with one located endpoint."]),
        ("GPC_SYN_UNLOCATED", "GPC", "Synthetic Unlocated GPC", "2032-05-01", None, None, ["No coordinates edge case."]),
    ]

    for row in cases:
        if len(row) == 8:
            project_id, utility, state, name, date, first, second, notes = row
        else:
            project_id, utility, name, date, first, second, notes = row
            state = "SC" if utility == "DESC" else "GA"
        endpoints = [
            generated_endpoint(f"{name} A", first),
            generated_endpoint(f"{name} B", second),
        ]
        row_project = edge_project(project_id, utility, name, date, endpoints, next_row, notes)
        row_project["state"] = state
        rows.append(row_project)
        next_row += 1
    projects.extend(rows)
    return len(rows)


def main() -> int:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    trim_stats = trim_projects(data["projects"])
    stats = enrich_pdf_projects(data["projects"])
    stats["synthetic_edge_projects"] = add_edge_cases(data["projects"])
    data["name"] = "Provided planning snapshot plus ProjectListings extraction and synthetic test enrichment"
    data["source"] = "Projects_Overlaps.xlsx + ProjectListings PDFs + synthetic test enrichment"
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    WORK.mkdir(exist_ok=True)
    summary = {
        "total_projects": len(data["projects"]),
        **trim_stats,
        **stats,
    }
    (WORK / "synthetic_enrichment_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
