import { expect, test } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:3010';

test('TMDB identity prevents legacy duplicate links from leaking into Overflow', async ({ page }) => {
  const detailResponse = await page.request.get(`${BASE_URL}/api/v1/catalog/public/anime/95897`);
  expect(detailResponse.ok()).toBeTruthy();
  const detail = await detailResponse.json();
  expect(detail.tmdb_id).toBe(95897);
  expect(detail.title).toBe('Overflow');
  expect(detail.mal_id).toBe(40746);

  const gatewayResponse = await page.request.get(
    `${BASE_URL}/api/v1/providers/anime/95897?season=1&episode=1&subtitles=es,en`,
  );
  expect(gatewayResponse.ok()).toBeTruthy();
  const gateway = await gatewayResponse.json();
  const sources = [...(gateway.sources || []), ...(gateway.fallbackCandidates || [])];
  expect(sources.length).toBeGreaterThan(0);
  expect(sources.some((source: any) => /overflow-latino/i.test(`${source.url || ''} ${source.canonicalLocator || ''}`))).toBeFalsy();
  const zoko = sources.filter((source: any) => source.provider === 'zokoanime');
  expect(zoko.map((source: any) => source.canonicalLocator || source.url)).toEqual(
    expect.arrayContaining([
      'https://zokoanime.video/stream/mal/40746/1/sub',
      'https://zokoanime.video/stream/mal/40746/1/dub',
    ]),
  );

  const cascadeResponse = await page.request.get(`${BASE_URL}/api/v1/play-multi/cmtqj6jwe25b8butggh2297ae?season=1`);
  expect(cascadeResponse.ok()).toBeTruthy();
  const cascade = await cascadeResponse.json();
  expect(cascade.media_item_ids).toEqual(['cmtqj6jwe25b8butggh2297ae']);
});
