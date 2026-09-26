export type Coordinate = [number, number]; // Longitude, latitude
export type Utility = 'DESC' | 'GPC';
export type Endpoint = { name: string; coordinates: Coordinate | null };
export type Project = {
  id: string; utility: Utility; state: string; name: string; shortName: string;
  endpoints: [Endpoint, Endpoint]; inServiceDate: string | null;
  rawDate: string; sourceRow: number; sourceProjectId: string | null;
  document: string | null; documentPage: number | null; notes: string[];
};
export type Tier = 1 | 2 | 3;
export type Opportunity = {
  id: string; projectA: string; projectB: string; distanceMi: number;
  timeGapDays: number | null; tier: Tier;
};
export type Dataset = {
  name: string; source: string; referenceDate: string;
  projects: Project[];
};
export type DashboardData = Dataset & { opportunities: Opportunity[]; candidateCount: number };
export const UTILITY_NAMES: Record<Utility, string> = {
  DESC: 'Dominion Energy SC', GPC: 'Georgia Power',
};
export const TIERS = [
  { id: 1 as const, name: 'Immediate', range: '< 1 mi', scenario: 'Site access & staging', description: 'Investigate shared site access, staging areas, or nearby land needs.' },
  { id: 2 as const, name: 'Local', range: '1–<5 mi', scenario: 'Local logistics', description: 'Investigate shared equipment staging, deliveries, and construction logistics.' },
  { id: 3 as const, name: 'Regional', range: '5–<25 mi', scenario: 'Crews & equipment', description: 'Investigate crew scheduling, specialized equipment, and contractor mobilization.' },
];
