"""Use Gemini to extract CTPC reliability project rows from the update PDF.

Required environment:
  GEMINI_API_KEY

The import is intentionally strict:
- only the requested Reliability Projects table fields are stored
- rows with status "Removed" are discarded
- incomplete or malformed rows are discarded
"""
from __future__ import annotations

import base64
import json
import math
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from scoring import opportunity_points

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "2025_Collaborative_Transmission_Plan_MidYear_Update_08-13-26.pdf"
DB = ROOT / "db" / "data" / "gridlock.sqlite"
SCHEMA = ROOT / "db" / "schema.sql"
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
STATUSES = {"in-service", "underway", "planned", "conceptual", "deferred"}
EARTH_RADIUS_MI = 3958.7613
UTILITY_CODE = "CTPC"
UTILITY_NAME = "CarolinasTCP"

# Approximate city/substation-place coordinates used only for test/demo mapping.
# They are deterministic and intentionally limited to names present in the CTPC titles.
PLACE_COORDS: dict[str, tuple[str, str, float, float]] = {
    "arden": ("Arden", "NC", -82.5165, 35.4662),
    "aiken": ("Aiken", "SC", -81.7196, 33.5604),
    "amity": ("Amity", "NC", -80.8048, 35.2232),
    "arrowood": ("Arrowood", "NC", -80.9038, 35.1380),
    "asheville": ("Asheville", "NC", -82.5515, 35.5951),
    "barnard creek": ("Barnard Creek", "NC", -77.9625, 34.2218),
    "beulah": ("Beulah", "NC", -80.4312, 35.9807),
    "bethania": ("Bethania", "NC", -80.3378, 36.1815),
    "boyd": ("Boyd", "NC", -81.0378, 35.2424),
    "brunswick": ("Brunswick", "NC", -78.2281, 34.0270),
    "cabarrus": ("Cabarrus County", "NC", -80.5512, 35.3890),
    "carthage": ("Carthage", "NC", -79.4070, 35.3454),
    "castle hayne": ("Castle Hayne", "NC", -77.8997, 34.3557),
    "charlotte": ("Charlotte", "NC", -80.8431, 35.2271),
    "cliffside": ("Cliffside", "NC", -81.7618, 35.2412),
    "clear creek": ("Clear Creek", "NC", -80.6887, 35.1754),
    "concord": ("Concord", "NC", -80.5795, 35.4088),
    "crab orchard": ("Crab Orchard", "NC", -80.7398, 35.2418),
    "dan river": ("Dan River", "NC", -79.7280, 36.4865),
    "dixon school rd": ("Dixon School Road", "NC", -81.3836, 35.2097),
    "durham": ("Durham", "NC", -78.8986, 35.9940),
    "east durham": ("East Durham", "NC", -78.8550, 35.9840),
    "ellis rd": ("Ellis Road", "NC", -78.8508, 35.9026),
    "fayetteville": ("Fayetteville", "NC", -78.8784, 35.0527),
    "falls": ("Falls", "NC", -78.5822, 35.9756),
    "folkstone": ("Folkstone", "NC", -77.5180, 34.5451),
    "franklinton": ("Franklinton", "NC", -78.4581, 36.1018),
    "gastonia": ("Gastonia", "NC", -81.1873, 35.2621),
    "greensboro": ("Greensboro", "NC", -79.7920, 36.0726),
    "haas creek": ("Haas Creek", "NC", -81.5084, 35.9140),
    "hands mill": ("Hands Mill", "SC", -81.1318, 35.0978),
    "harrisburg": ("Harrisburg", "NC", -80.6570, 35.3238),
    "havelock": ("Havelock", "NC", -76.9013, 34.8791),
    "henderson": ("Henderson", "NC", -78.3992, 36.3296),
    "hinkle": ("Hinkle", "NC", -80.2598, 35.9007),
    "holly ridge": ("Holly Ridge", "NC", -77.5544, 34.4954),
    "huntersville": ("Huntersville", "NC", -80.8429, 35.4107),
    "jacksonville": ("Jacksonville", "NC", -77.4302, 34.7541),
    "lake emory": ("Lake Emory", "NC", -83.3857, 35.1879),
    "lakewood": ("Lakewood", "NC", -80.8890, 35.2388),
    "longview": ("Longview", "NC", -81.3831, 35.7307),
    "lookout": ("Lookout", "NC", -77.3925, 34.7233),
    "lyle creek": ("Lyle Creek", "NC", -81.2668, 35.7285),
    "madison": ("Madison", "NC", -79.9595, 36.3854),
    "marshall": ("Marshall", "NC", -82.6840, 35.7973),
    "maxton": ("Maxton", "NC", -79.3489, 34.7352),
    "mebane": ("Mebane", "NC", -79.2669, 36.0957),
    "method": ("Method", "NC", -78.7047, 35.7913),
    "monroe": ("Monroe", "NC", -80.5495, 34.9854),
    "mooresville": ("Mooresville", "NC", -80.8101, 35.5849),
    "morning star": ("Morning Star", "NC", -80.7095, 35.1129),
    "nanny mountain": ("Nanny Mountain", "SC", -81.2029, 35.0607),
    "okatie": ("Okatie", "SC", -80.9237, 32.3002),
    "newport": ("Newport", "NC", -76.8591, 34.7866),
    "newton": ("Newton", "NC", -81.2215, 35.6699),
    "north greensboro": ("North Greensboro", "NC", -79.7898, 36.1165),
    "oteen": ("Oteen", "NC", -82.4876, 35.5793),
    "peach valley": ("Peach Valley", "SC", -81.7348, 35.0268),
    "pineland": ("Pineland", "SC", -81.1648, 32.5935),
    "queensboro": ("Queensboro", "SC", -79.9673, 32.7824),
    "pembroke": ("Pembroke", "NC", -79.1950, 34.6802),
    "research triangle": ("Research Triangle Park", "NC", -78.8656, 35.8992),
    "richmond": ("Richmond County", "NC", -79.7450, 34.9393),
    "ritter": ("Ritter", "SC", -80.5487, 32.8563),
    "riverport": ("Riverport", "SC", -81.0565, 32.2191),
    "rocky mount": ("Rocky Mount", "NC", -77.7905, 35.9382),
    "rtp": ("Research Triangle Park", "NC", -78.8656, 35.8992),
    "rural hall": ("Rural Hall", "NC", -80.2934, 36.2404),
    "shattalon": ("Shattalon", "NC", -80.3204, 36.1262),
    "shelby": ("Shelby", "NC", -81.5356, 35.2924),
    "saluda": ("Saluda", "SC", -81.7721, 34.0015),
    "santee": ("Santee", "SC", -80.4865, 33.4752),
    "st george": ("St George", "SC", -80.5757, 33.1860),
    "st helena": ("St Helena Island", "SC", -80.5509, 32.3835),
    "st matthews": ("St Matthews", "SC", -80.7773, 33.6649),
    "stevens creek": ("Stevens Creek", "SC", -82.1607, 33.6357),
    "skybrook": ("Skybrook", "NC", -80.8429, 35.4107),
    "southport": ("Southport", "NC", -78.0193, 33.9216),
    "states": ("Statesville", "NC", -80.8873, 35.7826),
    "statesville": ("Statesville", "NC", -80.8873, 35.7826),
    "swepsonville": ("Swepsonville", "NC", -79.3614, 36.0215),
    "sycamore": ("Sycamore", "NC", -81.3340, 35.7429),
    "terrell": ("Terrell", "NC", -80.9726, 35.5890),
    "troutman": ("Troutman", "NC", -80.8881, 35.7007),
    "wake": ("Wake Forest", "NC", -78.5097, 35.9799),
    "west asheville": ("West Asheville", "NC", -82.5982, 35.5776),
    "westport": ("Westport", "NC", -80.9931, 35.5007),
    "wilson": ("Wilson", "NC", -77.9155, 35.7213),
    "winecoff": ("Winecoff", "NC", -80.6056, 35.4465),
    "wylie": ("Lake Wylie", "SC", -81.0429, 35.1085),
    "zebulon": ("Zebulon", "NC", -78.3147, 35.8243),
    "campobello": ("Campobello", "SC", -82.1498, 35.1151),
    "batesburg": ("Batesburg-Leesville", "SC", -81.5473, 33.9107),
    "bayfront": ("Bayfront", "SC", -79.9459, 32.7946),
    "bluffton": ("Bluffton", "SC", -80.8604, 32.2371),
    "burton": ("Burton", "SC", -80.7240, 32.4355),
    "cainhoy": ("Cainhoy", "SC", -79.8448, 32.9274),
    "cameron": ("Cameron", "SC", -80.7137, 33.5596),
    "canadys": ("Canadys", "SC", -80.6104, 33.0418),
    "charleston": ("Charleston", "SC", -79.9311, 32.7765),
    "chesnee": ("Chesnee", "SC", -81.8618, 35.1487),
    "church creek": ("Church Creek", "SC", -80.0620, 32.7935),
    "clover": ("Clover", "SC", -81.2265, 35.1112),
    "coit": ("Coit", "SC", -80.9984, 34.2177),
    "columbia": ("Columbia", "SC", -81.0348, 34.0007),
    "coronaca": ("Coronaca", "SC", -82.0937, 34.2535),
    "denny terrace": ("Denny Terrace", "SC", -81.0290, 34.1032),
    "duncan": ("Duncan", "SC", -82.1451, 34.9379),
    "eastover": ("Eastover", "SC", -80.6915, 33.8768),
    "edenwood": ("Edenwood", "SC", -81.0890, 34.0371),
    "elloree": ("Elloree", "SC", -80.5734, 33.5321),
    "faber place": ("Faber Place", "SC", -79.9759, 32.8646),
    "fort johnson": ("Fort Johnson", "SC", -79.8973, 32.7510),
    "frogmore": ("Frogmore", "SC", -80.5737, 32.3938),
    "gills creek": ("Gills Creek", "SC", -80.9551, 33.9988),
    "goose creek": ("Goose Creek", "SC", -80.0326, 32.9810),
    "greenville": ("Greenville", "SC", -82.3940, 34.8526),
    "glen springs": ("Glen Springs", "SC", -81.8579, 34.8143),
    "hamlin": ("Hamlin", "SC", -79.7937, 32.8735),
    "harleyville": ("Harleyville", "SC", -80.4487, 33.2146),
    "hodges": ("Hodges", "SC", -82.2460, 34.2876),
    "hopkins": ("Hopkins", "SC", -80.8773, 33.9043),
    "inman": ("Inman", "SC", -82.0901, 35.0471),
    "james island": ("James Island", "SC", -79.9398, 32.7357),
    "jasper": ("Jasper County", "SC", -81.0318, 32.4316),
    "killian": ("Killian", "SC", -80.9582, 34.1535),
    "lancaster": ("Lancaster", "SC", -80.7709, 34.7204),
    "lawsons fork": ("Lawsons Fork", "SC", -81.8984, 34.9746),
    "marietta": ("Marietta", "SC", -82.5065, 35.0357),
    "spartanburg": ("Spartanburg", "SC", -81.9320, 34.9496),
    "sumter": ("Sumter", "SC", -80.3415, 33.9204),
    "summerville": ("Summerville", "SC", -80.1756, 33.0198),
    "switzer": ("Switzer", "SC", -82.0610, 34.9104),
    "taylors": ("Taylors", "SC", -82.2962, 34.9204),
    "tiger": ("Tiger", "SC", -82.8371, 34.6726),
    "toolebeck": ("Toolebeck", "SC", -81.6751, 33.4585),
    "union pier": ("Union Pier", "SC", -79.9245, 32.7904),
    "una": ("Una", "SC", -81.9934, 34.9565),
    "urquhart": ("Urquhart", "SC", -81.8668, 33.4704),
    "verdae": ("Verdae", "SC", -82.3387, 34.8222),
    "wagener": ("Wagener", "SC", -81.3615, 33.6521),
    "wateree": ("Wateree", "SC", -80.7040, 33.8354),
    "yemassee": ("Yemassee", "SC", -80.8507, 32.6902),
}
PLACE_STATE_OVERRIDES: dict[tuple[str, str], tuple[str, str, float, float]] = {
    ("monroe", "GA"): ("Monroe", "GA", -83.7132, 33.7948),
}
PLACE_KEYS = sorted(PLACE_COORDS, key=len, reverse=True)


def load_env() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def clean_status(value: Any) -> str:
    status = clean_text(value)
    return status if status.lower() in STATUSES else ""


def clean_cost(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = clean_text(value).replace("$", "").replace(",", "")
    match = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(match.group(0)) if match else None


def parse_date(value: str) -> str | None:
    text = clean_text(value)
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def normalize_for_match(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def project_db_id(project_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9]+", "_", project_id).strip("_").upper()
    return f"{UTILITY_CODE}_{safe}"


def state_set(value: str | None) -> set[str]:
    if not value:
        return set()
    return {part for part in re.split(r"[^A-Z]+", value.upper()) if len(part) == 2}


def title_matches(text: str, preferred_state: str | None = None) -> list[tuple[str, str, float, float]]:
    normalized = f" {normalize_for_match(text)} "
    matches: list[tuple[int, str, str, float, float]] = []
    used_spans: list[tuple[int, int]] = []
    allowed_states = state_set(preferred_state)
    for key in PLACE_KEYS:
        pattern = f" {normalize_for_match(key)} "
        start = normalized.find(pattern)
        if start < 0:
            continue
        span = (start, start + len(pattern))
        if any(not (span[1] <= a or span[0] >= b) for a, b in used_spans):
            continue
        label, state, lon, lat = next(
            (PLACE_STATE_OVERRIDES[(key, preferred)] for preferred in allowed_states if (key, preferred) in PLACE_STATE_OVERRIDES),
            PLACE_COORDS[key],
        )
        if allowed_states and state not in allowed_states:
            continue
        matches.append((start, label, state, lon, lat))
        used_spans.append(span)
    deduped: list[tuple[str, str, float, float]] = []
    seen: set[str] = set()
    for _, label, state, lon, lat in sorted(matches):
        if label in seen:
            continue
        deduped.append((label, state, lon, lat))
        seen.add(label)
    return deduped


def center_from_rows(rows: list[sqlite3.Row]) -> tuple[float, float] | None:
    points = [(row["longitude"], row["latitude"]) for row in rows if row["longitude"] is not None and row["latitude"] is not None]
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
    try:
        return abs((datetime.fromisoformat(a) - datetime.fromisoformat(b)).days)
    except ValueError:
        return None


def distance_tier(distance: float) -> int | None:
    if not math.isfinite(distance) or distance < 0 or distance > 25:
        return None
    return 1 if distance < 1 else 2 if distance < 5 else 3


def normalized_score(value: float, limit: float, lower_is_better: bool = True) -> float:
    clipped = max(0.0, min(limit, value))
    score = 1.0 - clipped / limit if lower_is_better else clipped / limit
    return round(score, 4)


def clean_row(row: dict[str, Any]) -> dict[str, Any] | None:
    project_id = clean_text(row.get("project_id"))
    reliability_project = clean_text(row.get("reliability_project"))
    status = clean_status(row.get("status"))
    transmission_owner = clean_text(row.get("transmission_owner"))
    estimated_in_service_date = clean_text(row.get("estimated_in_service_date"))
    estimated_cost_million = clean_cost(row.get("estimated_cost_million"))

    if clean_text(row.get("status")).lower() == "removed":
        return None
    if not all([project_id, reliability_project, status, transmission_owner, estimated_in_service_date]):
        return None
    if estimated_cost_million is None:
        return None
    return {
        "project_id": project_id,
        "reliability_project": reliability_project,
        "status": status,
        "transmission_owner": transmission_owner,
        "estimated_in_service_date": estimated_in_service_date,
        "estimated_cost_million": estimated_cost_million,
    }


def gemini_extract(api_key: str) -> list[dict[str, Any]]:
    pdf_b64 = base64.b64encode(PDF.read_bytes()).decode("ascii")
    prompt = """
Extract only rows from the "2025 Collaborative Transmission Plan - Reliability Projects" table.

Return JSON only, as an object with a "projects" array. Each item must have exactly:
- project_id
- reliability_project
- status
- transmission_owner
- estimated_in_service_date
- estimated_cost_million

Rules:
- Use only the Reliability Projects table, not change-summary tables or public policy tables.
- Do not include any row whose Status is Removed.
- Do not infer missing values. If a requested field is blank, unreadable, or uncertain, omit that row.
- Keep Estimated Cost in millions as a number, not a string.
- Keep Estimated In-Service Date as shown in the PDF, including TBD when shown.
- Keep Transmission Owner as the owner code shown in the table.
- Return no commentary, markdown, or explanations.
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
                                "project_id": {"type": "string"},
                                "reliability_project": {"type": "string"},
                                "status": {"type": "string"},
                                "transmission_owner": {"type": "string"},
                                "estimated_in_service_date": {"type": "string"},
                                "estimated_cost_million": {"type": "number"},
                            },
                            "required": [
                                "project_id",
                                "reliability_project",
                                "status",
                                "transmission_owner",
                                "estimated_in_service_date",
                                "estimated_cost_million",
                            ],
                        },
                    }
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


def latest_dataset_id(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT id FROM dataset_versions ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        raise SystemExit("SQLite dataset is empty. Run npm run data:refresh first.")
    return int(row[0])


def ensure_utility(con: sqlite3.Connection) -> None:
    con.execute(
        """
        INSERT INTO utilities(code, display_name, state_scope)
        VALUES (?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name, state_scope = excluded.state_scope
        """,
        (UTILITY_CODE, UTILITY_NAME, "NC/SC"),
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


def delete_promoted_projects(con: sqlite3.Connection) -> None:
    con.execute(
        "DELETE FROM projects WHERE utility_code = ? OR id LIKE ?",
        (UTILITY_CODE, f"{UTILITY_CODE}_%"),
    )


def promote_rows(con: sqlite3.Connection, rows: list[dict[str, Any]], dataset_id: int) -> dict[str, int]:
    ensure_utility(con)
    document_id = ensure_source_document(con, dataset_id)
    delete_promoted_projects(con)
    located_count = 0
    unresolved_count = 0

    for index, row in enumerate(rows, start=1):
        project_id = project_db_id(row["project_id"])
        locations = title_matches(row["reliability_project"], "NC/SC")
        state = locations[0][1] if locations else "NC/SC"
        if locations:
            located_count += 1
        else:
            unresolved_count += 1
        endpoints = locations[:2]
        endpoint_rows: list[tuple[int, str, float | None, float | None, str, float]] = []
        for order in (1, 2):
            if order <= len(endpoints):
                label, _, lon, lat = endpoints[order - 1]
                endpoint_rows.append((order, label, lon, lat, "city-name", 0.55))
            else:
                suffix = "unresolved" if order == 1 else "second location unresolved"
                endpoint_rows.append((order, f"{row['project_id']} {suffix}", None, None, "unresolved", 0.0))
        located_endpoints = len(endpoints)
        location_confidence = 0.65 if located_endpoints == 2 else 0.45 if located_endpoints == 1 else 0.1
        in_service_date = parse_date(row["estimated_in_service_date"])
        short_name = row["reliability_project"][:76] + ("..." if len(row["reliability_project"]) > 76 else "")
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
                project_id, dataset_id, UTILITY_CODE, state, row["reliability_project"], short_name, 30000 + index,
                row["project_id"], in_service_date, row["estimated_in_service_date"], document_id, None,
                row["status"], None, "CTPC reliability project", row["transmission_owner"],
                row["estimated_cost_million"] * 1_000_000, location_confidence,
                0.8 if in_service_date else 0.2, 0.5,
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
            "Parsed from the CTPC mid-year update PDF by Gemini.",
            f"Assigned to {UTILITY_NAME}; source transmission owner code was {row['transmission_owner']}.",
            "Coordinates are derived from city/place names in the Reliability Project title and should be reviewed before operational use.",
        ]
        if not locations:
            notes.append("No recognized Carolinas city/place name was found in the title, so this project is searchable but not mapped.")
        con.executemany(
            "INSERT INTO project_notes(project_id, note_order, note) VALUES (?, ?, ?)",
            [(project_id, order, note) for order, note in enumerate(notes, start=1)],
        )
    return {"promoted_rows": len(rows), "city_geocoded_rows": located_count, "unresolved_coordinate_rows": unresolved_count}


def rebuild_opportunity_scores(con: sqlite3.Connection, dataset_id: int) -> int:
    profile = con.execute(
        "SELECT id FROM scoring_profiles WHERE active = 1 ORDER BY id DESC LIMIT 1"
    ).fetchone()
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
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    dataset_id = latest_dataset_id(con)
    con.execute("DELETE FROM collaborative_transmission_projects")
    con.executemany(
        """
        INSERT INTO collaborative_transmission_projects(
          project_id, reliability_project, status, transmission_owner,
          estimated_in_service_date, estimated_cost_million, source_file
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                row["project_id"],
                row["reliability_project"],
                row["status"],
                row["transmission_owner"],
                row["estimated_in_service_date"],
                row["estimated_cost_million"],
                PDF.name,
            )
            for row in rows
        ],
    )
    diagnostics = promote_rows(con, rows, dataset_id)
    diagnostics["opportunity_scores"] = rebuild_opportunity_scores(con, dataset_id)
    con.commit()
    con.close()
    return diagnostics


def existing_rows() -> list[dict[str, Any]]:
    if not DB.exists():
        raise SystemExit(f"Missing SQLite database: {DB}")
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = [
        dict(row)
        for row in con.execute(
            """
            SELECT project_id, reliability_project, status, transmission_owner,
              estimated_in_service_date, estimated_cost_million
            FROM collaborative_transmission_projects
            ORDER BY project_id
            """
        )
    ]
    con.close()
    if not rows:
        raise SystemExit("No existing CTPC rows found. Run npm run data:import-ctpc with GEMINI_API_KEY first.")
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
