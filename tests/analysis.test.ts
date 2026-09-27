import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { calculateOpportunities, candidateCount, center, dayGap, distanceMiles, distanceScore, rankOpportunities, scoreOpportunity, tierForDistance, timelineScore } from '../shared/analysis';
import type { Dataset, Opportunity, Project } from '../shared/types';
type ProjectRow = {
  id: string; utility: string; state: string; name: string; shortName: string;
  sourceRow: number; sourceProjectId: string | null; inServiceDate: string | null;
  rawDate: string; document: string | null; documentPage: number | null;
};
type EndpointRow = { projectId: string; endpointOrder: number; name: string; longitude: number | null; latitude: number | null };
function loadProjectsFromDb(): Dataset['projects'] {
  const db = new DatabaseSync('db/data/gridlock.sqlite', { readOnly: true });
  const rows = db.prepare(`
    SELECT p.id, p.utility_code AS utility, p.state, p.name, p.short_name AS shortName,
      p.source_row AS sourceRow, p.source_project_id AS sourceProjectId,
      p.in_service_date AS inServiceDate, COALESCE(p.raw_date, '') AS rawDate,
      sd.file_name AS document, p.document_page AS documentPage
    FROM projects p
    LEFT JOIN source_documents sd ON sd.id = p.document_id
    ORDER BY p.source_row, p.id
  `).all() as ProjectRow[];
  const endpointRows = db.prepare(`
    SELECT project_id AS projectId, endpoint_order AS endpointOrder, name, longitude, latitude
    FROM project_endpoints
    ORDER BY project_id, endpoint_order
  `).all() as EndpointRow[];
  const endpoints = new Map<string, Project['endpoints']>();
  for (const endpoint of endpointRows) {
    const list = endpoints.get(endpoint.projectId) ?? [null, null] as unknown as Project['endpoints'];
    list[endpoint.endpointOrder - 1] = {
      name: endpoint.name,
      coordinates: endpoint.longitude === null || endpoint.latitude === null ? null : [endpoint.longitude, endpoint.latitude],
    };
    endpoints.set(endpoint.projectId, list);
  }
  db.close();
  return rows.map(row => ({
    id: row.id,
    utility: row.utility,
    state: row.state,
    name: row.name,
    shortName: row.shortName,
    endpoints: endpoints.get(row.id)!,
    inServiceDate: row.inServiceDate,
    rawDate: row.rawDate,
    sourceRow: row.sourceRow,
    sourceProjectId: row.sourceProjectId,
    document: row.document,
    documentPage: row.documentPage,
    notes: [],
  } as Project));
}
const projects = loadProjectsFromDb();
const workbookProjects = projects.filter(p => p.sourceRow <= 11);
const ctpcProjects = projects.filter(p => p.utility === 'CTPC');
const dominionDescriptionProjects = projects.filter(p => p.id.startsWith('DESC24_'));
const irpVolume3Projects = projects.filter(p => p.id.startsWith('IRP25_'));
describe('supplied workbook reconciliation', () => {
  it('reproduces all six distances, date gaps and 25 comparisons', () => {
    const pairs = calculateOpportunities(workbookProjects);
    expect(candidateCount(workbookProjects)).toBe(25);
    expect(pairs).toHaveLength(6);
    const expected = [
      ['DESC_2__GPC_1', 4.09, 3074], ['DESC_3__GPC_2', 5.65, 152],
      ['DESC_3__GPC_3', 7.55, 517], ['DESC_1__GPC_1', 8.01, 3074],
      ['DESC_5__GPC_2', 14.34, 365], ['DESC_5__GPC_3', 14.81, 730],
    ] as const;
    for (const [id, distance, gap] of expected) {
      const p = pairs.find(p => p.id === id)!;
      expect(p.distanceMi).toBeCloseTo(distance, 2); expect(p.timeGapDays).toBe(gap);
    }
    expect(pairs.map(p => p.id)).toEqual(['DESC_3__GPC_2', 'DESC_2__GPC_1', 'DESC_3__GPC_3', 'DESC_1__GPC_1', 'DESC_5__GPC_2', 'DESC_5__GPC_3']);
    expect(pairs.find(p => p.id === 'DESC_3__GPC_2')?.totalScore).toBe(59);
    expect(pairs.find(p => p.id === 'DESC_2__GPC_1')?.timelineScore).toBe(0);
    expect(pairs.filter(p => p.tier === 1)).toHaveLength(0);
    expect(pairs.filter(p => p.tier === 2)).toHaveLength(1);
    expect(pairs.filter(p => p.tier === 3)).toHaveLength(5);
  });
  it('excludes same-utility and unlocated pairs', () => {
    expect(calculateOpportunities(workbookProjects.filter(p => p.utility === 'DESC'))).toHaveLength(0);
    expect(calculateOpportunities(workbookProjects.map(p => ({ ...p, endpoints: [{ name: 'a', coordinates: null }, { name: 'b', coordinates: null }] })))).toHaveLength(0);
  });
});
describe('dataset imports', () => {
  it('keeps the ten spreadsheet projects intact and separate from CTPC rows', () => {
    expect(workbookProjects).toHaveLength(10);
    expect(workbookProjects.filter(p => p.utility === 'DESC')).toHaveLength(5);
    expect(workbookProjects.filter(p => p.utility === 'GPC')).toHaveLength(5);
    expect(workbookProjects.every(p => p.document === null && p.documentPage === null && p.sourceProjectId === null)).toBe(true);
    expect(workbookProjects.some(p => p.id.includes('_PDF_') || p.id.includes('_SYN_'))).toBe(false);
  });
  it('promotes Gemini-parsed CTPC rows into searchable map projects', () => {
    expect(ctpcProjects).toHaveLength(93);
    expect(ctpcProjects.every(p => p.utility === 'CTPC')).toBe(true);
    expect(ctpcProjects.every(p => p.document === '2025_Collaborative_Transmission_Plan_MidYear_Update_08-13-26.pdf')).toBe(true);
    expect(ctpcProjects.every(p => p.sourceProjectId && !p.id.includes('REMOVED'))).toBe(true);
    expect(ctpcProjects.filter(p => center(p)).length).toBeGreaterThan(60);
  });
  it('promotes complete Dominion project description rows into searchable map projects', () => {
    expect(dominionDescriptionProjects).toHaveLength(43);
    expect(dominionDescriptionProjects.every(p => p.utility === 'DESC')).toBe(true);
    expect(dominionDescriptionProjects.every(p => p.document === '2024-2028-2million-and-above-project-descriptions.pdf')).toBe(true);
    expect(dominionDescriptionProjects.every(p => p.sourceProjectId && p.rawDate)).toBe(true);
    expect(dominionDescriptionProjects.filter(p => center(p)).length).toBeGreaterThan(35);
  });
  it('promotes complete IRP Volume 3 rows with sponsor utilities', () => {
    expect(irpVolume3Projects).toHaveLength(208);
    expect(new Set(irpVolume3Projects.map(p => p.utility))).toEqual(new Set(['DU', 'GPC', 'GTC', 'MEAG', 'SAV']));
    expect(irpVolume3Projects.every(p => p.document === '2025 IRP Volume 3 PUBLIC DISCLOSURE.pdf')).toBe(true);
    expect(irpVolume3Projects.every(p => p.sourceProjectId && p.name && p.rawDate)).toBe(true);
  });
  it('uses sponsor state context for ambiguous city names', () => {
    const doyle = irpVolume3Projects.find(p => p.sourceProjectId === '20234');
    expect(doyle?.state).toBe('GA');
    expect(center(doyle!)).toEqual([-83.7132, 33.7948]);
  });
});
describe('geographic and timing boundaries', () => {
  it.each([[0, 1], [.99999, 1], [1, 2], [4.99999, 2], [5, 3], [24.99999, 3], [25, 3], [25.01, null], [-1, null], [NaN, null]])('classifies %s miles as tier %s', (distance, tier) => expect(tierForDistance(distance as number)).toBe(tier));
  it.each([[0, 50], [2, 50], [2.1, 49], [5, 45], [10, 38], [15, 28], [20, 18], [25, 6], [25.01, 0]])('scores %s miles as %s distance points', (distance, expected) => expect(distanceScore(distance as number)).toBe(expected));
  it.each([[0, 36], [30, 30], [31, 29], [90, 23], [180, 13], [365, 4], [366, 2], [730, 0], [3074, 0]])('scores %s date-gap days as %s timeline points', (gap, expected) => expect(timelineScore(gap as number)).toBe(expected));
  it('uses complete endpoint coordinates, preserving legitimate zeroes', () => {
    expect(center(workbookProjects[0])).toEqual([-82.051362, 33.562599]);
    expect(center(workbookProjects[2])![0]).toBeCloseTo(-81.0785475, 7);
    const p: Project = { ...workbookProjects[0], endpoints: [{ name: 'a', coordinates: [0, 0] }, { name: 'b', coordinates: null }] };
    expect(center(p)).toEqual([0, 0]);
  });
  it('computes symmetric distances and a known degree at the equator', () => {
    expect(distanceMiles([0, 0], [0, 0])).toBe(0);
    expect(distanceMiles([0, 0], [1, 0])).toBeCloseTo(69.0934, 3);
    expect(distanceMiles([-81, 32], [-82, 33])).toBe(distanceMiles([-82, 33], [-81, 32]));
  });
  it('uses calendar days across DST and leap years, and rejects impossible dates', () => {
    expect(dayGap('2024-02-28', '2024-03-01')).toBe(2);
    expect(dayGap('2026-03-07', '2026-03-09')).toBe(2);
    expect(dayGap('2025-02-30', '2025-03-02')).toBeNull();
    expect(dayGap(null, '2025-01-01')).toBeNull();
  });
  it('ranks by total score so extreme date gaps are not treated as good fits', () => {
    const make = (id: string, distanceMi: number, timeGapDays: number | null, tier: Opportunity['tier']): Opportunity => ({
      id, projectA: 'a', projectB: 'b', distanceMi, timeGapDays, tier, ...scoreOpportunity(distanceMi, timeGapDays),
    });
    const pairs = [make('a', 6, 30, 3), make('b', 5.5, 2900, 3), make('c', 4.9, null, 2)];
    expect(rankOpportunities(pairs).map(p => p.id)).toEqual(['a', 'c', 'b']);
    expect(rankOpportunities(pairs, 'nearest').map(p => p.id)).toEqual(['c', 'b', 'a']);
    expect(pairs.find(p => p.id === 'b')?.timelineScore).toBe(0);
  });
});
