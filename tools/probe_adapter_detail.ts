import { scraperManager } from "../server/universalScraper";

const url = process.argv[2];
if (!url) throw new Error("usage: npx tsx tools/probe_adapter_detail.ts <url> [adapter]");
const adapterId = process.argv[3];

(async () => {
  const adapter = scraperManager.getAdapter(url, adapterId);
  const response = await fetch(url);
  const html = await response.text();
  const privateAdapter = adapter as unknown as { extractEpisodeId?: (html: string) => string | null };
  const episodeId = privateAdapter.extractEpisodeId?.(html) || null;
  const internals = adapter as unknown as {
    discoverNextActionId?: (html: string) => Promise<string>;
    buildNextRouterStateTree?: (url: string) => string;
  };
  let actionProbe: { action_id?: string; status?: number; body_prefix?: string } | undefined;
  if (episodeId && internals.discoverNextActionId && internals.buildNextRouterStateTree) {
    const actionId = await internals.discoverNextActionId(html);
    const actionResponse = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/x-component",
        Referer: url,
        "Next-Action": actionId,
        "Next-Router-State-Tree": internals.buildNextRouterStateTree(url),
        "Content-Type": "text/plain;charset=UTF-8",
      },
      body: JSON.stringify([{ episode_id: episodeId }]),
    });
    actionProbe = { action_id: actionId, status: actionResponse.status, body_prefix: (await actionResponse.text()).slice(0, 1200) };
  }
  const analysis = await adapter.analyze(url, "detail");
  const extraction = await adapter.extractStream(url);
  console.log(JSON.stringify({ adapter: adapter.id, http_status: response.status, bytes: html.length, episode_id: episodeId, actionProbe, episode_count: analysis.episodes.length, extraction }, null, 2));
})().catch((error) => {
  console.error(String((error as Error)?.message || error));
  process.exitCode = 1;
});
