import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { rankOpportunities } from '../../shared/analysis';
import type { Coordinate, DashboardData, Dataset, Endpoint, Opportunity, Project } from '../../shared/types';
const usStateBoundaries = JSON.parse(await readFile(new URL('../../frontend/src/data/us-states.json', import.meta.url), 'utf8'));
const dbPath = fileURLToPath(new URL('../../db/data/gridlock.sqlite', import.meta.url));
const db = new DatabaseSync(dbPath, { readOnly: true });
type ProjectRow = {
  id: string; utility: string; state: string; name: string; shortName: string;
  sourceRow: number; sourceProjectId: string | null; inServiceDate: string | null;
  rawDate: string; document: string | null; documentPage: number | null;
};
type EndpointRow = { projectId: string; endpointOrder: number; name: string; longitude: number | null; latitude: number | null };
type NoteRow = { projectId: string; note: string };
function coordinate(longitude: number | null, latitude: number | null): Coordinate | null {
  return longitude === null || latitude === null ? null : [longitude, latitude];
}
function latestDataset() {
  const row = db.prepare('SELECT name, source, reference_date AS referenceDate FROM dataset_versions ORDER BY id DESC LIMIT 1').get() as Pick<Dataset, 'name' | 'source' | 'referenceDate'> | undefined;
  if (!row) throw new Error('SQLite dataset is empty. Run npm run data:refresh.');
  return row;
}
function loadProjects(): Project[] {
  const rows = db.prepare(`
    SELECT p.id, p.utility_code AS utility, p.state, p.name, p.short_name AS shortName,
      p.source_row AS sourceRow, p.source_project_id AS sourceProjectId,
      p.in_service_date AS inServiceDate, COALESCE(p.raw_date, '') AS rawDate,
      sd.file_name AS document, p.document_page AS documentPage
    FROM projects p
    LEFT JOIN source_documents sd ON sd.id = p.document_id
    WHERE EXISTS (
      SELECT 1
      FROM project_endpoints e
      WHERE e.project_id = p.id
        AND e.longitude IS NOT NULL
        AND e.latitude IS NOT NULL
    )
    ORDER BY p.source_row, p.id
  `).all() as ProjectRow[];
  const endpointRows = db.prepare(`
    SELECT project_id AS projectId, endpoint_order AS endpointOrder, name, longitude, latitude
    FROM project_endpoints
    ORDER BY project_id, endpoint_order
  `).all() as EndpointRow[];
  const noteRows = db.prepare('SELECT project_id AS projectId, note FROM project_notes ORDER BY project_id, note_order').all() as NoteRow[];
  const endpoints = new Map<string, Endpoint[]>();
  for (const endpoint of endpointRows) {
    const list = endpoints.get(endpoint.projectId) ?? [];
    list[endpoint.endpointOrder - 1] = { name: endpoint.name, coordinates: coordinate(endpoint.longitude, endpoint.latitude) };
    endpoints.set(endpoint.projectId, list);
  }
  const notes = new Map<string, string[]>();
  for (const note of noteRows) notes.set(note.projectId, [...(notes.get(note.projectId) ?? []), note.note]);
  return rows.map(row => {
    const projectEndpoints = endpoints.get(row.id);
    if (!projectEndpoints || projectEndpoints.length !== 2) throw new Error(`Project ${row.id} does not have two endpoints`);
    return {
      id: row.id,
      utility: row.utility,
      state: row.state,
      name: row.name,
      shortName: row.shortName,
      endpoints: projectEndpoints as [Endpoint, Endpoint],
      inServiceDate: row.inServiceDate,
      rawDate: row.rawDate,
      sourceRow: row.sourceRow,
      sourceProjectId: row.sourceProjectId,
      document: row.document,
      documentPage: row.documentPage,
      notes: notes.get(row.id) ?? [],
    } as Project;
  });
}
function loadOpportunities(): Opportunity[] {
  const rows = db.prepare(`
    SELECT id, project_a AS projectA, project_b AS projectB, center_distance_mi AS distanceMi,
      date_gap_days AS timeGapDays, distance_tier AS tier,
      distance_score AS distanceScore, timeline_score AS timelineScore,
      total_score AS totalScore
    FROM opportunity_scores
  `).all() as Opportunity[];
  return rankOpportunities(rows);
}
function loadCandidateCount(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM projects a
    JOIN projects b ON a.id < b.id AND a.utility_code <> b.utility_code
    WHERE EXISTS (
      SELECT 1
      FROM project_endpoints ea
      WHERE ea.project_id = a.id
        AND ea.longitude IS NOT NULL
        AND ea.latitude IS NOT NULL
    )
      AND EXISTS (
        SELECT 1
        FROM project_endpoints eb
        WHERE eb.project_id = b.id
          AND eb.longitude IS NOT NULL
          AND eb.latitude IS NOT NULL
      )
  `).get() as { count: number };
  return row.count;
}
const dataset: Dataset = { ...latestDataset(), projects: loadProjects() };
if (new Set(dataset.projects.map(p => p.id)).size !== dataset.projects.length) throw new Error('Duplicate project IDs');
const dashboard: DashboardData = { ...dataset, opportunities: loadOpportunities(), candidateCount: loadCandidateCount() };
const publicDir = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const basemapPrefix = '/api/basemap/';
const tileHost = 'https://tiles.openfreemap.org/';
const allowedBasemapPaths = /^(?:styles\/(?:positron|dark)(?:\/style\.json)?|planet(?:\/[a-zA-Z0-9_]+\/[0-9]+\/[0-9]+\/[0-9]+\.pbf)?|natural_earth\/ne2sr\/[0-9]+\/[0-9]+\/[0-9]+\.png|sprites\/[a-zA-Z0-9_./@-]+\.(?:json|png)|fonts\/[a-zA-Z0-9%+_., -]+\/[0-9]+-[0-9]+\.pbf)$/;
type StyleDocument = { layers: Array<{ id: string; type: string; minzoom?: number; maxzoom?: number; filter?: unknown; paint?: Record<string, unknown>; layout?: Record<string, unknown>; ['source-layer']?: string }> };
function expressionFilter(filter: unknown): unknown {
  if (!Array.isArray(filter) || typeof filter[0] !== 'string') return filter;
  const [operator, ...args] = filter;
  if (operator === 'all' || operator === 'any') return [operator, ...args.map(expressionFilter)];
  if (operator === 'none') return ['!', ['any', ...args.map(expressionFilter)]];
  if ((operator === 'has' || operator === '!has') && typeof args[0] === 'string') {
    const exists = ['has', args[0]];
    return operator === '!has' ? ['!', exists] : exists;
  }
  if (['==', '!=', '>', '>=', '<', '<='].includes(operator) && typeof args[0] === 'string' && args.length === 2) {
    return [operator, ['get', args[0]], args[1]];
  }
  if ((operator === 'in' || operator === '!in') && typeof args[0] === 'string' && args.length > 1) {
    const membership = ['in', ['get', args[0]], ['literal', args.slice(1)]];
    return operator === '!in' ? ['!', membership] : membership;
  }
  return filter;
}
function fallbackMapStyle(theme: 'light' | 'dark') {
  return {
    version: 8,
    name: `Gridlock ${theme} offline`,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#101827' : '#eef2f6' },
      },
    ],
  };
}
function improveMapStyle(style: StyleDocument, theme: 'light' | 'dark') {
  const roads: Record<string, string> = {
    highway_path: '#293b52', highway_minor: '#31445d',
    highway_major_casing: '#26374c', highway_major_inner: '#40536b', highway_major_subtle: '#33465e',
    highway_motorway_casing: '#26374c', highway_motorway_inner: '#4b6079', highway_motorway_subtle: '#3a4e68',
    road_pier: '#364a62',
  };
  const boundaryColor = theme === 'dark' ? '#f2f6ff' : '#2f4057';
  for (const layer of style.layers) {
    if (theme === 'dark') {
      if (layer.id === 'background') layer.paint = { ...layer.paint, 'background-color': '#101827' };
      if (roads[layer.id]) layer.paint = { ...layer.paint, 'line-color': roads[layer.id] };
      if (layer.type === 'symbol' && layer.paint?.['text-color'] && !layer.id.startsWith('road_oneway')) {
        layer.paint = { ...layer.paint, 'text-color': '#9aaac0', 'text-halo-color': '#101827' };
      }
    }
    const boundaryKey = `${layer.id} ${layer['source-layer'] ?? ''}`.toLowerCase();
    if (layer.type === 'line' && (boundaryKey.includes('boundary') || boundaryKey.includes('admin'))) {
      layer.minzoom = 0;
      const isCountryBoundary = layer.id === 'boundary_2' || layer.id.toLowerCase().includes('country border');
      layer.layout = { ...layer.layout, visibility: isCountryBoundary ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' };
      const paint = { ...layer.paint };
      layer.paint = { ...paint, 'line-color': boundaryColor, 'line-dasharray': [3, 2], 'line-opacity': theme === 'dark' ? .82 : .72, 'line-blur': 0, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, .9, 4, 1.1, 7, 1.45, 10, 2] };
    }
    if (layer.type === 'symbol' && layer['source-layer'] === 'place') {
      layer.filter = ['all', expressionFilter(layer.filter ?? true), ['any', ['==', ['get', 'iso_a2'], 'US'], ['within', usStateBoundaries]], ['!=', ['get', 'class'], 'state'], ['!=', ['get', 'class'], 'country']];
      const labelId = layer.id.toLowerCase();
      if (labelId.includes('country')) {
        layer.minzoom = 0;
        layer.maxzoom = Math.min(layer.maxzoom ?? 24, 4.5);
      } else if (labelId.includes('state')) {
        layer.minzoom = Math.max(layer.minzoom ?? 0, 2);
        layer.maxzoom = Math.min(layer.maxzoom ?? 24, 8);
      } else if (labelId.includes('city') || labelId.includes('place') || labelId.includes('town') || labelId.includes('village')) {
        layer.minzoom = Math.max(layer.minzoom ?? 0, 9.5);
      }
    }
  }
  return style;
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
  if (path.startsWith(basemapPrefix)) {
    const resource = path.slice(basemapPrefix.length);
    if (!allowedBasemapPaths.test(resource) || resource.includes('..')) { res.writeHead(404); res.end('Unknown basemap resource'); return; }
    const fallbackTheme = resource.startsWith('styles/dark') ? 'dark' : resource.startsWith('styles/positron') ? 'light' : null;
    try {
      const upstream = await fetch(tileHost + resource, { signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) {
        if (fallbackTheme) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(fallbackMapStyle(fallbackTheme)));
          return;
        }
        res.writeHead(upstream.status); res.end('Basemap provider unavailable'); return;
      }
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
      const isJson = contentType.includes('json') || resource.endsWith('.json') || resource.startsWith('styles/') || resource === 'planet';
      let content: Buffer;
      if (isJson) {
        const rewritten = (await upstream.text()).replaceAll(tileHost, basemapPrefix);
        content = Buffer.from(fallbackTheme ? JSON.stringify(improveMapStyle(JSON.parse(rewritten), fallbackTheme)) : rewritten);
      } else content = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': isJson ? 'public, max-age=3600' : 'public, max-age=86400' });
      res.end(content);
    } catch {
      if (fallbackTheme) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(fallbackMapStyle(fallbackTheme)));
        return;
      }
      res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Basemap provider unavailable');
    }
    return;
  }
  const payload = path === '/api/dashboard' ? dashboard : path === '/api/projects' ? dataset.projects : path === '/api/opportunities' ? dashboard.opportunities : path === '/api/health' ? { status: 'ok' } : null;
  if (payload) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); return; }
  if (path.startsWith('/api/')) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const file = resolve(publicDir, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
    if (!file.startsWith(publicDir.endsWith(sep) ? publicDir : publicDir + sep)) { res.writeHead(403); res.end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(content);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found. For development, open http://localhost:5173.'); }
});
server.listen(Number(process.env.PORT || 3001), '0.0.0.0', () => console.log('Gridlock API: http://127.0.0.1:' + (process.env.PORT || 3001)));
