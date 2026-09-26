import { describe, expect, it } from 'vitest';
import data from '../db/data/projects.json';
import { calculateOpportunities, candidateCount, center, dayGap, distanceMiles, rankOpportunities, tierForDistance } from '../shared/analysis';
import type { Dataset, Opportunity, Project } from '../shared/types';
const projects = (data as Dataset).projects;
describe('supplied workbook reconciliation', () => {
  it('reproduces all six distances, date gaps and 25 comparisons', () => {
    const pairs = calculateOpportunities(projects);
    expect(candidateCount(projects)).toBe(25);
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
    expect(pairs.map(p => p.id)).toEqual(['DESC_2__GPC_1', 'DESC_3__GPC_2', 'DESC_5__GPC_2', 'DESC_3__GPC_3', 'DESC_5__GPC_3', 'DESC_1__GPC_1']);
    expect(pairs.filter(p => p.tier === 1)).toHaveLength(0);
    expect(pairs.filter(p => p.tier === 2)).toHaveLength(1);
    expect(pairs.filter(p => p.tier === 3)).toHaveLength(5);
  });
  it('excludes same-utility and unlocated pairs', () => {
    expect(calculateOpportunities(projects.filter(p => p.utility === 'DESC'))).toHaveLength(0);
    expect(calculateOpportunities(projects.map(p => ({ ...p, endpoints: [{ name: 'a', coordinates: null }, { name: 'b', coordinates: null }] })))).toHaveLength(0);
  });
});
describe('geographic and timing boundaries', () => {
  it.each([[0, 1], [.99999, 1], [1, 2], [4.99999, 2], [5, 3], [24.99999, 3], [25, null], [25.01, null], [-1, null], [NaN, null]])('classifies %s miles as tier %s', (distance, tier) => expect(tierForDistance(distance as number)).toBe(tier));
  it('uses complete endpoint coordinates, preserving legitimate zeroes', () => {
    expect(center(projects[0])).toEqual([-82.051362, 33.562599]);
    expect(center(projects[2])![0]).toBeCloseTo(-81.0785475, 7);
    const p: Project = { ...projects[0], endpoints: [{ name: 'a', coordinates: [0, 0] }, { name: 'b', coordinates: null }] };
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
