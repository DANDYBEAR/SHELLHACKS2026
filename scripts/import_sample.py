"""Read the supplied workbook without modifying it. Rebuild db/data/projects.json."""
import json
import sys
from datetime import datetime
from pathlib import Path
from openpyxl import load_workbook

source = Path(sys.argv[1])
workbook = load_workbook(source, read_only=True, data_only=True)
rows = list(workbook['projects'].values)
short_names = ['Stevens Creek – Hooks', 'Hooks – Thurmond', 'Jasper – Okatie', 'Queensboro – Ft Johnson', 'Okatie – Bluffton', 'Evans Primary – Thurmond Dam', 'McIntosh – Purrysburg', 'Goshen – McIntosh', 'Mitchell – North Tifton', 'Jesup – Ludowici Primary']
desc_sources = { 'DESC_1': ('6809 E', 14), 'DESC_2': ('6810 A', 31), 'DESC_3': ('06367 D - G', 23), 'DESC_4': ('6807 B', 1), 'DESC_5': ('6808 S', 10) }
projects = []
for i, row in enumerate(rows[1:]):
    r = dict(zip(rows[0], row))
    raw = r['in_service_date']
    parsed = raw if isinstance(raw, datetime) else datetime.strptime(raw, '%m/%d/%Y') if raw else None
    endpoints = []
    for suffix in ['a', 'b']:
        lat, lon = r[f'lat_{suffix}'], r[f'lon_{suffix}']
        endpoints.append({'name': r[f'name_{suffix}'], 'coordinates': [lon, lat] if lat is not None and lon is not None else None})
    notes = ['Coordinates supplied by the starter workbook; not independently location-verified.']
    if any(e['coordinates'] is None for e in endpoints): notes.append('One endpoint is missing. The located endpoint represents the project center.')
    if r['project_id'] in ['GPC_2', 'GPC_3']: notes.append('McIntosh coordinates differ by approximately 657 m between workbook records. Review before merging.')
    if r['project_id'] == 'DESC_1': notes.append('Source project 6809 E; a similarly named project 6809 G is a separate record.')
    if r['project_id'].startswith('GPC'): notes.append('Date retained as labeled by the workbook. Georgia PDF uses Need Date; source terminology and disclosure markings require review before enrichment.')
    sid, page = desc_sources.get(r['project_id'], (None, None))
    projects.append({'id': r['project_id'], 'utility': r['project_id'].split('_')[0], 'state': r['state'], 'name': r['project_name'], 'shortName': short_names[i], 'endpoints': endpoints, 'inServiceDate': parsed.strftime('%Y-%m-%d') if parsed else None, 'rawDate': raw.strftime('%m/%d/%Y') if isinstance(raw, datetime) else str(raw or ''), 'sourceRow': i + 2, 'sourceProjectId': sid, 'document': '2024-2028-2million-and-above-project-descriptions.pdf' if page else None, 'documentPage': page, 'notes': notes})
output = Path(__file__).resolve().parents[1] / 'db/data/projects.json'
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({'name': 'Provided planning snapshot', 'source': source.name, 'referenceDate': '2026-09-26', 'projects': projects}, indent=2), encoding='utf-8')
print(f'Imported {len(projects)} projects into {output}')
