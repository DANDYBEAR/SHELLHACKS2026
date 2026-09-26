import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { z } from 'zod';
import { calculateOpportunities, candidateCount } from '../../shared/analysis';
const coordinate = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s);
const endpoint = z.object({ name: z.string(), coordinates: coordinate });
const project = z.object({
  id: z.string(), utility: z.enum(['DESC', 'GPC']), state: z.string(), name: z.string(), shortName: z.string(),
  endpoints: z.tuple([endpoint, endpoint]), inServiceDate: date.nullable(), rawDate: z.string(), sourceRow: z.number(),
  sourceProjectId: z.string().nullable(), document: z.string().nullable(), documentPage: z.number().nullable(), notes: z.array(z.string()),
});
const schema = z.object({ name: z.string(), source: z.string(), referenceDate: date, projects: z.array(project) });
const dataset = schema.parse(JSON.parse(await readFile(new URL('../../db/data/projects.json', import.meta.url), 'utf8')));
if (new Set(dataset.projects.map(p => p.id)).size !== dataset.projects.length) throw new Error('Duplicate project IDs');
const dashboard = { ...dataset, opportunities: calculateOpportunities(dataset.projects), candidateCount: candidateCount(dataset.projects) };
const publicDir = fileURLToPath(new URL('../../frontend/dist/', import.meta.url));
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const basemapPrefix = '/api/basemap/';
const tileHost = 'https://tiles.openfreemap.org/';
const allowedBasemapPaths = /^(?:styles\/(?:positron|dark)(?:\/style\.json)?|planet(?:\/[a-zA-Z0-9_]+\/[0-9]+\/[0-9]+\/[0-9]+\.pbf)?|natural_earth\/ne2sr\/[0-9]+\/[0-9]+\/[0-9]+\.png|sprites\/[a-zA-Z0-9_./@-]+\.(?:json|png)|fonts\/[a-zA-Z0-9%+_., -]+\/[0-9]+-[0-9]+\.pbf)$/;
type StyleDocument = { layers: Array<{ id: string; type: string; minzoom?: number; maxzoom?: number; filter?: unknown; paint?: Record<string, unknown>; layout?: Record<string, unknown>; ['source-layer']?: string }> };
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
      const isCountryBoundary = layer.id === 'boundary_2';
      layer.layout = { ...layer.layout, visibility: isCountryBoundary ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' };
      const paint = { ...layer.paint };
      delete paint['line-dasharray'];
      layer.paint = { ...paint, 'line-color': boundaryColor, 'line-opacity': theme === 'dark' ? .82 : .72, 'line-blur': 0, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, .9, 4, 1.1, 7, 1.45, 10, 2] };
    }
    if (layer.type === 'symbol' && layer['source-layer'] === 'place' && layer.id === 'label_state') layer.layout = { ...layer.layout, visibility: 'none' };
    if (layer.type === 'symbol' && layer['source-layer'] === 'place' && layer.id.startsWith('label_city')) layer.minzoom = Math.max(layer.minzoom ?? 0, 5.5);
    if (layer.type === 'symbol' && layer['source-layer'] === 'place' && layer.id.startsWith('label_country_')) {
      layer.filter = ['all', layer.filter ?? true, ['==', ['coalesce', ['get', 'name_en'], ['get', 'name']], 'United States']];
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
    try {
      const upstream = await fetch(tileHost + resource, { signal: AbortSignal.timeout(15000) });
      if (!upstream.ok) { res.writeHead(upstream.status); res.end('Basemap provider unavailable'); return; }
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
      const isJson = contentType.includes('json') || resource.endsWith('.json') || resource.startsWith('styles/') || resource === 'planet';
      let content: Buffer;
      if (isJson) {
        const rewritten = (await upstream.text()).replaceAll(tileHost, basemapPrefix);
        const theme = resource.startsWith('styles/dark') ? 'dark' : resource.startsWith('styles/positron') ? 'light' : null;
        content = Buffer.from(theme ? JSON.stringify(improveMapStyle(JSON.parse(rewritten), theme)) : rewritten);
      } else content = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': isJson ? 'public, max-age=3600' : 'public, max-age=86400' });
      res.end(content);
    } catch { res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Basemap provider unavailable'); }
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
server.listen(Number(process.env.PORT || 3001), '127.0.0.1', () => console.log('Gridlock API: http://127.0.0.1:' + (process.env.PORT || 3001)));
