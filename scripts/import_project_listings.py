"""Extract ProjectListings PDFs and merge them into db/data/projects.json.

The dashboard keeps using projects.json as its API contract. This script enriches
the workbook seed records and appends PDF-only records, then build_db.py turns
that JSON into SQLite.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


def ensure_pdfplumber() -> None:
    try:
        import pdfplumber  # noqa: F401
        return
    except ImportError:
        bundled = Path.home() / ".cache" / "codex-runtimes" / "codex-primary-runtime" / "dependencies" / "python" / "python.exe"
        if bundled.exists() and Path(sys.executable).resolve() != bundled.resolve():
            raise SystemExit(subprocess.run([str(bundled), *sys.argv], check=False).returncode)
        raise SystemExit(
            "pdfplumber is not available. Install pdfplumber or run with the bundled Codex Python runtime."
        )


ensure_pdfplumber()
import pdfplumber  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "db" / "data" / "projects.json"
PROJECT_LISTINGS = ROOT / "ProjectListings"
WORK = ROOT / "work"
DOMINION_DOC = "2024-2028-2million-and-above-project-descriptions.pdf"
GEORGIA_DOC = "2025 IRP Volume 3 PUBLIC DISCLOSURE.pdf"


def clean_text(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\ufffd", "-").replace("�", "-")).strip()


def slug(value: str) -> str:
    cleaned = re.sub(r"[^A-Z0-9]+", "_", value.upper()).strip("_")
    return cleaned[:48] or "UNKNOWN"


def normalize_name(value: str) -> str:
    value = clean_text(value).upper()
    value = re.sub(r"\b(?:SAV|GTC|MEAG|DU|CC)\s*:\s*", "", value)
    value = value.replace("&", " AND ")
    value = re.sub(r"[^A-Z0-9]+", " ", value)
    value = re.sub(r"\b(?:KV|K V|LINE|SUB|SUBSTATION|PRIMARY|PROJECT|REBUILD|RECONDUCTOR|CONSTRUCT|INSTALLATION|REPLACEMENT|UPGRADE|UPGRADES|NEW|THE|AND)\b", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def parse_date(value: str | None) -> tuple[str | None, str]:
    raw = clean_text(value)
    if not raw:
        return None, ""
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            parsed = datetime.strptime(raw, fmt)
            return parsed.strftime("%Y-%m-%d"), raw
        except ValueError:
            pass
    return None, raw


def text_between(text: str, start: str, *ends: str) -> str | None:
    pattern = re.escape(start) + r"\s*(.*?)\s*(?:" + "|".join(re.escape(end) for end in ends) + r")"
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    return clean_text(match.group(1)) if match else None


def voltage_from(*values: str | None) -> float | None:
    text = " ".join(clean_text(value).upper() for value in values if value)
    matches = re.findall(r"\b(\d{2,3})\s*K\s*V\b|\b(\d{2,3})KV\b", text)
    numbers = [int(a or b) for a, b in matches]
    return float(max(numbers)) if numbers else None


def work_type_from(*values: str | None) -> str | None:
    text = " ".join(clean_text(value).upper() for value in values if value)
    keywords = [
        ("rebuild", "rebuild"),
        ("reconductor", "reconductor"),
        ("relay", "relay upgrade"),
        ("capacitor", "capacitor bank"),
        ("bank", "bank/transformer"),
        ("transformer", "bank/transformer"),
        ("statcom", "STATCOM"),
        ("new line", "new line"),
        ("construct", "construct"),
    ]
    for key, label in keywords:
        if key.upper() in text:
            return label
    return None


def asset_type_from(*values: str | None) -> str | None:
    text = " ".join(clean_text(value).upper() for value in values if value)
    if "STATCOM" in text:
        return "STATCOM"
    if "CAPACITOR" in text:
        return "capacitor bank"
    if "TRANSFORMER" in text or "BANK" in text or "XFMR" in text:
        return "transformer/bank"
    if "RELAY" in text:
        return "relay/protection"
    if "LINE" in text or " KV " in f" {text} " or "KV" in text:
        return "transmission line"
    return None


def endpoint_candidates(name: str) -> list[str]:
    title = re.sub(r"^\s*(?:SAV|GTC|MEAG|DU|CC)\s*:\s*", "", clean_text(name), flags=re.IGNORECASE)
    title = re.sub(r"\([^)]*\)", " ", title)
    title = re.split(r"\b(?:115|230|500)\s*K?\s*V\b|\bREBUILD\b|\bRECONDUCTOR\b|\bNEW LINE\b|\bLINE\b|\bBANK\b|\bRELAY\b|\bCAPACITOR\b", title, maxsplit=1, flags=re.IGNORECASE)[0]
    title = title.replace(" - ", "|").replace("-", "|").replace(" TO ", "|")
    parts = [clean_text(part) for part in title.split("|")]
    return [part for part in parts if part]


def known_coordinate_lookup(projects: list[dict[str, Any]]) -> dict[str, list[float]]:
    lookup: dict[str, list[float]] = {}
    for project in projects:
        for endpoint in project.get("endpoints", []):
            coords = endpoint.get("coordinates")
            if not coords:
                continue
            names = {endpoint.get("name", "")}
            names.add(re.sub(r"\b(?:SUBSTATION|SUB|PRIMARY|#\d+)\b", "", endpoint.get("name", ""), flags=re.IGNORECASE))
            for name in names:
                norm = normalize_name(name)
                if norm:
                    lookup[norm] = coords
    return lookup


def resolve_endpoint(name: str, lookup: dict[str, list[float]]) -> list[float] | None:
    norm = normalize_name(name)
    if norm in lookup:
        return lookup[norm]
    for known, coords in lookup.items():
        if norm and known and (norm in known or known in norm):
            return coords
    return None


def endpoints_for(name: str, lookup: dict[str, list[float]]) -> tuple[list[dict[str, Any]], int]:
    parts = endpoint_candidates(name)[:2]
    if len(parts) == 0:
        parts = [name, "Unresolved endpoint"]
    if len(parts) == 1:
        parts.append("Unresolved endpoint")
    resolved = 0
    endpoints = []
    for part in parts[:2]:
        coords = resolve_endpoint(part, lookup)
        if coords:
            resolved += 1
        endpoints.append({"name": part, "coordinates": coords})
    return endpoints, resolved


def extract_dominion() -> list[dict[str, Any]]:
    path = PROJECT_LISTINGS / "Dominion Energy" / DOMINION_DOC
    records: list[dict[str, Any]] = []
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            text = clean_text(page.extract_text() or "")
            project_id = text_between(text, "Project ID", "Project Description")
            name = text_between(text, "5 Year Budget", "Project ID")
            description = text_between(text, "Project Description", "Project Need")
            need = text_between(text, "Project Need", "Project Status")
            status = text_between(text, "Project Status", "Planned In-Service Date")
            date_raw = text_between(text, "Planned In-Service Date", "Estimated Project Cost")
            if not project_id or not name:
                continue
            iso_date, raw_date = parse_date(date_raw)
            records.append({
                "company": "DESC",
                "source_project_id": project_id,
                "name": name,
                "short_name": name,
                "state": "SC",
                "in_service_date": iso_date,
                "raw_date": raw_date,
                "document": DOMINION_DOC,
                "document_page": index,
                "status": status.lower() if status else "planned",
                "description": description,
                "need": need,
                "voltage_kv": voltage_from(name, description),
                "asset_type": asset_type_from(name, description),
                "work_type": work_type_from(name, description),
                "sponsor": "Dominion Energy South Carolina",
            })
    return records


def extract_georgia() -> list[dict[str, Any]]:
    path = PROJECT_LISTINGS / "Georgia Power" / GEORGIA_DOC
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            text = clean_text(page.extract_text() or "")
            if "Teams #" not in text or "Need Date" not in text or "Description" not in text:
                continue
            teams_match = re.search(r"Teams\s*#\s*(\d+)", text, re.IGNORECASE)
            if not teams_match:
                continue
            teams = teams_match.group(1)
            if teams in seen:
                continue
            title = clean_text(text.split("Teams #", 1)[0])
            title = re.sub(r"^PUBLIC DISCLOSURE\s+", "", title, flags=re.IGNORECASE)
            title = re.sub(r"^CRITICAL ENERGY INFRASTRUCTURE INFORMATION.*?employees\.\s*", "", title, flags=re.IGNORECASE)
            title = clean_text(title)
            if not title:
                continue
            need_match = re.search(r"Need Date\s+(\d{1,2}/\d{1,2}/\d{4})", text, re.IGNORECASE)
            start_match = re.search(r"Start Date\s+(\d{1,2}/\d{1,2}/\d{4})", text, re.IGNORECASE)
            desc_match = re.search(r"Description\s+(.*?)\s+Supporting Statement", text, re.IGNORECASE | re.DOTALL)
            iso_date, raw_date = parse_date(need_match.group(1) if need_match else None)
            sponsor = title.split(":", 1)[0].strip() if ":" in title and len(title.split(":", 1)[0].strip()) <= 5 else "GPC"
            records.append({
                "company": "GPC",
                "source_project_id": teams,
                "name": title,
                "short_name": title,
                "state": "GA",
                "in_service_date": iso_date,
                "raw_date": raw_date,
                "start_date": start_match.group(1) if start_match else None,
                "document": GEORGIA_DOC,
                "document_page": index,
                "status": "planned",
                "description": clean_text(desc_match.group(1)) if desc_match else None,
                "need": None,
                "voltage_kv": voltage_from(title, desc_match.group(1) if desc_match else None),
                "asset_type": asset_type_from(title, desc_match.group(1) if desc_match else None),
                "work_type": work_type_from(title, desc_match.group(1) if desc_match else None),
                "sponsor": sponsor,
            })
            seen.add(teams)
    return records


def match_record(project: dict[str, Any], record: dict[str, Any]) -> float:
    score = 0.0
    if project.get("sourceProjectId") and project.get("sourceProjectId") == record.get("source_project_id"):
        score = max(score, 1.0)
    project_name = normalize_name(project.get("name", ""))
    record_name = normalize_name(record.get("name", ""))
    if project_name and record_name:
        ratio = SequenceMatcher(None, project_name, record_name).ratio()
        contains = project_name in record_name or record_name in project_name
        score = max(score, ratio, 0.86 if contains else 0.0)
    return score


def merge_records(data: dict[str, Any], records: list[dict[str, Any]]) -> dict[str, int]:
    projects = data["projects"]
    lookup = known_coordinate_lookup(projects)
    matched = appended = resolved_count = unresolved_count = 0
    seed_project_ids = {project["id"] for project in projects}
    matched_project_ids: set[str] = set()
    next_row = max(int(project.get("sourceRow") or 0) for project in projects) + 1

    for record in records:
        candidates = [
            project for project in projects
            if project.get("utility") == record["company"]
            and project.get("id") in seed_project_ids
            and project.get("id") not in matched_project_ids
        ]
        best = max(candidates, key=lambda project: match_record(project, record), default=None)
        best_score = match_record(best, record) if best else 0.0
        notes = [
            f"Extracted from {record['document']}, PDF page {record['document_page']}.",
            f"PDF source ID: {record['source_project_id']}.",
        ]
        if record.get("sponsor") and record["sponsor"] not in ["GPC", "Dominion Energy South Carolina"]:
            notes.append(f"Listed sponsor/source: {record['sponsor']}.")
        if record.get("start_date"):
            notes.append(f"PDF start date: {record['start_date']}.")
        if record.get("description"):
            notes.append(f"PDF description: {record['description'][:240]}.")
        if record.get("need"):
            notes.append(f"PDF need: {record['need'][:180]}.")

        if best and best_score >= 0.78:
            best["sourceProjectId"] = best.get("sourceProjectId") or record["source_project_id"]
            best["document"] = record["document"]
            best["documentPage"] = record["document_page"]
            best["status"] = record.get("status") or best.get("status")
            best["voltageKv"] = record.get("voltage_kv") or best.get("voltageKv")
            best["assetType"] = record.get("asset_type") or best.get("assetType")
            best["workType"] = record.get("work_type") or best.get("workType")
            best["sponsor"] = record.get("sponsor") or best.get("sponsor")
            best["notes"] = list(dict.fromkeys([*best.get("notes", []), *notes]))
            matched_project_ids.add(best["id"])
            matched += 1
            continue

        endpoints, resolved = endpoints_for(record["name"], lookup)
        resolved_count += resolved
        if resolved == 0:
            unresolved_count += 1
            notes.append("No endpoint coordinates were inferred; project will not appear as a map marker until reviewed.")
        else:
            notes.append("Endpoint coordinates were reused from known workbook endpoint names; review before relying on location.")
        projects.append({
            "id": f"{record['company']}_PDF_{slug(record['source_project_id'])}",
            "utility": record["company"],
            "state": record["state"],
            "name": record["name"],
            "shortName": record["short_name"][:80],
            "endpoints": endpoints,
            "inServiceDate": record["in_service_date"],
            "rawDate": record["raw_date"],
            "sourceRow": next_row,
            "sourceProjectId": record["source_project_id"],
            "document": record["document"],
            "documentPage": record["document_page"],
            "status": record.get("status"),
            "voltageKv": record.get("voltage_kv"),
            "assetType": record.get("asset_type"),
            "workType": record.get("work_type"),
            "sponsor": record.get("sponsor"),
            "notes": notes,
        })
        next_row += 1
        appended += 1

    return {
        "matched": matched,
        "appended": appended,
        "resolved_endpoint_coordinates": resolved_count,
        "unresolved_coordinate_projects": unresolved_count,
    }


def main() -> int:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    dominion = extract_dominion()
    georgia = extract_georgia()
    stats = merge_records(data, [*dominion, *georgia])
    data["name"] = "Provided planning snapshot plus ProjectListings extraction"
    data["source"] = "Projects_Overlaps.xlsx + ProjectListings PDFs"
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    WORK.mkdir(exist_ok=True)
    diagnostics = {
        "dominion_extracted": len(dominion),
        "georgia_extracted": len(georgia),
        "total_projects": len(data["projects"]),
        **stats,
    }
    (WORK / "project_listings_import_summary.json").write_text(json.dumps(diagnostics, indent=2), encoding="utf-8")
    print(json.dumps(diagnostics, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
