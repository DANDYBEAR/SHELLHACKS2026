import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MapInstance } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Expand, Layers, LocateFixed, RotateCcw } from 'lucide-react';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import { center, EARTH_RADIUS_MI } from '../../../shared/analysis';
import type { Coordinate, Opportunity, Project, Utility } from '../../../shared/types';

export type MapHandle = { fitAll(): void; fitPair(): void; fitProjects(ids: string[]): void; focusProject(id: string): void };
type Props = { projects: Project[]; pair: Opportunity | null; projectId: string | null; selectedUtility: Utility | null; theme: 'light' | 'dark'; onProject(id: string): void };
const styles = { light: import.meta.env.VITE_MAP_LIGHT_STYLE || '/api/basemap/styles/positron', dark: import.meta.env.VITE_MAP_DARK_STYLE || '/api/basemap/styles/dark' };
maplibregl.setWorkerUrl(workerUrl);
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
function radiusFeature(point: Coordinate): Feature {
  const [lon, lat] = point.map(n => n * Math.PI / 180), d = 25 / EARTH_RADIUS_MI;
  const coordinates: Coordinate[] = [];
  for (let n = 0; n <= 96; n++) {
    const bearing = n / 96 * 2 * Math.PI;
    const latitude = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(bearing));
    const longitude = lon + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(latitude));
    coordinates.push([longitude * 180 / Math.PI, latitude * 180 / Math.PI]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}
export default forwardRef<MapHandle, Props>(function ProjectMap(props, ref) {
  const host = useRef<HTMLDivElement>(null), map = useRef<MapInstance | null>(null);
  const latest = useRef(props); latest.current = props;
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false), [radius, setRadius] = useState(false), [guides, setGuides] = useState(true);
  const settings = useRef({ radius, guides }); settings.current = { radius, guides };
  const fit = (projects: Project[], maxZoom = 12) => {
    const coords = projects.map(center).filter((p): p is Coordinate => p !== null);
    if (!coords.length || !map.current) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.current.fitBounds(bounds, { padding: { top: 110, bottom: 85, left: 65, right: 65 }, maxZoom, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 800 });
  };
  useImperativeHandle(ref, () => ({
    fitAll: () => fit(latest.current.projects, 9),
    fitPair: () => { const p = latest.current.pair; if (p) fit(latest.current.projects.filter(x => x.id === p.projectA || x.id === p.projectB)); },
    fitProjects: ids => fit(latest.current.projects.filter(p => ids.includes(p.id)), 9),
    focusProject: id => { const p = latest.current.projects.find(p => p.id === id); const c = p && center(p); if (c) map.current?.flyTo({ center: c, zoom: 14, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1000 }); },
  }));
  const update = () => {
    const m = map.current; if (!m || !m.getSource('gridlock')) return;
    const { projects, pair, projectId, selectedUtility } = latest.current;
    const selected = pair ? [pair.projectA, pair.projectB] : projectId ? [projectId] : [];
    const features: Feature<Geometry>[] = [];
    const selectedProjects = projects.filter(p => selected.includes(p.id));
    for (const p of selectedProjects) {
      const coordinates = p.endpoints.map(e => e.coordinates).filter((c): c is Coordinate => c !== null);
      if (settings.current.guides) {
        if (coordinates.length === 2) features.push({ type: 'Feature', properties: { kind: 'guide', utility: p.utility }, geometry: { type: 'LineString', coordinates } });
        coordinates.forEach(c => features.push({ type: 'Feature', properties: { kind: 'endpoint', utility: p.utility }, geometry: { type: 'Point', coordinates: c } }));
      }
    }
    for (const p of projects) {
      const c = center(p); if (!c) continue;
      features.push({
        type: 'Feature',
        properties: {
          kind: 'project',
          id: p.id,
          utility: p.utility,
          selected: selected.includes(p.id),
          utilityMatch: selectedUtility === p.utility,
          dimmed: selected.length > 0 ? !selected.includes(p.id) : selectedUtility !== null && selectedUtility !== p.utility,
        },
        geometry: { type: 'Point', coordinates: c },
      });
    }
    if (pair && selectedProjects.length === 2) {
      const a = center(selectedProjects[0])!, b = center(selectedProjects[1])!;
      features.push({ type: 'Feature', properties: { kind: 'connector' }, geometry: { type: 'LineString', coordinates: [a, b] } });
      features.push({
        type: 'Feature',
        properties: { kind: 'distance', label: `${pair.distanceMi.toFixed(2)} mi` },
        geometry: { type: 'Point', coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] },
      });
    }
    (m.getSource('gridlock') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    const firstCenter = selectedProjects[0] && center(selectedProjects[0]);
    (m.getSource('radius') as GeoJSONSource).setData(settings.current.radius && firstCenter ? { type: 'FeatureCollection', features: [radiusFeature(firstCenter)] } : empty);
  };
  useEffect(() => {
    if (!host.current) return;
    let m: MapInstance;
    try { m = new maplibregl.Map({ container: host.current, style: styles[latest.current.theme], center: [-81.7, 32.5], zoom: 6.6, maxZoom: 19, minZoom: 3, attributionControl: { compact: true } }); }
    catch { setError(true); return; }
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    m.on('style.load', () => {
      m.addSource('radius', { type: 'geojson', data: empty });
      m.addLayer({ id: 'search-radius', type: 'fill', source: 'radius', paint: { 'fill-color': '#5585ff', 'fill-opacity': .07 } });
      m.addLayer({ id: 'radius-edge', type: 'line', source: 'radius', paint: { 'line-color': '#7299fa', 'line-width': 1, 'line-dasharray': [4, 4] } });
      m.addSource('gridlock', { type: 'geojson', data: empty });
      m.addLayer({ id: 'endpoint-guides', type: 'line', source: 'gridlock', filter: ['==', 'kind', 'guide'], paint: { 'line-color': ['match', ['get', 'utility'], 'DESC', '#5388ff', '#f5a354'], 'line-width': 2, 'line-dasharray': [2, 3], 'line-opacity': .7 } });
      m.addLayer({ id: 'pair-connector', type: 'line', source: 'gridlock', filter: ['==', 'kind', 'connector'], paint: { 'line-color': '#a48aff', 'line-width': 3 } });
      m.addLayer({ id: 'endpoint-points', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'endpoint'], paint: { 'circle-color': ['match', ['get', 'utility'], 'DESC', '#5388ff', '#f5a354'], 'circle-radius': 4, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } });
      m.addLayer({ id: 'project-halo', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'project'], paint: { 'circle-color': ['match', ['get', 'utility'], 'DESC', '#5486ff', '#ee9649'], 'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 14, ['boolean', ['get', 'utilityMatch'], false], 12, 10], 'circle-opacity': ['case', ['boolean', ['get', 'dimmed'], false], .08, .18] } });
      m.addLayer({ id: 'project-points', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'project'], paint: { 'circle-color': ['match', ['get', 'utility'], 'DESC', '#5486ff', '#ee9649'], 'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 8, ['boolean', ['get', 'utilityMatch'], false], 7, 5], 'circle-opacity': ['case', ['boolean', ['get', 'dimmed'], false], .26, 1], 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } });
      m.addLayer({ id: 'project-hit-area', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'project'], paint: { 'circle-color': '#000000', 'circle-radius': 16, 'circle-opacity': 0 } });
      m.addLayer({ id: 'project-labels', type: 'symbol', source: 'gridlock', filter: ['all', ['==', 'kind', 'project'], ['==', ['get', 'selected'], true]], layout: { 'text-field': ['get', 'id'], 'text-size': 10, 'text-offset': [0, 1.9], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#243044', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
      m.addLayer({ id: 'distance-labels', type: 'symbol', source: 'gridlock', filter: ['==', 'kind', 'distance'], layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true }, paint: { 'text-color': '#243044', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
      m.on('click', 'project-hit-area', e => {
        const id = e.features?.[0]?.properties?.id;
        if (typeof id === 'string') latest.current.onProject(id);
      });
      m.on('mouseenter', 'project-hit-area', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'project-hit-area', () => { m.getCanvas().style.cursor = ''; });
      setReady(true); setError(false); update();
    });
    m.on('load', () => fit(latest.current.projects, 9));
    m.on('error', () => { if (map.current === m) setError(true); });
    m.on('idle', () => { if (map.current === m && m.areTilesLoaded()) setError(false); });
    const observer = new ResizeObserver(() => m.resize()); observer.observe(host.current);
    const timer = window.setTimeout(() => { if (!m.isStyleLoaded()) setError(true); }, 15000);
    return () => { clearTimeout(timer); observer.disconnect(); m.remove(); map.current = null; };
  }, []);
  const previousTheme = useRef(props.theme);
  useEffect(() => { if (previousTheme.current !== props.theme && map.current) { previousTheme.current = props.theme; setReady(false); map.current.setStyle(styles[props.theme]); } }, [props.theme]);
  useEffect(() => { update(); }, [props.projects, props.pair, props.projectId, props.selectedUtility, ready, radius, guides]);
  useEffect(() => { if (props.pair) fit(props.projects.filter(p => p.id === props.pair!.projectA || p.id === props.pair!.projectB)); }, [props.pair?.id]);
  return <div className="map-shell">
    <div ref={host} className="map-canvas" role="region" aria-label="Interactive map of transmission project centers" />
    <div className="map-heading"><span className="eyebrow">PROJECT EXPLORER</span><h2>Georgia & South Carolina</h2><span className="map-subtitle">{props.pair ? 'Selected coordination opportunity' : '10 project centers · 2 utilities'}</span></div>
    <div className="map-tools">
      <button className="map-button" title="Fit all projects" aria-label="Fit all projects" onClick={() => fit(props.projects, 9)}><Expand size={17}/></button>
      {props.pair && <button className="map-button" title="Fit selected pair" aria-label="Fit selected pair" onClick={() => fit(props.projects.filter(p => p.id === props.pair!.projectA || p.id === props.pair!.projectB))}><LocateFixed size={17}/></button>}
      <button className={`map-button ${layersOpen ? 'active' : ''}`} title="Map layers" aria-label="Map layers" aria-expanded={layersOpen} onClick={() => setLayersOpen(!layersOpen)}><Layers size={17}/></button>
    </div>
    {layersOpen && <div className="layers-popover"><strong>Map layers</strong><label><input type="checkbox" checked={guides} onChange={e => setGuides(e.target.checked)}/> Selected endpoints & guides</label><label><input type="checkbox" checked={radius} onChange={e => setRadius(e.target.checked)}/> 25 mi search radius</label><p>Radius uses the first selected project center. Dashed guides are not verified routes.</p></div>}
    {!ready && !error && <div className="map-notice"><span className="spinner"/> Loading basemap</div>}
    {error && <div className="map-notice" role="status">Basemap unavailable. Project results are still accessible.<button className="text-button" onClick={() => { setError(false); map.current?.setStyle(styles[props.theme], { diff: false }); }}><RotateCcw size={14}/> Retry map</button></div>}
    <div className="map-legend"><span><i className="utility-dot desc"/> Dominion</span><span><i className="utility-dot gpc"/> Georgia Power</span>{props.pair && <span><i className="connector-key"/> Center distance</span>}</div>
    <div className="map-method">Center locations · Routes unverified</div>
  </div>;
});
