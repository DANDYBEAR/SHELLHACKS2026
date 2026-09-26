# Hidden Gemini document parsing

The Gemini integration is backend/script-only. The API key is read from `GEMINI_API_KEY` in the local environment and is never sent to the frontend or returned by the API.

## Why this is hidden

The dashboard should show project facts and rankings, not evidence explanations or LLM reasoning. Gemini output is stored in internal database tables for later review and self-checking:

- `source_documents.parser_status`
- `source_documents.parser_model`
- `source_documents.parsed_at`
- `document_extractions.extracted_json`
- `document_extractions.confidence`
- `document_extractions.review_status`

## Current supported inputs

The current sample `Project Listings` folder contains two PDFs:

- Dominion Energy: `2024-2028-2million-and-above-project-descriptions.pdf`
- Georgia Power: `2025 IRP Volume 3 PUBLIC DISCLOSURE.pdf`

Both are under Gemini's inline PDF size limit, so the first parser implementation sends PDFs inline. If future files are larger or reused frequently, switch to Gemini Files API upload.

## Setup

Create the local SQLite DB first:

```powershell
python scripts/build_db.py
```

Set the key only in your shell or a local `.env` file that is ignored by Git:

```powershell
$env:GEMINI_API_KEY="your-key"
$env:GEMINI_MODEL="gemini-3.8-flash"
```

Dry-run registration without calling Gemini:

```powershell
python scripts/gemini_extract_documents.py --project-listings "C:\Users\jeffr\Downloads\OneDrive_2026-09-26\ShellHacks 2026 - Gridlock\Project Listings" --dry-run
```

Run extraction:

```powershell
python scripts/gemini_extract_documents.py --project-listings "C:\Users\jeffr\Downloads\OneDrive_2026-09-26\ShellHacks 2026 - Gridlock\Project Listings"
```

## Output shape

Gemini is prompted to return strict JSON with candidate project records:

- source project ID
- project name and short name
- state
- planned date and date semantics
- voltage
- asset type and work type
- endpoint names
- location clues
- resource clues
- confidence
- internal assertion notes

The parser does not write candidate projects directly into the UI tables. It stores raw extraction JSON for later review. A separate promotion step should validate extracted candidates before inserting or updating `projects`, `project_endpoints`, `geo_contexts`, and scoring tables.

## Official API notes

Google's Gemini docs support PDF document understanding and structured extraction. Smaller PDFs can be passed inline; the Files API is recommended for larger or reused documents. Keep provider terms, disclosure markings, and document restrictions in mind before turning parsed records into user-facing data.
