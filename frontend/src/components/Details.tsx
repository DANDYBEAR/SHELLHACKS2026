import { useState } from 'react';
import { ArrowUpRight, CalendarDays, CircleHelp, FileText, LocateFixed, MapPin, Route, Trash2, X } from 'lucide-react';
import { TIERS, utilityName, type Opportunity, type Project } from '../../../shared/types';
import { center, distanceMiles, tierForDistance } from '../../../shared/analysis';
import { formatDate } from './Timeline';
import { combinedDaysApart } from './CombinedOpportunityList';
export default function Details({ pair, projects, combinedProjects, inspected, canDeleteInspected, onClose, onZoom, onDeleteProject }: {
  pair: Opportunity | null; projects: Project[]; combinedProjects: Project[]; inspected: Project | null;
  canDeleteInspected: boolean; onClose(): void; onZoom(id: string): void; onDeleteProject(id: string): void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const shown = combinedProjects.length > 1 ? combinedProjects : pair ? projects.filter(p => p.id === pair.projectA || p.id === pair.projectB) : inspected ? [inspected] : [];
  const combinedStart = combinedProjects.length > 1 ? center(combinedProjects[0]) : null;
  const combinedDistances = combinedStart ? combinedProjects.slice(1).map(project => {
    const projectCenter = center(project);
    return projectCenter ? distanceMiles(combinedStart, projectCenter) : null;
  }).filter((distance): distance is number => distance !== null) : [];
  const combinedDistance = combinedDistances.length ? Math.max(...combinedDistances) : null;
  const combinedTier = combinedDistance === null ? null : tierForDistance(combinedDistance);
  const combinedDayCount = combinedProjects.length > 1 ? combinedDaysApart(combinedProjects.map(project => project.id)) : null;
  if (!shown.length) return <aside className="details-panel no-selection"><div className="panel-heading"><span className="eyebrow">OPPORTUNITY DETAILS</span><CircleHelp size={16}/></div><div className="selection-intro"><div className="selection-graphic"><MapPin size={24}/><span/><MapPin size={24}/></div><h2>A closer look at<br/>what’s nearby.</h2><p>Select an opportunity to explore its location, timing, and potential for coordination.</p></div><div className="tier-guide"><span className="eyebrow">THREE WAYS TO COORDINATE</span>{TIERS.map(t => <div className="tier-guide-row" key={t.id}><span className={`tier-number tier-${t.id}`}>{t.id}</span><div><strong>{t.name} proximity</strong><p>{t.scenario}</p></div><span>{t.range}</span></div>)}</div><div className="method-note"><FileText size={17}/><div><strong>Evidence comes first</strong><p>These are geographic candidates. Shared schedules, routes, and resources need further verification.</p></div></div></aside>;
  const tier = pair ? TIERS[pair.tier - 1] : null;
  if (combinedProjects.length > 1) return <aside className="details-panel has-selection"><div className="panel-heading"><span className="eyebrow">SELECTED OPPORTUNITY</span><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={17}/></button></div><div className="detail-title"><span className={combinedTier ? `tier-badge tier-${combinedTier}` : 'tier-badge'}>{combinedTier ? `${TIERS[combinedTier - 1].name} connection` : 'Combined Projects'}</span><h2>Combined Projects</h2><p className="combined-project-names">{combinedProjects.map(project => project.shortName).join(' · ')}</p></div><div className="detail-metrics combined-group-metrics"><div><span><Route size={14}/> FARTHEST CENTER</span><strong>{combinedDistance?.toFixed(2) ?? '—'} <small>mi</small></strong></div><div><span><CalendarDays size={14}/> DAYS APART</span><strong>{combinedDayCount?.toLocaleString() ?? '—'} <small>days</small></strong></div></div><div className="detail-content combined-details-content">{shown.map(project => <section className="project-detail" key={project.id}><div className="utility-label"><i className={`utility-dot ${project.utility.toLowerCase()}`}/>{utilityName(project.utility)}<span>{project.id}</span></div><h3>{project.shortName}</h3><p className="full-project-name">{project.name}</p><div className="project-facts"><span>Planned in-service</span><strong>{formatDate(project.inServiceDate)}</strong></div><button className="text-button" onClick={() => onZoom(project.id)}><LocateFixed size={15}/> Inspect at street level<ArrowUpRight size={13}/></button></section>)}</div></aside>;
  return <aside className="details-panel has-selection"><div className="panel-heading"><span className="eyebrow">{pair ? 'SELECTED OPPORTUNITY' : 'PROJECT DETAILS'}</span><button className="icon-button" aria-label="Close details" onClick={onClose}><X size={17}/></button></div><div className="detail-title">{tier && <span className={`tier-badge tier-${tier.id}`}>Tier {tier.id} · {tier.name}</span>}<h2>{pair ? tier!.scenario : inspected!.shortName}</h2><p>{pair ? 'Cross-utility coordination candidate' : 'No geographic match in the current results'}</p></div>
    {pair && <div className="detail-metrics"><div><span><Route size={14}/> TOTAL SCORE</span><strong>{pair.totalScore} <small>/100</small></strong></div><div><span><Route size={14}/> CENTER DISTANCE</span><strong>{pair.distanceMi.toFixed(2)} <small>mi</small></strong></div><div><span><CalendarDays size={14}/> DATE GAP</span><strong>{pair.timeGapDays?.toLocaleString() ?? '—'} <small>days</small></strong></div></div>}
    <div className="detail-content">
      {shown.map(p => <section className="project-detail" key={p.id}><div className="utility-label"><i className={`utility-dot ${p.utility.toLowerCase()}`}/>{utilityName(p.utility)}<span>{p.id}</span></div><h3>{p.shortName}</h3><p className="full-project-name">{p.name}</p><div className="project-facts"><span>Planned in-service</span><strong>{formatDate(p.inServiceDate)}</strong></div><button className="text-button" onClick={() => onZoom(p.id)}><LocateFixed size={15}/> Inspect at street level<ArrowUpRight size={13}/></button></section>)}{pair && <section className="coordination-note"><span className="eyebrow">SCORE BREAKDOWN</span><p>Distance {pair.distanceScore}/50 · Timeline {pair.timelineScore}/50</p><span>Timeline uses planned in-service date proximity because construction windows are not available.</span></section>}
      {!pair && inspected && canDeleteInspected && <div className="delete-created-project-row"><button className="delete-created-project-button" onClick={() => setConfirmingDelete(true)}><Trash2 size={16}/>Delete Project</button></div>}
    </div>
    {confirmingDelete && inspected && <div className="delete-project-confirm-backdrop">
      <section className="delete-project-confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" aria-describedby="delete-project-message">
        <div className="delete-project-confirm-heading"><div><span className="eyebrow">DELETE PROJECT</span><h2 id="delete-project-title">Delete this project?</h2></div></div>
        <p id="delete-project-message">&quot;{inspected.shortName}&quot; will be removed from this session.</p>
        <div className="delete-project-confirm-actions">
          <button type="button" className="secondary-button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
          <button type="button" className="delete-project-confirm-action" onClick={() => { onDeleteProject(inspected.id); setConfirmingDelete(false); }}><Trash2 size={15}/>Delete Project</button>
        </div>
      </section>
    </div>}
  </aside>;
}
