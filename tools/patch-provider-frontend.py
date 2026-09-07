from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"expected block not found in {path}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/App.tsx",
    '''    try {
      const res = await fetch(`/api/v1/play/${episode.id}`);
      if (res.status === 404) {
        // Episodio huérfano (#2/R2): eliminar de "Seguir Viendo" y avisar sin error crudo
        removeContinueWatchingItem(episode.id);
        setPlayingStreamData((prev: any) =>
          prev?.episodeId === episode.id ? null : prev
        );
        setOrphanNotice(
          `"${showTitle} — ${resolvedTitle}" ya no está disponible en el catálogo y fue eliminado de Seguir Viendo.`
        );
        return;
      }
      if (!res.ok) throw new Error('No se pudo resolver el video');
      const data = await res.json();

      // 2. Transición fluida con los streams listos
      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          title: `${showTitle} - ${resolvedTitle}`,
          streamUrl: data.stream_url,
          all_streams: data.all_available_streams,
          ranked_streams: data.ranked_streams,
          isLoading: false,
        };
      });
    } catch (e: any) {
''',
    '''    try {
      const tmdbId = Number((currentShow as any)?.tmdb_id || 0);
      const rawCategory = String((currentShow as any)?.kind || currentShow?.category || '').toLowerCase();
      const gatewayKind = rawCategory.includes('anime')
        ? 'anime'
        : (rawCategory.includes('movie') || rawCategory.includes('pel'))
          ? 'movie'
          : 'series';
      const seasonNumber = Number((episode as any).season_number || 1);
      const gatewayUrl = tmdbId > 0
        ? `/api/v1/providers/${gatewayKind}/${tmdbId}?season=${seasonNumber}&episode=${episode.episode_number}&audio=es,en,ja&subtitles=es,en`
        : null;

      const gatewayPromise = gatewayUrl
        ? fetch(gatewayUrl).then(async (response) => response.ok ? response.json() : null).catch(() => null)
        : Promise.resolve(null);
      const legacyPromise = fetch(`/api/v1/play/${episode.id}`).catch(() => null);
      const [gatewayData, legacyResponse] = await Promise.all([gatewayPromise, legacyPromise]);

      const gatewayRanked = Array.isArray(gatewayData?.sources)
        ? gatewayData.sources.map((source: any, index: number) => {
            let host: string | null = null;
            try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch {}
            return {
              url: source.url,
              type: 'direct' as const,
              tier: index,
              host,
              provider: source.provider,
              source_site: source.provider,
              requiredHeaders: source.requiredHeaders,
              rating: 10,
              link_type: source.audioLanguage ? 'audio' : undefined,
              language: source.audioLanguage || undefined,
              audio_language: source.audioLanguage || undefined,
              subtitle_language: source.subtitleLanguage || undefined,
              subtitles: Array.isArray(source.subtitles)
                ? source.subtitles.map((track: any, trackIndex: number) => ({
                    id: `${source.provider || 'api'}-${trackIndex}`,
                    label: track.label || track.language || 'Subtítulo',
                    language: track.language || 'und',
                    url: track.url,
                    is_default: false,
                  }))
                : [],
            };
          })
        : [];

      let legacyData: any = null;
      if (legacyResponse?.ok) legacyData = await legacyResponse.json();

      const mergedRanked: any[] = [];
      const seenUrls = new Set<string>();
      for (const candidate of [
        ...gatewayRanked,
        ...(Array.isArray(legacyData?.ranked_streams) ? legacyData.ranked_streams : []),
      ]) {
        if (!candidate?.url || seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        mergedRanked.push(candidate);
      }

      const mergedStreams = mergedRanked.map((candidate) => candidate.url);
      const primaryStream = mergedStreams[0] || legacyData?.stream_url || '';

      if (!primaryStream) {
        if (legacyResponse?.status === 404) {
          removeContinueWatchingItem(episode.id);
          setPlayingStreamData((prev: any) =>
            prev?.episodeId === episode.id ? null : prev
          );
          setOrphanNotice(
            `"${showTitle} — ${resolvedTitle}" ya no está disponible en el catálogo y fue eliminado de Seguir Viendo.`
          );
          return;
        }
        throw new Error('No se encontró un stream directo ni un fallback reproducible');
      }

      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          title: `${showTitle} - ${resolvedTitle}`,
          streamUrl: primaryStream,
          all_streams: mergedStreams.length > 0 ? mergedStreams : [primaryStream],
          ranked_streams: mergedRanked,
          isLoading: false,
        };
      });
    } catch (e: any) {
''',
)

replace_once(
    "src/types.ts",
    '''export interface Episode {
  id: string;
  show_id?: string;
  title: string;
  episode_number: number;
''',
    '''export interface Episode {
  id: string;
  show_id?: string;
  title: string;
  episode_number: number;
  season_number?: number;
''',
)

replace_once(
    "src/types.ts",
    '''export interface Show {
  id: string;
  title: string;
''',
    '''export interface Show {
  id: string;
  title: string;
  tmdb_id?: number | null;
  anilist_id?: string | null;
  mal_id?: number | null;
''',
)
