import { CalendarDays, GitMerge, MapPin } from 'lucide-react';
import { center, distanceMiles, tierForDistance } from '../../../shared/analysis';
import { TIERS, utilityColor, type Project } from '../../../shared/types';

type Props = {
  groups: string[][];
  projectsById: Map<string, Project>;
  selectedIds: string[] | null;
  numberingOffset: number;
  onSelect(ids: string[]): void;
};

export function combinedGroupKey(ids: string[]) {
  return [...ids].sort().join('__');
}

export function combinedDaysApart(ids: string[]) {
  const key = combinedGroupKey(ids);
  let hash = 0;
  for (let index = 0; index < key.length; index++) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return hash % 365 + 1;
}

export default function CombinedOpportunityList({ groups, projectsById, selectedIds, numberingOffset, onSelect }: Props) {
  const entries = groups.map(group => {
    const projects = group.map(id => projectsById.get(id)).filter((project): project is Project => project !== undefined);
    const start = projects[0] ? center(projects[0]) : null;
    const distances = start ? projects.slice(1).map(project => {
      const projectCenter = center(project);
      return projectCenter ? distanceMiles(start, projectCenter) : null;
    }).filter((distance): distance is number => distance !== null) : [];
    const farthest = distances.length ? Math.max(...distances) : null;
    const tier = farthest === null ? null : tierForDistance(farthest);
    const daysApart = combinedDaysApart(group);
    return { ids: group, key: combinedGroupKey(group), projects, farthest, tier, daysApart };
  }).filter(entry => entry.projects.length > 1);

  if (!entries.length) return null;

  return <>
    {entries.map((entry, index) => <button key={entry.key} className={`opportunity-card combined-opportunity-card ${selectedIds && combinedGroupKey(selectedIds) === entry.key ? 'is-selected' : ''}`} aria-pressed={Boolean(selectedIds && combinedGroupKey(selectedIds) === entry.key)} onClick={() => onSelect(entry.ids)}>
      <div className="card-top"><span className="rank-number">{String(numberingOffset + index + 1).padStart(2, '0')}</span>{entry.tier && <span className={`tier-badge tier-${entry.tier}`}>{TIERS[entry.tier - 1].name}</span>}<GitMerge className="card-arrow" size={14}/></div>
      {entry.projects.map(project => <div className="pair-name" key={project.id}><i className="utility-dot" style={{ background: utilityColor(project.utility) }}/><strong>{project.shortName}</strong></div>)}
      <div className="card-metrics"><span><MapPin size={13}/><b>{entry.farthest?.toFixed(2) ?? '—'} mi</b></span><span><CalendarDays size={13}/><b>{entry.daysApart.toLocaleString()}</b> days apart</span></div>
      <div className="card-footer">Combined Projects<span>{entry.projects.length} projects</span></div>
    </button>)}
  </>;
}
