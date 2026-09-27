# Adopted prototype plan

## Distance and ranking

Use the arithmetic midpoint of two complete endpoint coordinate pairs, or the one located endpoint. Unlocated projects have no center. Calculate straight-line Haversine distance with mean Earth radius 3958.7613 miles. These conventions reproduce the supplied workbook.

| Tier | Unrounded center distance | Potential scenario |
| --- | --- | --- |
| 1 Immediate | 0 to under 1 mi | Site access, staging, nearby land needs |
| 2 Local | 1 to under 5 mi | Equipment staging, deliveries, logistics |
| 3 Regional | 5 to under 25 mi | Crews, specialized equipment, mobilization |
| Excluded | 25 mi and above | Outside challenge threshold |

Tiers are product decisions agreed in chat, not organizer-defined categories. Default ranking: tier, absolute date gap (unknown last), exact center distance, stable pair ID. Nearest-first and closest-dates sorts are available. Display rounding never changes eligibility. Geographic candidates contain each cross-utility pair once.

The new Finding_Real_Locations_Guide.docx Part 3 explicitly specifies center-to-center distance and a midpoint/single-endpoint center. Its under-25-mile rule takes priority over earlier minimum-route-distance suggestions. No physical-intersection tier is inferred from centers.

Opportunity scores use two categories only: distance (50 points) and timeline (50 points), for 100 points total. Distance scores follow the supplied 0–2, >2–5, >5–10, >10–15, >15–20, and >20–25 mile bands; distances over 25 miles are excluded. Timeline scores follow the supplied construction-overlap and date-separation bands, scaled from 40 to 50 points. Because construction windows are not present in current records, current timeline scores use the separation between planned in-service dates.

## Product

Frontend-first local prototype with an actual read-only API. A file-based dataset is sufficient for ten projects, so no database service or authentication is introduced. Keep db separate so a database can later replace the repository without changing the UI contract.

Three panels: opportunities, dominant map and selected-pair evidence. Light/Dark/System themes preserve map camera and selection. MapLibre with OpenFreeMap provides light/dark basemaps without requiring a key. This replaces the initial MapTiler default solely to make the prototype runnable immediately; configurable style URLs preserve that option. Semantic native controls and custom React/CSS implement the prototype without an extra component framework.

Distance, date gap and endpoint completeness appear together. Timeline uses dated milestones, not invented construction bars. Selected endpoints have dashed guides labeled route-unverified. All project centers remain visible even when no pair matches filters. Exports include methods, source references and limitations.

## After prototype review

1. Resolve source publication markings: Georgia's supplied public-disclosure PDF also carries CEII/confidential headers. Use an unambiguously public source or organizer clarification before importing its details into the app.
2. Expand extraction by utility source ID; separate active, cancelled and completed records, preserve sponsor and original date terminology. Do not label all Georgia ITS sponsors as Georgia Power.
3. Review coordinate matches against public descriptions, resolve incomplete endpoints and the McIntosh discrepancy, and record review provenance.
4. Add confirmed route geometry and real construction intervals if available, without changing the challenge's center-distance definition.
5. Add an editable cost/resource scenario only when assumptions and units are transparent.

## Validation

Reconcile 10 projects, 25 combinations and six workbook overlaps, distances within 0.01 mile, and exact day gaps. Test 1/5/25-mile boundaries, missing coordinates, dates and ranking. Exercise selection, filters, both themes, map overlays after style reload, exports, errors and responsive layout in the browser. Do not modify the existing Word Plan document.
