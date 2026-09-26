# Data layer

`data/projects.json` is the prototype's canonical read-only dataset. This folder deliberately contains no live database or fake migration. The backend validates it at startup and computes all pairs; it does not trust cached overlap counts or the workbook's displayed formulas.

Source: user-supplied `Projects_Overlaps.xlsx`, `projects!A1:Q11`. Validation reference: `overlaps!A1:I7`. The importer preserves source row numbers, source date strings and missing endpoint coordinates, and converts Excel dates and date strings to ISO calendar dates. Coordinates are stored in GeoJSON longitude/latitude order.

Supporting Dominion references in the supplied `2024-2028-2million-and-above-project-descriptions.pdf`: DESC_1 page 14 (6809 E), DESC_2 page 31 (6810 A), DESC_3 page 23 (06367 D - G), DESC_4 page 1 (6807 B), DESC_5 page 10 (6808 S). The similarly named page-15 project 6809 G is distinct.

Georgia records use only the organizer-provided workbook data. No Georgia PDF excerpts, restricted pages or source PDF binaries are included in the application. Its Need Date terminology and conflicting disclosure markings need review before enrichment. Coordinate completeness is not a verification confidence score.

To regenerate, install Python's openpyxl in your Python environment and run from the project root:

```powershell
python scripts/import_sample.py "C:\path\to\Projects_Overlaps.xlsx"
```

The source workbook is read-only. The command regenerates only this project's normalized JSON. Restart the backend after replacing data.

Future database integration should retain stable IDs, original utility IDs, endpoint provenance, date semantics and dataset version. An API data repository can replace the JSON read while preserving `/api/dashboard`.
