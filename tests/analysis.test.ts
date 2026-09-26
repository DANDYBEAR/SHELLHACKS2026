import { describe, expect, it } from 'vitest';
import data from '../db/data/projects.json';
import { calculateOpportunities, candidateCount, center, dayGap, distanceMiles, rankOpportunities, tierForDistance } from '../shared/analysis';
import type { Dataset, Opportunity, Project } from '../shared/types';
const projects = (data as unknown as Dataset).projects;
const workbookProjects = projects.filter(p => p.sourceRow <= 11);
describe('curated test-data reconciliation', () => {
  it('keeps the ten workbook seed projects but separates their synthetic map regions', () => {
    const pairs = calculateOpportunities(workbookProjects);
    expect(candidateCount(workbookProjects)).toBe(25);
    expect(pairs).toHaveLength(0);
    expect(workbookProjects.filter(p => p.utility === 'DESC').every(p => p.state !== 'GA')).toBe(true);
    expect(workbookProjects.filter(p => p.utility === 'GPC').every(p => p.state !== 'SC')).toBe(true);
  });
  it('excludes same-utility and unlocated pairs', () => {
    expect(calculateOpportunities(workbookProjects.filter(p => p.utility === 'DESC'))).toHaveLength(0);
    expect(calculateOpportunities(workbookProjects.map(p => ({ ...p, endpoints: [{ name: 'a', coordinates: null }, { name: 'b', coordinates: null }] })))).toHaveLength(0);
  });
});
describe('ProjectListings PDF import', () => {
  it('curates the PDF imports down to a smaller map-friendly sample', () => {
    expect(workbookProjects).toHaveLength(10);
    expect(projects).toHaveLength(40);
    expect(projects.filter(p => p.utility === 'DESC')).toHaveLength(20);
    expect(projects.filter(p => p.utility === 'GPC')).toHaveLength(20);
    expect(projects.filter(p => p.document === '2024-2028-2million-and-above-project-descriptions.pdf')).toHaveLength(15);
    expect(projects.filter(p => p.document === '2025 IRP Volume 3 PUBLIC DISCLOSURE.pdf')).toHaveLength(15);
    expect(projects.find(p => p.sourceProjectId === '6809 E')?.documentPage).toBe(14);
    expect(projects.find(p => p.sourceProjectId === '0167C-D')?.id).toBe('DESC_PDF_0167C_D');
    expect(projects.find(p => p.sourceProjectId === '20785')?.id).toBe('GPC_PDF_20785');
  });
  it('keeps utilities out of each other primary states and leaves unresolved projects off the map', () => {
    const unresolved = projects.find(p => p.id === 'GPC_SYN_UNLOCATED')!;
    expect(center(unresolved)).toBeNull();
    const resolved = projects.find(p => p.id === 'GPC_PDF_21116')!;
    expect(center(resolved)).not.toBeNull();
    expect(projects.filter(p => p.utility === 'DESC').every(p => p.state !== 'GA')).toBe(true);
    expect(projects.filter(p => p.utility === 'GPC').every(p => p.state !== 'SC')).toBe(true);
    expect(calculateOpportunities(projects)).toHaveLength(11);
  });
  it('includes deterministic synthetic edge cases for map and scoring states', () => {
    expect(projects.filter(p => p.id.includes('_SYN_'))).toHaveLength(10);
    expect(projects.find(p => p.id === 'DESC_SYN_NO_DATE')?.inServiceDate).toBeNull();
    const pairs = calculateOpportunities(projects);
    expect(pairs.some(p => p.tier === 1)).toBe(true);
    expect(pairs.some(p => p.tier === 2)).toBe(true);
    expect(pairs.some(p => p.tier === 3)).toBe(true);
    expect(pairs.some(p => p.id === 'DESC_SYN_EXCLUDED__GPC_SYN_EXCLUDED')).toBe(false);
  });
});
describe('geographic and timing boundaries', () => {
  it.each([[0, 1], [.99999, 1], [1, 2], [4.99999, 2], [5, 3], [24.99999, 3], [25, null], [25.01, null], [-1, null], [NaN, null]])('classifies %s miles as tier %s', (distance, tier) => expect(tierForDistance(distance as number)).toBe(tier));
  it('uses complete endpoint coordinates, preserving legitimate zeroes', () => {
    expect(center(workbookProjects[0])![0]).toBeCloseTo(-80.3366405, 7);
    expect(center(workbookProjects[0])![1]).toBeCloseTo(33.18667, 7);
    expect(center(workbookProjects[2])![0]).toBeCloseTo(-81.051335, 7);
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
  it('ranks tier first, known timing next, then precise distance', () => {
    const base: Opportunity = { id: 'a', projectA: 'a', projectB: 'b', distanceMi: 6, timeGapDays: 30, tier: 3 };
    const pairs = [base, { ...base, id: 'b', distanceMi: 5.5, timeGapDays: 2900 }, { ...base, id: 'c', distanceMi: 4.9, timeGapDays: null, tier: 2 as const }];
    expect(rankOpportunities(pairs).map(p => p.id)).toEqual(['c', 'a', 'b']);
    expect(rankOpportunities(pairs, 'nearest').map(p => p.id)).toEqual(['c', 'b', 'a']);
  });
});
