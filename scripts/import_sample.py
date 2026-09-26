"""Read the supplied workbook without modifying it. Rebuild db/data/projects.json."""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    "office_rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}


def column_index(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref)
    if letters is None:
        raise ValueError(f"Invalid cell reference: {cell_ref}")
    index = 0
    for char in letters.group(0):
        index = index * 26 + ord(char) - ord("A") + 1
    return index - 1


def read_shared_strings(book: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(book.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [
        "".join(text.text or "" for text in item.findall(".//main:t", NS))
        for item in root.findall("main:si", NS)
    ]


def sheet_path(book: zipfile.ZipFile, sheet_name: str) -> str:
    workbook = ET.fromstring(book.read("xl/workbook.xml"))
    rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
    targets = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels.findall("rel:Relationship", NS)}
    for sheet in workbook.findall("main:sheets/main:sheet", NS):
        if sheet.attrib["name"] == sheet_name:
            rel_id = sheet.attrib[f"{{{NS['office_rel']}}}id"]
            return "xl/" + targets[rel_id].lstrip("/")
    raise KeyError(f"Sheet not found: {sheet_name}")


def maybe_number(value: str) -> object:
    if not re.fullmatch(r"-?\d+(?:\.\d+)?", value):
        return value
    number = float(value)
    return int(number) if number.is_integer() else number


def read_sheet(book: zipfile.ZipFile, sheet_name: str) -> list[list[object]]:
    shared = read_shared_strings(book)
    root = ET.fromstring(book.read(sheet_path(book, sheet_name)))
    rows: list[list[object]] = []
    for row in root.findall(".//main:sheetData/main:row", NS):
        values: list[object] = []
        for cell in row.findall("main:c", NS):
            while len(values) < column_index(cell.attrib["r"]):
                values.append(None)
            value_node = cell.find("main:v", NS)
            value = None if value_node is None else value_node.text
            if cell.attrib.get("t") == "s" and value is not None:
                value = shared[int(value)]
            elif value is not None:
                value = maybe_number(value)
            values.append(value)
        rows.append(values)
    return rows


def parse_date(value: object) -> tuple[str | None, str]:
    if value is None:
        return None, ""
    if isinstance(value, (int, float)):
        parsed = dt.datetime(1899, 12, 30) + dt.timedelta(days=float(value))
        return parsed.strftime("%Y-%m-%d"), parsed.strftime("%m/%d/%Y")
    raw = str(value)
    parsed = dt.datetime.strptime(raw, "%m/%d/%Y")
    return parsed.strftime("%Y-%m-%d"), raw


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/import_sample.py <Projects_Overlaps.xlsx>")
    source = Path(sys.argv[1])
    with zipfile.ZipFile(source) as workbook:
        rows = read_sheet(workbook, "projects")

    short_names = [
        "Stevens Creek - Hooks",
        "Hooks - Thurmond",
        "Jasper - Okatie",
        "Queensboro - Ft Johnson",
        "Okatie - Bluffton",
        "Evans Primary - Thurmond Dam",
        "McIntosh - Purrysburg",
        "Goshen - McIntosh",
        "Mitchell - North Tifton",
        "Jesup - Ludowici Primary",
    ]
    desc_sources = {
        "DESC_1": ("6809 E", 14),
        "DESC_2": ("6810 A", 31),
        "DESC_3": ("06367 D - G", 23),
        "DESC_4": ("6807 B", 1),
        "DESC_5": ("6808 S", 10),
    }
    document_by_utility = {
        "DESC": "2024-2028-2million-and-above-project-descriptions.pdf",
        "GPC": "2025 IRP Volume 3 PUBLIC DISCLOSURE.pdf",
    }

    projects = []
    headers = rows[0]
    for i, row in enumerate(rows[1:]):
        record = dict(zip(headers, row))
        iso_date, raw_date = parse_date(record["in_service_date"])
        endpoints = []
        for suffix in ["a", "b"]:
            lat, lon = record.get(f"lat_{suffix}"), record.get(f"lon_{suffix}")
            endpoints.append({
                "name": record[f"name_{suffix}"],
                "coordinates": [lon, lat] if lat is not None and lon is not None else None,
            })

        project_id = str(record["project_id"])
        utility = project_id.split("_")[0]
        notes = ["Coordinates supplied by the starter workbook; not independently location-verified."]
        if any(endpoint["coordinates"] is None for endpoint in endpoints):
            notes.append("One endpoint is missing. The located endpoint represents the project center.")
        if project_id in ["GPC_2", "GPC_3"]:
            notes.append("McIntosh coordinates differ by approximately 657 m between workbook records. Review before merging.")
        if project_id == "DESC_1":
            notes.append("Source project 6809 E; a similarly named project 6809 G is a separate record.")
        if utility == "GPC":
            notes.append("Date retained as labeled by the workbook. Georgia PDF uses Need Date; source terminology and disclosure markings require review before enrichment.")

        source_project_id, page = desc_sources.get(project_id, (None, None))
        projects.append({
            "id": project_id,
            "utility": utility,
            "state": record["state"],
            "name": record["project_name"],
            "shortName": short_names[i],
            "endpoints": endpoints,
            "inServiceDate": iso_date,
            "rawDate": raw_date,
            "sourceRow": i + 2,
            "sourceProjectId": source_project_id,
            "document": document_by_utility[utility],
            "documentPage": page,
            "notes": notes,
        })

    output = ROOT / "db" / "data" / "projects.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "name": "Provided planning snapshot",
        "source": source.name,
        "referenceDate": "2026-09-26",
        "projects": projects,
    }, indent=2), encoding="utf-8")
    print(f"Imported {len(projects)} projects into {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
