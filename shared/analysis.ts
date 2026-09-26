import type { Coordinate, Opportunity, Project, Tier } from './types';
export const EARTH_RADIUS_MI = 3958.7613;
export const MAX_COMPARISON_DISTANCE_MI = 25;
export function center(project: Project): Coordinate | null {
  const points = project.endpoints.map(e => e.coordinates).filter((p): p is Coordinate => p !== null);
  if (!points.length) return null;
  return [points.reduce((n, p) => n + p[0], 0) / points.length, points.reduce((n, p) => n + p[1], 0) / points.length];
}
export function distanceMiles(a: Coordinate, b: Coordinate): number {
  const rad = (v: number) => v * Math.PI / 180;
  const dlat = rad(b[1] - a[1]); const dlon = rad(b[0] - a[0]);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dlon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
export function tierForDistance(distance: number): Tier | null {
  if (!Number.isFinite(distance) || distance < 0 || distance >= MAX_COMPARISON_DISTANCE_MI) return null;
  return distance < 1 ? 1 : distance < 5 ? 2 : 3;
}
export function dayGap(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
  return valid(a) && valid(b) ? Math.abs((Date.parse(a) - Date.parse(b)) / 86400000) : null;
}
export function rankOpportunities(pairs: Opportunity[], sort = 'coordination'): Opportunity[] {
  return [...pairs].sort((a, b) => {
    const gap = (a.timeGapDays ?? Infinity) - (b.timeGapDays ?? Infinity);
    if (sort === 'nearest') return a.distanceMi - b.distanceMi || gap || a.id.localeCompare(b.id);
    if (sort === 'timing') return gap || a.distanceMi - b.distanceMi || a.id.localeCompare(b.id);
    return a.tier - b.tier || gap || a.distanceMi - b.distanceMi || a.id.localeCompare(b.id);
  });
}
export function calculateOpportunities(projects: Project[]): Opportunity[] {
  const pairs: Opportunity[] = [];
  for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) {
    const a = projects[i], b = projects[j];
    if (a.utility === b.utility) continue;
    const ca = center(a), cb = center(b);
    if (!ca || !cb) continue;
    const distanceMi = distanceMiles(ca, cb), tier = tierForDistance(distanceMi);
    if (tier === null) continue;
    pairs.push({ id: [a.id, b.id].sort().join('__'), projectA: a.id, projectB: b.id, distanceMi, tier, timeGapDays: dayGap(a.inServiceDate, b.inServiceDate) });
  }
  return rankOpportunities(pairs);
}
export function candidateCount(projects: Project[]) {
  let count = 0;
  for (let i = 0; i < projects.length; i++) for (let j = i + 1; j < projects.length; j++) if (projects[i].utility !== projects[j].utility) count++;
  return count;
}
