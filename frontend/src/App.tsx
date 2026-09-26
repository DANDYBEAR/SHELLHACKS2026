import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownWideNarrow, ArrowRight, CalendarDays, Check, ChevronDown, CircleHelp, Grid2X2, MapPin, Monitor, Moon, Search, SlidersHorizontal, Sun, X } from 'lucide-react';
import { center, rankOpportunities } from '../../shared/analysis';
import { TIERS, type DashboardData, type Opportunity } from '../../shared/types';
import ProjectMap, { type MapHandle } from './components/ProjectMap';
import Details from './components/Details';
import { formatDate } from './components/Timeline';
type Theme = 'system' | 'light' | 'dark';
function savedTheme(): Theme { try { const v = localStorage.getItem('gridlock-theme'); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; } }
export default function App() {
  const [data, setData] = useState<DashboardData | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const [theme, setTheme] = useState<Theme>(savedTheme), [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const [query, setQuery] = useState(''), [tier, setTier] = useState(0), [sort, setSort] = useState('coordination');
  const [maxGap, setMaxGap] = useState('any'), [future, setFuture] = useState(false), [completeOnly, setCompleteOnly] = useState(false), [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null), [projectId, setProjectId] = useState<string | null>(null), [notice, setNotice] = useState('');
  const map = useRef<MapHandle>(null);
  const resolvedTheme = theme === 'system' ? systemDark ? 'dark' : 'light' : theme;
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemDark(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  useEffect(() => { document.documentElement.dataset.theme = resolvedTheme; try { localStorage.setItem('gridlock-theme', theme); } catch {} }, [theme, resolvedTheme]);
  useEffect(() => {
    const controller = new AbortController(); setError(false);
    const timer = setTimeout(() => controller.abort(), 10000);
    fetch('/api/dashboard', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setData).catch(() => { if (!controller.signal.aborted) setError(true); else if (!data) setError(true); }).finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [retry]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  const projects = data?.projects ?? [];
  const byId = useMemo(() => new Map(projects.map(p => [p.id, p])), [data]);
  const visible = useMemo(() => rankOpportunities((data?.opportunities ?? []).filter(pair => {
    const a = byId.get(pair.projectA)!, b = byId.get(pair.projectB)!;
    if (tier && pair.tier !== tier) return false;
    if (query && !`${a.name} ${a.id} ${b.name} ${b.id}`.toLowerCase().includes(query.toLowerCase().trim())) return false;
    if (maxGap !== 'any' && (pair.timeGapDays === null || pair.timeGapDays > Number(maxGap))) return false;
    if (future && (!a.inServiceDate || !b.inServiceDate || a.inServiceDate < data!.referenceDate || b.inServiceDate < data!.referenceDate)) return false;
    if (completeOnly && [a, b].some(p => p.endpoints.some(e => e.coordinates === null))) return false;
    return true;
  }), sort), [data, byId, query, tier, maxGap, future, completeOnly, sort]);
  const pair = visible.find(p => p.id === selected) ?? null;
  useEffect(() => { if (selected && !visible.some(p => p.id === selected)) setSelected(null); }, [visible, selected]);
  const selectedProjects = pair ? projects.filter(p => p.id === pair.projectA || p.id === pair.projectB) : [];
  const selectPair = (p: Opportunity) => { setSelected(p.id); setProjectId(null); };
  const selectProject = (id: string) => { const related = visible.find(p => p.projectA === id || p.projectB === id); if (related) selectPair(related); else { setProjectId(id); setSelected(null); } };
  const reset = () => { setQuery(''); setTier(0); setMaxGap('any'); setFuture(false); setCompleteOnly(false); };
  const filterCount = Number(maxGap !== 'any') + Number(future) + Number(completeOnly);
  const exportPair = () => {
    if (!pair || !data) return;
    const output = { dataset: data.name, referenceDate: data.referenceDate, source: data.source, method: 'Haversine center-to-center; arithmetic endpoint midpoint or single located endpoint', eligibility: 'distance < 25 miles', ranking: 'tier, date gap, exact distance, ID', opportunity: pair, scenario: TIERS[pair.tier - 1], projects: selectedProjects.map(p => ({ ...p, center: center(p) })), limitations: 'Workbook coordinates not independently verified. In-service date gap is not a confirmed construction-window overlap.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `gridlock-${pair.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('Pair summary exported');
  };
  return <>
    <div className="app-shell"><header className="app-header"><a className="brand" href="/" aria-label="Gridlock home"><span className="brand-mark"><Grid2X2 size={22}/></span><span>gridlock<span className="brand-period">.</span></span></a><div className="theme-control" aria-label="Color theme">{([{ value: 'light', Icon: Sun, label: 'Light theme' }, { value: 'dark', Icon: Moon, label: 'Dark theme' }, { value: 'system', Icon: Monitor, label: 'System theme' }] as const).map(({ value, Icon, label }) => <button key={value} title={label} aria-label={label} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon size={16}/></button>)}</div></header>
    <div className="top-search-bar"><label className="search-box global-search"><Search size={17}/><input aria-label="Search projects" placeholder="Search projects or locations" value={query} onChange={e => setQuery(e.target.value)}/>{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={14}/></button>}</label></div>
    {!data ? <main className="loading-screen">{error ? <><h2>Couldn’t load the project data</h2><p>Check that the local API is running, then try again.</p><button className="primary-button" onClick={() => { setError(false); setRetry(retry + 1); }}>Retry loading</button></> : <><span className="spinner"/><h2>Opening your workspace</h2><p>Loading the supplied planning snapshot.</p></>}</main> : <main className="workspace">
      <aside className="opportunities-panel"><div className="opportunity-heading"><div><span className="eyebrow">DISCOVER & COMPARE</span><h1>Opportunities <span>{data.opportunities.length}</span></h1></div><button className={`icon-button filter-toggle ${filtersOpen ? 'active' : ''}`} aria-label="Opportunity filters" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={18}/>{filterCount > 0 && <i>{filterCount}</i>}</button></div>
      <div className="tier-filters" aria-label="Distance tier"><button aria-pressed={tier === 0} onClick={() => setTier(0)}>All <span>{data.opportunities.length}</span></button>{TIERS.map(t => <button key={t.id} aria-pressed={tier === t.id} title={`${t.name}: ${t.range}`} onClick={() => setTier(t.id)}>{t.name}<span>{data.opportunities.filter(p => p.tier === t.id).length}</span></button>)}</div>
      {filtersOpen && <section className="filters-panel"><div><strong>Refine opportunities</strong><button className="text-button" onClick={reset}>Reset</button></div><label>Maximum date gap<select value={maxGap} onChange={e => setMaxGap(e.target.value)}><option value="any">Any date gap</option><option value="180">180 days</option><option value="365">1 year (365 days)</option><option value="730">2 years (730 days)</option></select></label><label className="check-label"><input type="checkbox" checked={completeOnly} onChange={e => setCompleteOnly(e.target.checked)}/> Both projects have two endpoints</label><label className="check-label"><input type="checkbox" checked={future} onChange={e => setFuture(e.target.checked)}/> Future planned dates only</label><p>Both dates must be on or after {formatDate(data.referenceDate)}.</p></section>}
      <div className="sort-row"><span aria-live="polite">{visible.length} of {data.opportunities.length} matches</span><label><ArrowDownWideNarrow size={14}/><select aria-label="Sort opportunities" value={sort} onChange={e => setSort(e.target.value)}><option value="coordination">Tier + timing</option><option value="nearest">Nearest first</option><option value="timing">Closest dates</option></select><ChevronDown size={12}/></label></div>
      <div className="opportunity-list">{visible.map((p, i) => { const a = byId.get(p.projectA)!, b = byId.get(p.projectB)!; return <button key={p.id} className={`opportunity-card ${selected === p.id ? 'is-selected' : ''}`} aria-pressed={selected === p.id} onClick={() => selectPair(p)}><div className="card-top"><span className="rank-number">{String(i + 1).padStart(2, '0')}</span><span className={`tier-badge tier-${p.tier}`}>{TIERS[p.tier - 1].name}</span><ArrowRight className="card-arrow" size={15}/></div><div className="pair-name"><i className="utility-dot desc"/><strong>{a.shortName}</strong></div><div className="pair-name"><i className="utility-dot gpc"/><strong>{b.shortName}</strong></div><div className="card-metrics"><span><MapPin size={13}/><b>{p.distanceMi.toFixed(2)} mi</b></span><span><CalendarDays size={13}/>{p.timeGapDays?.toLocaleString() ?? 'Unknown'}{p.timeGapDays !== null ? ' days apart' : ''}</span></div><div className="card-footer">{TIERS[p.tier - 1].scenario}<span>{[a, b].every(x => x.endpoints.every(e => e.coordinates)) ? '2 endpoints each' : 'Partial locations'}</span></div></button>; })}{!visible.length && <div className="empty-results"><Search size={28}/><h3>No matching opportunities</h3><p>{future ? 'All Dominion sample dates precede the reference date. Try the full planning snapshot.' : tier === 1 ? 'The supplied sample has no pairs under 1 mile. Try Local or Regional.' : 'Try a different search or broaden your filters.'}</p><button className="secondary-button" onClick={reset}>Clear filters</button></div>}</div>
      <div className="list-footnote"><CircleHelp size={15}/><span>Ranked by tier, then date gap.<br/>Only pairs under 25 mi qualify.</span></div></aside>
      <section className="map-column"><ProjectMap ref={map} projects={projects} pair={pair} projectId={projectId} theme={resolvedTheme} onProject={selectProject}/><div className="map-status"><span>{projects.length} projects · {data.candidateCount} cross-utility comparisons</span><span>Source: {data.source}</span></div></section>
      <Details pair={pair} projects={projects} inspected={projects.find(p => p.id === projectId) ?? null} onClose={() => { setSelected(null); setProjectId(null); }} onZoom={id => map.current?.focusProject(id)} onExport={exportPair} onPrint={() => window.print()}/>
    </main>}
    {notice && <div className="toast" role="status"><Check size={17}/>{notice}</div>}
    </div>
    {pair && data && <article className="print-summary"><h1>Gridlock · Pair summary</h1><p>{data.name} · Reference date: {data.referenceDate}</p><h2>{TIERS[pair.tier - 1].name} coordination candidate</h2><p>Center distance: {pair.distanceMi.toFixed(2)} miles · Date gap: {pair.timeGapDays ?? 'Unknown'} days</p><p>{TIERS[pair.tier - 1].description}</p>{selectedProjects.map(p => <section key={p.id}><h3>{p.id} · {p.name}</h3><p>Planned in-service: {formatDate(p.inServiceDate)} · Raw source date: {p.rawDate}</p><p>Center [longitude, latitude]: {center(p)?.join(', ')} · Method: {p.endpoints.filter(e => e.coordinates).length === 2 ? 'arithmetic midpoint' : 'single located endpoint'}</p><p>Source: {data.source}, projects, row {p.sourceRow}{p.document ? `; ${p.document}, PDF page ${p.documentPage}, source ID ${p.sourceProjectId}` : ''}</p><ul>{p.notes.map(n => <li key={n}>{n}</li>)}</ul></section>)}<p>Distance method: Haversine between representative centers. Threshold: strictly under 25 miles. Tiers: under 1; 1 to under 5; 5 to under 25 miles. Date gap does not establish overlapping construction. Potential resource sharing requires verification.</p></article>}
  </>;
}
