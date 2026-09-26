# Gridlock prototype

A local working dashboard for the ShellHacks Gridlock challenge. React frontend, Node API, and a separate data directory. The original Word documents and workbook are unchanged.

## Start

Requires Node.js 22 or newer and npm.

```powershell
npm install
npm run dev
```

Open http://localhost:5173. The API runs at http://127.0.0.1:3001. Both bind to loopback only. Stop them with Ctrl+C. Port conflicts fail explicitly rather than opening a different port.

```powershell
npm test
npm run build
npm start
```

After a build, `npm start` serves the frontend and API together at http://127.0.0.1:3001.
With the development server running, `npm run test:browser` checks regional and street-scale tiles in both themes. It saves temporary screenshots under the ignored `work/` folder.

## Organization

```text
frontend/       React UI, themes, map, timeline and exports
backend/        Read-only Node HTTP API and startup validation
db/data/        Canonical normalized sample, no database server required
shared/         Types, distance calculations, tiers and ranking
scripts/        Reproducible workbook import
tests/          Geographic, date, ranking and sample reconciliation tests
docs/           Updated implementation decisions and data provenance
```

`GET /api/dashboard` returns metadata, projects, computed opportunities and candidate count. `/api/projects`, `/api/opportunities` and `/api/health` expose the corresponding subsets. There are no write endpoints, credentials or accounts.

## Included behavior

- Real zoomable map with OpenFreeMap street basemaps, Light/Dark/System themes and matching map styles.
- Ten supplied workbook project centers, six geographic matches, and three distance tiers.
- Pair selection, map fit, street-level inspection, endpoint guides and optional 25-mile radius.
- Search, tier/date/endpoint filters and coordination/nearest/date sorts.
- Source evidence, incomplete-location notes, milestone timeline, JSON and print-to-PDF summaries.
- Responsive desktop/tablet/mobile layout; accessible buttons and theme preferences saved on this device.

No API key is needed. Basemap resources go through the local read-only API to avoid browser restrictions; the backend still needs internet access to OpenFreeMap. MapLibre's Vite worker is bundled explicitly so vector tiles render. The dark style increases road contrast for inspection. Optional Google Fonts have a system fallback, and map errors retain the project results. Map styles can be replaced with MapTiler or another MapLibre-compatible provider using `frontend/.env.local`; see `.env.example`. Keep provider attribution and configure browser-key restrictions with your provider.

## Data and interpretation

The sample is the supplied workbook planning snapshot, not verified current construction. Its reference date is 2026-09-26. Coordinates are not independently verified, four projects have only one located endpoint, and the McIntosh entries differ by about 657 meters. Past planned dates do not prove completion.

The app draws project centers and explicitly unverified endpoint guides, not actual transmission routes. Date gaps are not confirmed construction overlaps. Scenarios indicate what to investigate, not confirmed savings or shared land.

Read [the updated plan](docs/PLAN.md) and [data provenance](db/README.md) for the adopted rules and remaining work.

To reload the supplied workbook and rebuild `db/data/gridlock.sqlite`, run:

```powershell
npm run data:refresh
```
