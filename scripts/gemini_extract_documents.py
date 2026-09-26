r"""Hidden Gemini document parser for internal DB enrichment.

Usage examples:
  python scripts/gemini_extract_documents.py --project-listings "C:\path\to\Project Listings" --dry-run
  $env:GEMINI_API_KEY="..."
  python scripts/gemini_extract_documents.py --project-listings "C:\path\to\Project Listings"

The API key is read only from the environment. It is never written to disk,
returned by the backend, or exposed to the frontend.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "db" / "data" / "gridlock.sqlite"
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.8-flash")
API_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"

PROMPT = """
You are extracting utility transmission planning projects for an internal database.
Return JSON only. Do not include markdown fences or prose.

Extract candidate project records from the attached PDF. Focus on projects that
could be compared against other utility projects for coordination opportunities.
If a field is not present, use null. Do not infer exact coordinates.

Return this exact JSON shape:
{
  "document_summary": {
    "utility_name": string | null,
    "document_years": string | null,
    "date_semantics": string | null
  },
  "projects": [
    {
      "source_project_id": string | null,
      "project_name": string,
      "short_name": string | null,
      "state": string | null,
      "planned_date": string | null,
      "raw_date": string | null,
      "date_semantics": string | null,
      "voltage_kv": number | null,
      "asset_type": string | null,
      "work_type": string | null,
      "estimated_cost_usd": number | null,
      "endpoint_names": [string],
      "location_clues": [string],
      "resource_clues": [string],
      "confidence": number,
      "internal_assertion_notes": [string]
    }
  ]
}

Rules:
- Confidence must be between 0 and 1.
- Keep internal_assertion_notes concise and factual for later self-checking.
- Do not produce user-facing evidence explanations.
- Prefer visible project IDs, page/table labels, dates, endpoint names, voltage, asset type, and construction/work type.
- If there are many records, return the most relevant transmission/grid capital projects first.
""".strip()


def detect_utility(path: Path) -> str | None:
    text = " ".join(part.lower() for part in path.parts)
    if "dominion" in text:
        return "DESC"
    if "georgia" in text or "gpc" in text:
        return "GPC"
    return None


def ensure_document(con: sqlite3.Connection, file_path: Path, utility_code: str | None) -> int:
    row = con.execute("SELECT id FROM dataset_versions ORDER BY id DESC LIMIT 1").fetchone()
    if row is None:
        raise RuntimeError("No dataset_versions row found. Run scripts/build_db.py first.")
    dataset_id = row[0]
    existing = con.execute(
        "SELECT id FROM source_documents WHERE dataset_id = ? AND file_name = ?",
        (dataset_id, file_path.name),
    ).fetchone()
    if existing:
        con.execute(
            "UPDATE source_documents SET utility_code = COALESCE(utility_code, ?), file_path = ?, document_type = 'pdf' WHERE id = ?",
            (utility_code, str(file_path), existing[0]),
        )
        return existing[0]
    con.execute(
        """
        INSERT INTO source_documents(dataset_id, utility_code, file_name, file_path, document_type, parser_status)
        VALUES (?, ?, ?, ?, 'pdf', 'pending')
        """,
        (dataset_id, utility_code, file_path.name, str(file_path)),
    )
    return con.execute("SELECT last_insert_rowid()").fetchone()[0]


def gemini_generate(api_key: str, model: str, pdf_path: Path) -> dict[str, Any]:
    encoded = base64.b64encode(pdf_path.read_bytes()).decode("ascii")
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": PROMPT},
                    {"inlineData": {"mimeType": "application/pdf", "data": encoded}},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json",
        },
    }
    url = API_ENDPOINT.format(model=model, key=api_key)
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini API request failed with HTTP {exc.code}: {detail[:1000]}") from exc
    text = "".join(
        part.get("text", "")
        for candidate in body.get("candidates", [])
        for part in candidate.get("content", {}).get("parts", [])
    ).strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    if not text:
        raise RuntimeError("Gemini returned no text content")
    return json.loads(text)


def confidence_from_payload(payload: dict[str, Any]) -> float:
    projects = payload.get("projects") or []
    values = [p.get("confidence") for p in projects if isinstance(p.get("confidence"), (int, float))]
    if not values:
        return 0.5
    return max(0.0, min(1.0, sum(values) / len(values)))


def store_extraction(con: sqlite3.Connection, document_id: int, payload: dict[str, Any]) -> None:
    con.execute("DELETE FROM document_extractions WHERE document_id = ? AND extraction_kind = 'gemini_project_candidates'", (document_id,))
    con.execute(
        """
        INSERT INTO document_extractions(document_id, extraction_kind, extracted_json, confidence, review_status)
        VALUES (?, 'gemini_project_candidates', ?, ?, 'unreviewed')
        """,
        (document_id, json.dumps(payload, ensure_ascii=False, indent=2), confidence_from_payload(payload)),
    )
    con.execute(
        "UPDATE source_documents SET parser_status = 'parsed', parser_model = ?, parsed_at = datetime('now') WHERE id = ?",
        (DEFAULT_MODEL, document_id),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Parse Project Listings PDFs with Gemini into internal SQLite extraction tables.")
    parser.add_argument("--project-listings", required=True, help="Path to the Project Listings folder")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to generated SQLite DB")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Gemini model name")
    parser.add_argument("--dry-run", action="store_true", help="Scan and register documents without calling Gemini")
    parser.add_argument("--limit", type=int, default=0, help="Optional max number of PDFs to process")
    args = parser.parse_args()

    root = Path(args.project_listings)
    if not root.exists():
        raise SystemExit(f"Project Listings folder not found: {root}")
    db = Path(args.db)
    if not db.exists():
        raise SystemExit(f"SQLite database not found: {db}. Run python scripts/build_db.py first.")

    pdfs = sorted(root.rglob("*.pdf"))
    if args.limit:
        pdfs = pdfs[: args.limit]
    if not pdfs:
        raise SystemExit("No PDFs found")

    api_key = os.environ.get("GEMINI_API_KEY")
    if not args.dry_run and not api_key:
        raise SystemExit("GEMINI_API_KEY is not set. Set it in the environment or use --dry-run.")

    con = sqlite3.connect(db)
    con.execute("PRAGMA foreign_keys = ON")
    try:
        for pdf in pdfs:
            utility_code = detect_utility(pdf)
            document_id = ensure_document(con, pdf, utility_code)
            print(f"document_id={document_id} utility={utility_code or 'unknown'} size={pdf.stat().st_size} file={pdf}")
            if args.dry_run:
                con.execute("UPDATE source_documents SET parser_status = 'registered' WHERE id = ?", (document_id,))
                continue
            try:
                payload = gemini_generate(api_key or "", args.model, pdf)
                store_extraction(con, document_id, payload)
                print(f"  extracted_projects={len(payload.get('projects') or [])}")
            except Exception as exc:
                con.execute("UPDATE source_documents SET parser_status = 'failed', parser_model = ? WHERE id = ?", (args.model, document_id))
                print(f"  failed: {exc}", file=sys.stderr)
        con.commit()
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
