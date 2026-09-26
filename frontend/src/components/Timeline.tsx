import { CalendarDays } from 'lucide-react';
import type { Project } from '../../../shared/types';
export function formatDate(date: string | null) { return date ? new Date(date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'Unknown'; }
export default function Timeline({ projects, gap }: { projects: Project[]; gap: number | null }) {
  if (projects.length !== 2) return <section className="timeline empty-timeline"><CalendarDays size={20}/><div><strong>Compare planned milestones</strong><p>Select an opportunity to compare its two source dates.</p></div><span className="quiet-label">IN-SERVICE DATES</span></section>;
  const timestamps = projects.map(p => p.inServiceDate ? Date.parse(p.inServiceDate) : null);
  const known = timestamps.filter((t): t is number => t !== null);
  const min = Math.min(...known), max = Math.max(...known), duration = Math.max(max - min, 86400000);
  return <section className="timeline"><div className="timeline-top"><strong><CalendarDays size={16}/> Planned milestones</strong><span>{gap === null ? 'Timing unknown' : `${gap.toLocaleString()} days apart`}</span></div><div className="timeline-lanes">{projects.map((p, i) => <div className="timeline-lane" key={p.id}><span className={p.utility.toLowerCase()}>{p.id}</span><div className="milestone-track">{timestamps[i] !== null && <i className={`milestone ${p.utility.toLowerCase()}`} style={{ left: `${10 + ((timestamps[i]! - min) / duration) * 80}%` }}/>}</div><time>{formatDate(p.inServiceDate)}</time></div>)}</div><p className="timeline-note">Planned in-service dates from the workbook; construction windows are not established.</p></section>;
}
