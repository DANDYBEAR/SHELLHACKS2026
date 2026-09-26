# Data layer

The prototype now has two local data representations:

- `data/projects.json` remains the frontend/API-compatible normalized sample used by the current backend.
- `data/gridlock.sqlite` is a generated local SQLite database for the next phase of scoring, ranking and enrichment work. It is intentionally ignored by Git because it is reproducible from `data/projects.json` and `schema.sql`.

The backend still reads `projects.json` for `/api/dashboard`, `/api/projects` and `/api/opportunities`. The SQLite database is the new foundation for sequentially moving toward a full data-backed platform without changing the UI all at once.

## Build the local database

From the project root:

```powershell
python scripts/build_db.py
```

The refresh scripts create `db/data/gridlock.sqlite` with:

- 252 normalized projects after merging workbook rows and ProjectListings PDF records
- project endpoints and computed project centers
- utilities
- source document records
- scoring profiles and parameter weights
- scored utility-pair opportunities
- registered source document paths for the supplied PDFs

## Current source

Source: user-supplied `Projects_Overlaps.xlsx`, `projects!A1:Q11`, plus PDFs under `ProjectListings/`. Validation reference: `overlaps!A1:I7`. The workbook importer preserves source row numbers, source date strings and missing endpoint coordinates, and converts Excel dates and date strings to ISO calendar dates. Coordinates are stored in GeoJSON longitude/latitude order.

The PDF import extracts 44 Dominion pages and 208 Georgia ITS project detail pages. Existing workbook rows are enriched when source IDs or project names match, and PDF-only projects are appended. Endpoint coordinates are reused only from known workbook endpoint names; otherwise the project stays searchable but does not produce a map marker.

Supporting Dominion references in the supplied `2024-2028-2million-and-above-project-descriptions.pdf`: DESC_1 page 14 (6809 E), DESC_2 page 31 (6810 A), DESC_3 page 23 (06367 D - G), DESC_4 page 1 (6807 B), DESC_5 page 10 (6808 S). The similarly named page-15 project 6809 G is distinct.

Georgia records use only the organizer-provided workbook data. The local PDF is registered in SQLite as a source document for test workflows, but its text is not parsed into project facts.

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
- `dashboard_projects`: UI-safe project view

The UI should continue to show project facts and rankings. Source PDFs are registered as local documents, but project facts come from the workbook import until a separate review workflow promotes additional fields.

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

To regenerate `projects.json` and rebuild SQLite from the supplied workbook, run from the project root:

```powershell
npm run data:refresh
```

The source workbook is read-only. The importer uses Python's standard library and does not require `openpyxl`.
