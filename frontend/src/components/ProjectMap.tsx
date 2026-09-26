import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, Map as MapInstance } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Expand, Layers, LocateFixed, RotateCcw } from 'lucide-react';
import type { FeatureCollection, Feature, Geometry } from 'geojson';
import usStates from '../data/us-states.json';
import { center, distanceMiles, EARTH_RADIUS_MI, MAX_COMPARISON_DISTANCE_MI } from '../../../shared/analysis';
import { UTILITY_COLORS, utilityColor, utilityName, type Coordinate, type Opportunity, type Project, type Utility } from '../../../shared/types';

export type DraftMapProject = { id: string; title: string; coordinates: Coordinate };
export type MapHandle = { fitAll(): void; fitPair(): void; fitProjects(ids: string[]): void; focusProject(id: string): void; focusCoordinate(coordinates: Coordinate): void; setDraftProjects(projects: DraftMapProject[]): void };
type ProjectCombination = { active: boolean; working: string[]; groups: string[][] };
type Props = { projects: Project[]; createdProjectIds: string[]; pair: Opportunity | null; projectId: string | null; selectedProjectId: string | null; selectedCombinedProjectIds: string[] | null; selectedUtility: Utility | null; theme: 'light' | 'dark'; onProject(id: string): void; onCombinedProjects(ids: string[] | null): void; onGroupsChange(groups: string[][]): void };
const styles = { light: '/api/basemap/styles/positron', dark: '/api/basemap/styles/dark' };
const styleUrl = (theme: 'light' | 'dark') => `${styles[theme]}?v=${Date.now()}`;
const utilityColorExpression = ['match', ['get', 'utility'], ...Object.entries(UTILITY_COLORS).flat(), '#64748b'] as unknown as ExpressionSpecification;
const projectColorExpression = ['case', ['boolean', ['get', 'created'], false], '#d94f3d', utilityColorExpression] as unknown as ExpressionSpecification;
maplibregl.setWorkerUrl(workerUrl);
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const usStatesData = usStates as FeatureCollection;
function stateLabelPoint(ring: number[][]): { point: Coordinate; area: number } {
  let twiceArea = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cross = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    twiceArea += cross;
    x += (ring[j][0] + ring[i][0]) * cross;
    y += (ring[j][1] + ring[i][1]) * cross;
  }
  const area = Math.abs(twiceArea / 2);
  return Math.abs(twiceArea) < 1e-10
    ? { point: [ring[0][0], ring[0][1]], area }
    : { point: [x / (3 * twiceArea), y / (3 * twiceArea)], area };
}
const stateLabels: FeatureCollection = {
  type: 'FeatureCollection',
  features: usStatesData.features.flatMap(feature => {
    const geometry = feature.geometry;
    if (!geometry) return [];
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    const largest = polygons.map(polygon => stateLabelPoint(polygon[0] as number[][])).sort((a, b) => b.area - a.area)[0];
    return largest ? [{ type: 'Feature', properties: feature.properties, geometry: { type: 'Point', coordinates: largest.point } }] : [];
  }),
};
const countryLabel: FeatureCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name: 'United States' }, geometry: { type: 'Point', coordinates: [-98.5795, 39.8283] } }],
};
const usView = { center: [-98.5795, 39.8283] as Coordinate, zoom: 3.15 };
function radiusFeature(point: Coordinate): Feature {
  const [lon, lat] = point.map(n => n * Math.PI / 180), d = MAX_COMPARISON_DISTANCE_MI / EARTH_RADIUS_MI;
  const coordinates: Coordinate[] = [];
  for (let n = 0; n <= 96; n++) {
    const bearing = n / 96 * 2 * Math.PI;
    const latitude = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(bearing));
    const longitude = lon + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(latitude));
    coordinates.push([longitude * 180 / Math.PI, latitude * 180 / Math.PI]);
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [coordinates] } };
}
function expandConnection(groups: string[][], projectIds: string[]) {
  const connected = new Set(projectIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const group of groups) {
      if (!group.some(id => connected.has(id))) continue;
      for (const id of group) if (!connected.has(id)) { connected.add(id); expanded = true; }
    }
  }
  return [...connected];
}
function mergeConnection(groups: string[][], projectIds: string[]) {
  const connected = expandConnection(groups, projectIds);
  const members = new Set(connected);
  const separate = groups.filter(group => !group.some(id => members.has(id)));
  return connected.length > 1 ? [...separate, connected] : separate;
}
export default forwardRef<MapHandle, Props>(function ProjectMap(props, ref) {
  const host = useRef<HTMLDivElement>(null), map = useRef<MapInstance | null>(null);
  const draftProjects = useRef<DraftMapProject[]>([]);
  const projectClickHandler = useRef<(id: string) => void>(() => {});
  const latest = useRef(props); latest.current = props;
  const [ready, setReady] = useState(false), [error, setError] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false), [radius, setRadius] = useState(false), [guides, setGuides] = useState(true);
  const [combination, setCombination] = useState<ProjectCombination>({ active: false, working: [], groups: [] });
  const [combineMessage, setCombineMessage] = useState('');
  const combinationRef = useRef(combination); combinationRef.current = combination;
  const updateCombination = (next: ProjectCombination) => { combinationRef.current = next; setCombination(next); latest.current.onGroupsChange(next.groups); };
  const visibleUtilities = [...new Set(props.projects.map(p => p.utility))].sort((a, b) => utilityName(a).localeCompare(utilityName(b)));
  const locatedProjects = props.projects.filter(p => center(p)).length;
  const settings = useRef({ radius, guides }); settings.current = { radius, guides };
  const resetUsView = (duration = 800) => {
    map.current?.easeTo({ center: usView.center, zoom: usView.zoom, bearing: 0, pitch: 0, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration });
  };
  const fit = (projects: Project[], maxZoom = 12) => {
    const coords = projects.map(center).filter((p): p is Coordinate => p !== null);
    if (!coords.length || !map.current) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.current.fitBounds(bounds, { padding: { top: 110, bottom: 85, left: 65, right: 65 }, maxZoom, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 800 });
  };
  useImperativeHandle(ref, () => ({
    fitAll: () => resetUsView(),
    fitPair: () => { const p = latest.current.pair; if (p) fit(latest.current.projects.filter(x => x.id === p.projectA || x.id === p.projectB)); },
    fitProjects: ids => fit(latest.current.projects.filter(p => ids.includes(p.id)), 9),
    focusProject: id => { const p = latest.current.projects.find(p => p.id === id); const c = p && center(p); if (c) map.current?.flyTo({ center: c, zoom: 8.7, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1000 }); },
    focusCoordinate: coordinates => map.current?.flyTo({ center: coordinates, zoom: 8.7, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1000 }),
    setDraftProjects: projects => { draftProjects.current = projects; update(); },
  }));
  const selectMapProject = (id: string) => {
    const current = combinationRef.current;
    if (!current.active) latest.current.onProject(id);
    if (current.active) {
      if (current.working.includes(id)) return;
      if (!current.working.length) {
        const working = expandConnection(current.groups, [id]);
        updateCombination({ ...current, working });
        latest.current.onCombinedProjects(working.length > 1 ? working : null);
        setCombineMessage(working.length > 1 ? `${working.length} projects already linked. Add another or finish.` : 'Starting project selected. Choose another project within 25 miles.');
        return;
      }
      const startProject = latest.current.projects.find(project => project.id === current.working[0]);
      const nextProject = latest.current.projects.find(project => project.id === id);
      const startCenter = startProject && center(startProject), nextCenter = nextProject && center(nextProject);
      if (!startCenter || !nextCenter || distanceMiles(startCenter, nextCenter) > MAX_COMPARISON_DISTANCE_MI) {
        setCombineMessage('That project is outside the 25-mile starting radius.');
        return;
      }
      const working = expandConnection(current.groups, [...current.working, id]);
      updateCombination({ ...current, working });
      latest.current.onCombinedProjects(working);
      setCombineMessage(`${working.length} projects linked. Add another within 25 miles or finish.`);
      return;
    }
    latest.current.onCombinedProjects(current.groups.find(group => group.includes(id)) ?? null);
  };
  projectClickHandler.current = selectMapProject;
  const toggleCombination = () => {
    const current = combinationRef.current;
    if (!current.active) {
      updateCombination({ ...current, active: true, working: [] });
      setCombineMessage('Choose a starting project on the map.');
      return;
    }
    const groups = current.working.length > 1 ? mergeConnection(current.groups, current.working) : current.groups;
    updateCombination({ ...current, active: false, working: [], groups });
    setCombineMessage(current.working.length > 1 ? 'Project connection saved.' : 'Project linking cancelled.');
  };
  const selectedProjectIds = props.selectedCombinedProjectIds?.length ? props.selectedCombinedProjectIds : props.pair ? [props.pair.projectA, props.pair.projectB] : [props.projectId ?? props.selectedProjectId ?? ''];
  const uncombineTargetId = selectedProjectIds.find(id => combination.groups.some(group => group.includes(id)) || combination.working.includes(id)) ?? null;
  const uncombineSelectedProject = () => {
    if (!uncombineTargetId) return;
    const current = combinationRef.current;
    const sourceGroup = current.working.includes(uncombineTargetId) ? current.working : current.groups.find(group => group.includes(uncombineTargetId)) ?? [];
    const remainingMembers = sourceGroup.filter(id => id !== uncombineTargetId);
    const groups = current.groups.map(group => group.filter(id => id !== uncombineTargetId)).filter(group => group.length > 1);
    const working = current.working.filter(id => id !== uncombineTargetId);
    updateCombination({ ...current, groups, working });
    latest.current.onCombinedProjects(remainingMembers.length > 1 ? remainingMembers : null);
    setCombineMessage('Project removed from its connection.');
  };
  const update = () => {
    const m = map.current; if (!m || !m.getSource('gridlock')) return;
    const { projects, pair, projectId, selectedUtility } = latest.current;
    const selected = latest.current.selectedCombinedProjectIds?.length
      ? latest.current.selectedCombinedProjectIds
      : pair ? [pair.projectA, pair.projectB] : projectId ? [projectId] : [];
    const groups = combinationRef.current.active ? mergeConnection(combinationRef.current.groups, combinationRef.current.working) : combinationRef.current.groups;
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
          created: latest.current.createdProjectIds.includes(p.id),
          selected: selected.includes(p.id),
          utilityMatch: selectedUtility === p.utility,
          dimmed: selected.length > 0 ? !selected.includes(p.id) : selectedUtility !== null && selectedUtility !== p.utility,
        },
        geometry: { type: 'Point', coordinates: c },
      });
    }
    for (const group of groups) {
      if (!group.some(id => selected.includes(id))) continue;
      const coordinates = group.map(id => projects.find(project => project.id === id)).filter((project): project is Project => project !== undefined).map(center).filter((coordinate): coordinate is Coordinate => coordinate !== null);
      if (coordinates.length > 1) features.push({ type: 'Feature', properties: { kind: 'combined-link' }, geometry: { type: 'LineString', coordinates } });
    }
    for (const draft of draftProjects.current) {
      features.push({ type: 'Feature', properties: { kind: 'draft', id: draft.id, title: draft.title }, geometry: { type: 'Point', coordinates: draft.coordinates } });
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
    const combineStartId = combinationRef.current.active ? combinationRef.current.working[0] : null;
    const radiusProject = projects.find(p => p.id === (combineStartId ?? latest.current.selectedProjectId ?? projectId ?? (pair ? pair.projectA : null)));
    const radiusCenter = radiusProject ? center(radiusProject) : null;
    (m.getSource('radius') as GeoJSONSource).setData((settings.current.radius || combineStartId !== null) && radiusCenter ? { type: 'FeatureCollection', features: [radiusFeature(radiusCenter)] } : empty);
  };
  useEffect(() => {
    if (!host.current) return;
    let m: MapInstance;
    try { m = new maplibregl.Map({ container: host.current, style: styleUrl(latest.current.theme), center: usView.center, zoom: usView.zoom, maxZoom: 19, minZoom: 2.4, attributionControl: { compact: true } }); }
    catch { setError(true); return; }
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    m.on('style.load', () => {
      const stateBorderColor = latest.current.theme === 'dark' ? '#cbd5e1' : '#26384d';
      const stateBorderCasing = latest.current.theme === 'dark' ? '#0b111e' : '#ffffff';
      m.addSource('us-states', { type: 'geojson', data: usStatesData });
      m.addSource('us-state-label-points', { type: 'geojson', data: stateLabels });
      m.addSource('us-country-label-point', { type: 'geojson', data: countryLabel });
      m.addLayer({ id: 'us-state-border-casing', type: 'line', source: 'us-states', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': stateBorderCasing, 'line-dasharray': [3, 2], 'line-opacity': latest.current.theme === 'dark' ? .72 : .82, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 2.4, 4, 2.9, 7, 3.5, 10, 4.2] } });
      m.addLayer({ id: 'us-state-borders', type: 'line', source: 'us-states', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': stateBorderColor, 'line-dasharray': [3, 2], 'line-opacity': latest.current.theme === 'dark' ? .9 : .88, 'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.2, 4, 1.55, 7, 2, 10, 2.6] } });
      m.addLayer({ id: 'us-state-labels', type: 'symbol', source: 'us-state-label-points', minzoom: 2, maxzoom: 8, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 5, 13, 8, 16], 'text-allow-overlap': false, 'text-ignore-placement': false }, paint: { 'text-color': latest.current.theme === 'dark' ? '#e5edf8' : '#26384d', 'text-halo-color': latest.current.theme === 'dark' ? '#101827' : '#ffffff', 'text-halo-width': 1.5 } });
      m.addLayer({ id: 'us-country-label', type: 'symbol', source: 'us-country-label-point', minzoom: 0, maxzoom: 4.5, layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': ['interpolate', ['linear'], ['zoom'], 0, 11, 5, 17], 'text-max-width': 8, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': latest.current.theme === 'dark' ? '#e5edf8' : '#26384d', 'text-halo-color': latest.current.theme === 'dark' ? '#101827' : '#ffffff', 'text-halo-width': 2 } });
      m.addSource('radius', { type: 'geojson', data: empty });
      m.addLayer({ id: 'search-radius', type: 'fill', source: 'radius', paint: { 'fill-color': '#5585ff', 'fill-opacity': .07 } });
      m.addLayer({ id: 'radius-edge', type: 'line', source: 'radius', paint: { 'line-color': '#7299fa', 'line-width': 1, 'line-dasharray': [4, 4] } });
      m.addSource('gridlock', { type: 'geojson', data: empty });
      m.addLayer({ id: 'endpoint-guides', type: 'line', source: 'gridlock', filter: ['==', 'kind', 'guide'], paint: { 'line-color': utilityColorExpression, 'line-width': 2, 'line-dasharray': [2, 3], 'line-opacity': .7 } });
      m.addLayer({ id: 'combined-project-links', type: 'line', source: 'gridlock', filter: ['==', 'kind', 'combined-link'], paint: { 'line-color': '#a48aff', 'line-width': 3 } });
      m.addLayer({ id: 'pair-connector', type: 'line', source: 'gridlock', filter: ['==', 'kind', 'connector'], paint: { 'line-color': '#a48aff', 'line-width': 3 } });
      m.addLayer({ id: 'endpoint-points', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'endpoint'], paint: { 'circle-color': utilityColorExpression, 'circle-radius': 4, 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } });
      m.addLayer({ id: 'project-halo', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'project'], paint: { 'circle-color': projectColorExpression, 'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 14, ['boolean', ['get', 'utilityMatch'], false], 12, 10], 'circle-opacity': ['case', ['boolean', ['get', 'dimmed'], false], .08, .18] } });
      m.addLayer({ id: 'project-points', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'project'], paint: { 'circle-color': projectColorExpression, 'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 8, ['boolean', ['get', 'utilityMatch'], false], 7, 5], 'circle-opacity': ['case', ['boolean', ['get', 'dimmed'], false], .26, 1], 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } });
      m.addLayer({ id: 'draft-project-points', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'draft'], paint: { 'circle-color': '#d94f3d', 'circle-radius': 9, 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' } });
      m.addLayer({ id: 'draft-project-labels', type: 'symbol', source: 'gridlock', filter: ['==', 'kind', 'draft'], layout: { 'text-field': ['get', 'title'], 'text-size': 11, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#243044', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
      m.addLayer({ id: 'project-hit-area', type: 'circle', source: 'gridlock', filter: ['==', 'kind', 'project'], paint: { 'circle-color': '#000000', 'circle-radius': 16, 'circle-opacity': 0 } });
      m.addLayer({ id: 'project-labels', type: 'symbol', source: 'gridlock', filter: ['all', ['==', 'kind', 'project'], ['==', ['get', 'selected'], true]], layout: { 'text-field': ['get', 'id'], 'text-size': 10, 'text-offset': [0, 1.9], 'text-anchor': 'top', 'text-allow-overlap': true }, paint: { 'text-color': '#243044', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
      m.addLayer({ id: 'distance-labels', type: 'symbol', source: 'gridlock', filter: ['==', 'kind', 'distance'], layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, -1.8], 'text-anchor': 'bottom', 'text-allow-overlap': true }, paint: { 'text-color': '#243044', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });
      m.on('click', 'project-hit-area', e => {
        const id = e.features?.[0]?.properties?.id;
        if (typeof id === 'string') projectClickHandler.current(id);
      });
      m.on('mouseenter', 'project-hit-area', () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', 'project-hit-area', () => { m.getCanvas().style.cursor = ''; });
      setReady(true); setError(false); update();
    });
    m.on('load', () => resetUsView(0));
    m.on('error', () => { if (map.current === m) setError(true); });
    m.on('idle', () => { if (map.current === m && m.areTilesLoaded()) setError(false); });
    const observer = new ResizeObserver(() => m.resize()); observer.observe(host.current);
    const timer = window.setTimeout(() => { if (!m.isStyleLoaded()) setError(true); }, 15000);
    return () => { clearTimeout(timer); observer.disconnect(); m.remove(); map.current = null; };
  }, []);
  const previousTheme = useRef(props.theme);
  useEffect(() => { if (previousTheme.current !== props.theme && map.current) { previousTheme.current = props.theme; setReady(false); map.current.setStyle(styleUrl(props.theme)); } }, [props.theme]);
  useEffect(() => { update(); }, [props.projects, props.createdProjectIds, props.pair, props.projectId, props.selectedProjectId, props.selectedCombinedProjectIds, props.selectedUtility, ready, radius, guides, combination]);
  useEffect(() => { if (props.pair && !props.selectedProjectId) fit(props.projects.filter(p => p.id === props.pair!.projectA || p.id === props.pair!.projectB)); }, [props.pair?.id, props.selectedProjectId]);
  return <div className="map-shell">
    <div ref={host} className="map-canvas" role="region" aria-label="Interactive map of transmission project centers" />
    <div className="map-heading"><span className="eyebrow">PROJECT EXPLORER</span><h2>Carolinas, Georgia & South Carolina</h2><span className="map-subtitle">{props.pair ? 'Selected coordination opportunity' : `${locatedProjects} mapped centers · ${visibleUtilities.length} utilities`}</span></div>
    <div className="map-tools">
      <button className="map-button" title="Show full U.S." aria-label="Show full U.S." onClick={() => resetUsView()}><Expand size={17}/></button>
      {(props.pair || (props.selectedCombinedProjectIds?.length ?? 0) > 1) && <button className="map-button" title={props.pair ? 'Fit selected pair' : 'Fit combined projects'} aria-label={props.pair ? 'Fit selected pair' : 'Fit combined projects'} onClick={() => fit(props.projects.filter(p => props.pair ? p.id === props.pair.projectA || p.id === props.pair.projectB : props.selectedCombinedProjectIds?.includes(p.id) ?? false))}><LocateFixed size={17}/></button>}
      <button className={`map-button ${layersOpen ? 'active' : ''}`} title="Map layers" aria-label="Map layers" aria-expanded={layersOpen} onClick={() => setLayersOpen(!layersOpen)}><Layers size={17}/></button>
      <div className="combine-map-control">
        <button className={`map-button combine-project-button ${combination.active ? 'active' : ''}`} aria-label={combination.active ? 'Finish linking projects' : 'Combine Multiple Projects'} aria-pressed={combination.active} onClick={toggleCombination}><svg className="combine-chain-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span className="combine-project-tooltip" aria-hidden="true">{combination.active ? 'Finish Linking' : 'Combine Multiple Projects'}</span></button>
        {uncombineTargetId && <button className="map-button combine-project-button uncombine-project-button" aria-label="Uncombine Selected Projects" onClick={uncombineSelectedProject}><svg className="combine-chain-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 14.5a5 5 0 0 0 7.6.5l3-3a5 5 0 0 0-7.1-7.1L11.5 6.4"/><path d="M14.5 9.5a5 5 0 0 0-7.6-.5l-3 3a5 5 0 0 0 7.1 7.1l1.5-1.5"/><path d="m3 3 18 18"/></svg><span className="combine-project-tooltip" aria-hidden="true">Uncombine Selected Projects</span></button>}
      </div>
    </div>
    {combineMessage && <div className="combine-status" role="status"><span>{combineMessage}</span><button aria-label="Dismiss project linking message" onClick={() => setCombineMessage('')}>×</button></div>}
    {layersOpen && <div className="layers-popover"><strong>Map layers</strong><label><input type="checkbox" checked={guides} onChange={e => setGuides(e.target.checked)}/> Selected endpoints & guides</label><label><input type="checkbox" checked={radius} onChange={e => setRadius(e.target.checked)}/> 25 mi search radius</label><p>Radius draws 25 miles around each selected project center. Dashed guides are not verified routes.</p></div>}
    {!ready && !error && <div className="map-notice"><span className="spinner"/> Loading basemap</div>}
    {error && <div className="map-notice" role="status">Basemap unavailable. Project results are still accessible.<button className="text-button" onClick={() => { setError(false); map.current?.setStyle(styleUrl(props.theme), { diff: false }); }}><RotateCcw size={14}/> Retry map</button></div>}
    <div className="map-legend">{visibleUtilities.map(utility => <span key={utility}><i className="utility-dot" style={{ background: utilityColor(utility) }}/>{utilityName(utility)}</span>)}{props.pair && <span><i className="connector-key"/> Center distance</span>}</div>
    <div className="map-method">Center locations · Routes unverified</div>
  </div>;
});
