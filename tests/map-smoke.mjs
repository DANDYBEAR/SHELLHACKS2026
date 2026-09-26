import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const failures = [], basemapResponses = [];
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on('response', response => {
    if (response.url().includes('/api/basemap/')) basemapResponses.push({ url: response.url(), status: response.status() });
  });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: /Opportunities 6/ }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.maplibregl-canvas').length > 0);
  await page.waitForTimeout(1800);
  console.log('Initial basemap responses:', JSON.stringify(basemapResponses.slice(0, 12)));
  console.log('Initial failed requests:', JSON.stringify(failures.slice(0, 12)));
  await page.getByText('Georgia & South Carolina').waitFor();
  await page.waitForTimeout(1200);
  await mkdir('work', { recursive: true });
  await page.screenshot({ path: resolve('work/map-light.png') });
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: resolve('work/map-dark.png') });
  await page.locator('.opportunity-card').nth(1).click();
  await page.getByRole('button', { name: /Inspect at street level/ }).first().click();
  await page.waitForTimeout(6500);
  await page.screenshot({ path: resolve('work/map-street.png') });
  await page.getByRole('button', { name: 'Light theme' }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: resolve('work/map-street-light.png') });
  console.log(`Basemap responses: ${basemapResponses.length}; failures: ${failures.length}`);
  const providerErrors = basemapResponses.filter(r => r.status >= 400 && !(r.status === 404 && r.url.endsWith('.pbf')));
  console.log('Response statuses:', JSON.stringify([...new Set(basemapResponses.map(r => r.status))]));
  console.log('Street tile responses:', JSON.stringify(basemapResponses.filter(r => /\/planet\/[^/]+\/1[4-9]\//.test(r.url)).slice(0, 8)));
  if (failures.length) console.log('Failed requests:', failures.slice(0, 8).join('\n'));
  if (providerErrors.length) throw new Error('Basemap returned an error');
  if (basemapResponses.filter(r => r.url.endsWith('.pbf') && r.status === 200).length < 2) throw new Error('Vector tiles not delivered');
  if (!basemapResponses.some(r => /\/planet\/[^/]+\/1[4-9]\//.test(r.url) && r.status === 200)) throw new Error('Street-level tiles not delivered');
} finally { await browser.close(); }
