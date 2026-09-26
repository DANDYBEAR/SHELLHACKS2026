# Data layer

The prototype now has two local data representations:

- `data/projects.json` remains the frontend/API-compatible normalized sample used by the current backend.
- `data/gridlock.sqlite` is a generated local SQLite database for the next phase of scoring, ranking, enrichment and document parsing work. It is intentionally ignored by Git because it is reproducible from `data/projects.json` and `schema.sql`.

The backend still reads `projects.json` for `/api/dashboard`, `/api/projects` and `/api/opportunities`. The SQLite database is the new foundation for sequentially moving toward a full data-backed platform without changing the UI all at once.

## Build the local database

From the project root:

```powershell
python scripts/build_db.py
```

The script creates `db/data/gridlock.sqlite` with:

- 10 normalized projects
- project endpoints and computed project centers
- utilities
- source document records
- scoring profiles and parameter weights
- scored utility-pair opportunities
- internal extraction tables for future Gemini parsing

## Current source

Source: user-supplied `Projects_Overlaps.xlsx`, `projects!A1:Q11`. Validation reference: `overlaps!A1:I7`. The importer preserves source row numbers, source date strings and missing endpoint coordinates, and converts Excel dates and date strings to ISO calendar dates. Coordinates are stored in GeoJSON longitude/latitude order.

Supporting Dominion references in the supplied `2024-2028-2million-and-above-project-descriptions.pdf`: DESC_1 page 14 (6809 E), DESC_2 page 31 (6810 A), DESC_3 page 23 (06367 D - G), DESC_4 page 1 (6807 B), DESC_5 page 10 (6808 S). The similarly named page-15 project 6809 G is distinct.

Georgia records use only the organizer-provided workbook data. No Georgia PDF excerpts, restricted pages or source PDF binaries are included in the application.

## Database model

`schema.sql` separates the parts we need to score and rank utility coordination opportunities:

- `dataset_versions`: imported planning snapshots
- `utilities`: utility/company definitions
- `source_documents`: internal file records for PDFs/workbooks
- `projects`: project-level facts, dates, type, status, and confidence fields
- `project_endpoints`: endpoint names and coordinates
- `project_centers`: computed view of center coordinates
- `geo_contexts`: future location enrichment, including TIGER/Line identifiers
- `scoring_profiles`: named scoring models
- `scoring_parameters`: weights for distance, timing, confidence and resource similarity
- `opportunity_scores`: ranked utility-to-utility project pairs
- `document_extractions`: internal Gemini/parser output storage
- `dashboard_projects`: UI-safe project view

The UI should continue to show project facts and rankings. It should not expose evidence explanations or raw parser output. `document_extractions` exists so the system can self-check and enrich records later without making source reasoning part of the user-facing dashboard.

## TIGER/Line data

TIGER/Line data can be useful, but it should not be the main project database. It is best as a geographic enrichment layer.

Useful TIGER/Line fields later:

- county and place GEOIDs for each project center
- county/state context for grouping and filtering
- road and linear-feature proximity for access/logistics scoring
- census geography for regional clustering
- jurisdiction boundaries for “same county / neighboring county” rules

Less useful for this challenge:

- It will not identify utility project endpoints by itself.
- It will not confirm construction schedules.
- It will not prove shared equipment or crew availability.

A good next step is to add a TIGER enrichment script that takes project centers from SQLite, looks up county/place/road context, and writes results into `geo_contexts`. That can improve scoring without adding more UI clutter.

## Regenerate JSON from the workbook

To regenerate `projects.json`, install Python's `openpyxl` in your Python environment and run from the project root:

```powershell
python scripts/import_sample.py "C:\path\to\Projects_Overlaps.xlsx"
```

The source workbook is read-only. The command regenerates only this project's normalized JSON. Run `python scripts/build_db.py` after replacing JSON.
