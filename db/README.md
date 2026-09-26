# Data layer

The prototype now has one local data representation for app data:

- `data/gridlock.sqlite` is the generated local SQLite database read by the backend. It is intentionally ignored by Git because it is reproducible from the supplied workbook and `schema.sql`.

The backend reads SQLite for `/api/dashboard`, `/api/projects` and `/api/opportunities`. The API response shape remains frontend-compatible.

## Build the local database

From the project root:

```powershell
python scripts/build_db.py
```

The refresh scripts create `db/data/gridlock.sqlite` with:

- 10 normalized projects from the workbook `projects` sheet
- project endpoints and computed project centers
- utilities
- source document table, empty until document-backed imports are intentionally re-enabled
- scoring profiles and parameter weights
- scored utility-pair opportunities

## Current source

Source: user-supplied `Projects_Overlaps.xlsx`, `projects!A1:Q11`. Validation reference: `overlaps!A1:I7`. The workbook importer preserves source row numbers, source date strings and missing endpoint coordinates, and converts Excel dates and date strings to ISO calendar dates. Coordinates are stored in GeoJSON longitude/latitude order.

PDF and synthetic enrichment records are not part of the current database. `gridlock.sqlite` is rebuilt from the workbook only.

## Database model

`schema.sql` separates the parts we need to score and rank utility coordination opportunities:

- `dataset_versions`: imported planning snapshots
- `utilities`: utility/company definitions
- `source_documents`: internal file records for future document-backed imports
- `projects`: project-level facts, dates, type, status, and confidence fields
- `project_endpoints`: endpoint names and coordinates
- `project_notes`: ordered project notes shown in evidence views
- `project_centers`: computed view of center coordinates
- `geo_contexts`: future location enrichment, including TIGER/Line identifiers
- `scoring_profiles`: named scoring models
- `scoring_parameters`: weights for distance, timing, confidence and resource similarity
- `opportunity_scores`: ranked utility-to-utility project pairs
- `dashboard_projects`: UI-safe project view

The UI should continue to show project facts and rankings from SQLite-backed API responses.

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

## Regenerate SQLite from the workbook

To regenerate SQLite from the supplied workbook, run from the project root:

```powershell
npm run data:refresh
```

The source workbook is read-only. The importer uses Python's standard library and does not require `openpyxl`.
