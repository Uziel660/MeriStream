type GatewayKind = "movie" | "series" | "anime";

export interface TioPlusEpisodeRequest {
  kind: GatewayKind;
  season?: number;
  episode?: number;
}

/**
 * TioPlus episode pages carry their identity in the URL. Historical imports
 * sometimes attached links from several seasons to one MediaEpisode row, so a
 * page is usable only when its coordinates match the requested playback.
 */
export function tioPlusEpisodeLocatorMatches(url: string, req: TioPlusEpisodeRequest): boolean {
  if (req.kind === "movie") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (!/(?:^|\.)tioplus\.app$/i.test(parsed.hostname)) return true;
  const match = parsed.pathname.match(/\/(?:serie|anime|dorama)\/[^/]+\/season\/(\d+)\/episode\/(\d+)\/?$/i);
  if (!match) return false;
  const requestedSeason = Number(req.season || 1);
  const requestedEpisode = Number(req.episode || 1);
  return Number(match[1]) === requestedSeason && Number(match[2]) === requestedEpisode;
}

