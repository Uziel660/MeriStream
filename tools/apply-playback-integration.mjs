import fs from 'node:fs';

function replaceExactlyOnce(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first < 0) throw new Error(`${label}: expected source fragment was not found`);
  if (source.indexOf(oldValue, first + oldValue.length) >= 0) {
    throw new Error(`${label}: source fragment is not unique`);
  }
  return source.slice(0, first) + newValue + source.slice(first + oldValue.length);
}

const appPath = 'src/App.tsx';
let app = fs.readFileSync(appPath, 'utf8');

const appImportAnchor = "import { displayEpisodeTitle } from './utils/episodeLabels';";
if (!app.includes("from './utils/playbackBootstrap'")) {
  app = replaceExactlyOnce(
    app,
    appImportAnchor,
    `${appImportAnchor}\nimport { createPlaybackRequests } from './utils/playbackBootstrap';`,
    'App playback bootstrap import',
  );
}

const handlerStartMarker = '  const handleSelectEpisode = async (episode: Episode, showTitle: string) => {';
const handlerEndMarker = '\n  // Conteo de shows por género para el modal';
const handlerStart = app.indexOf(handlerStartMarker);
const handlerEnd = handlerStart >= 0 ? app.indexOf(handlerEndMarker, handlerStart) : -1;
if (handlerStart < 0 || handlerEnd < 0) {
  throw new Error('App playback handler markers were not found');
}

const nextHandler = `  const handleSelectEpisode = async (episode: Episode, showTitle: string) => {
    const showId = episode.show_id || selectedShowId || 'unknown';
    // La tarjeta de búsqueda puede proceder del lote server-side y no estar
    // todavía en \`shows\`; conserva sus IDs canónicos para activar gateway y
    // subtítulos igual que una tarjeta del catálogo principal.
    const currentShow = shows.find((s) => s.id === showId)
      || serverSearchResults.find((s) => s.id === showId);
    const existingProgress = continueWatchingItems.find(p => p.showId === showId && p.episodeId === episode.id);
    const initialTime = existingProgress?.currentTime || 0;

    // Abrir el reproductor inmediatamente. El bootstrap de fuentes y la
    // búsqueda externa de subtítulos continúan en paralelo.
    setPlayingStreamData({
      title: \`${'${showTitle}'} - ${'${safeEpisodeTitle(episode)}'}\`,
      streamUrl: '',
      all_streams: [],
      initialTime,
      showId,
      showTitle,
      showPoster: (currentShow && thumbBackdropUrl(currentShow)) || undefined,
      episodeId: episode.id,
      episodeNumber: episode.episode_number,
      episodeTitle: safeEpisodeTitle(episode),
      isLoading: true,
    });

    const resolvedTitle = safeEpisodeTitle(episode);

    try {
      const rawCategory = String((currentShow as any)?.kind || currentShow?.category || '').toLowerCase();
      const sourceHint = String((episode as any)?.source_url || '').toLowerCase();
      const gatewayKind = rawCategory.includes('anime') || sourceHint.startsWith('tmdb://anime/')
        ? 'anime'
        : (rawCategory.includes('movie') || rawCategory.includes('pel') || sourceHint.startsWith('tmdb://movie/'))
          ? 'movie'
          : 'series';

      const playbackShow: Show = currentShow || {
        id: showId,
        title: showTitle,
        category: gatewayKind,
        kind: gatewayKind,
      };
      const preferences = getAppPreferences(user?.id);
      const playbackRequests = createPlaybackRequests({
        show: playbackShow,
        episode,
        kind: gatewayKind,
        preferredAudio: preferences.preferredLanguages,
        preferredSubtitles: preferences.preferredSubtitleLanguages,
      });

      // OpenSubtitles y equivalentes no forman parte de la ruta crítica. Si
      // llegan después de iniciar el video se anexan al player sin reiniciarlo.
      void playbackRequests.subtitles
        .then(({ data: subtitleData }) => {
          const externalSubtitles = Array.isArray(subtitleData?.tracks)
            ? subtitleData.tracks
                .map((track: any, index: number) => mapInternalSubtitleTrack(track, String(track.id || \`opensubtitles-${'${index}'}\`)))
                .filter(Boolean)
            : [];
          if (externalSubtitles.length === 0) return;

          setPlayingStreamData((prev: any) => {
            if (!prev || prev.episodeId !== episode.id) return prev;
            const byUrl = new Map<string, any>();
            for (const track of Array.isArray(prev.subtitleTracks) ? prev.subtitleTracks : []) {
              if (track?.url) byUrl.set(track.url, track);
            }
            for (const track of externalSubtitles) {
              if (track?.url && !byUrl.has(track.url)) byUrl.set(track.url, track);
            }
            return { ...prev, subtitleTracks: [...byUrl.values()] };
          });
        })
        .catch(() => undefined);

      const { gatewayData, legacyData, legacyStatus } = await playbackRequests.core;

      // Un gateway puede devolver muchos mirrors del mismo proveedor. Limitar
      // a tres mantiene failover real sin convertir un host caído en tormenta.
      const gatewaySourceCount = new Map<string, number>();
      const gatewaySources = Array.isArray(gatewayData?.sources)
        ? gatewayData.sources.filter((source: any) => {
            const provider = String(source?.provider || 'api').toLowerCase();
            const count = gatewaySourceCount.get(provider) || 0;
            if (count >= 3) return false;
            gatewaySourceCount.set(provider, count + 1);
            return true;
          })
        : [];
      const gatewayRanked = gatewaySources.length > 0
        ? gatewaySources.map((source: any, index: number) => {
            let host: string | null = null;
            try { host = new URL(source.url).hostname.replace(/^www\\./, ''); } catch {}
            return {
              url: source.url,
              type: 'direct' as const,
              tier: index,
              host,
              provider: source.provider,
              source_site: source.provider,
              original_url: source.canonicalLocator || source.url,
              canonical_locator: source.canonicalLocator || source.url,
              is_proxyable: true,
              is_refreshable: Boolean(source.canonicalLocator),
              delivery_mode: source.requiredHeaders ? 'proxy_required' as const : 'direct_trial' as const,
              requiredHeaders: source.requiredHeaders,
              rating: 10,
              link_type: source.audioLanguage ? 'audio' : undefined,
              language: source.audioLanguage || undefined,
              audio_language: source.audioLanguage || undefined,
              subtitle_language: source.subtitleLanguage || undefined,
              subtitles: Array.isArray(source.subtitles)
                ? source.subtitles
                    .map((track: any, trackIndex: number) => mapInternalSubtitleTrack(track, \`${'${source.provider || \'api\'}'}-${'${trackIndex}'}\`))
                    .filter(Boolean)
                : [],
            };
          })
        : [];

      // Los locators canónicos siguen disponibles como fallback porque el
      // HLSPlayerModal los resuelve JIT mediante el adaptador especializado.
      const gatewayFallbacks = Array.isArray(gatewayData?.fallbackCandidates)
        ? gatewayData.fallbackCandidates.map((source: any, index: number) => {
            let host: string | null = null;
            try { host = new URL(source.url).hostname.replace(/^www\\./, ''); } catch {}
            return {
              url: source.url,
              type: 'embed' as const,
              tier: gatewayRanked.length + index,
              host,
              provider: source.provider,
              source_site: source.provider,
              canonical_locator: source.canonicalLocator || source.url,
              original_url: source.url,
              delivery_mode: 'embed' as const,
              is_refreshable: true,
              is_proxyable: false,
              requiredHeaders: undefined,
              link_type: source.type,
              language: source.audioLanguage || undefined,
              audio_language: source.audioLanguage || undefined,
              subtitle_language: source.subtitleLanguage || undefined,
              subtitles: Array.isArray(source.subtitles)
                ? source.subtitles
                    .map((track: any, trackIndex: number) => mapInternalSubtitleTrack(track, \`${'${source.provider || \'fallback\'}'}-${'${index}'}-${'${trackIndex}'}\`))
                    .filter(Boolean)
                : [],
            };
          })
        : [];

      const mergedRanked: any[] = [];
      const seenUrls = new Set<string>();
      for (const candidate of [
        ...gatewayRanked,
        ...gatewayFallbacks,
        ...(Array.isArray(legacyData?.ranked_streams) ? legacyData.ranked_streams : []),
      ]) {
        if (!candidate?.url || seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        mergedRanked.push(candidate);
      }

      const mergedStreams = mergedRanked.map((candidate) => candidate.url);
      const primaryStream = mergedStreams[0] || legacyData?.stream_url || '';

      if (!primaryStream) {
        // Las fichas públicas TMDB usan episodios virtuales y no deben borrarse
        // por un 404 de la tabla legacy. Las filas locales sí conservan la
        // limpieza de huérfanos histórica.
        const isPublicVirtualEpisode = /^tmdb-(?:movie|series|anime)-\\d+(?:-s\\d+-e\\d+)?$/i.test(String(episode.id || ''))
          || /^tmdb-(?:movie|series|anime)-\\d+$/i.test(String(currentShow?.id || ''));
        if (legacyStatus === 404 && !isPublicVirtualEpisode) {
          removeContinueWatchingItem(episode.id);
          setPlayingStreamData((prev: any) =>
            prev?.episodeId === episode.id ? null : prev
          );
          setOrphanNotice(
            \`"${'${showTitle}'} — ${'${resolvedTitle}'}" ya no está disponible en el catálogo y fue eliminado de Seguir Viendo.\`
          );
          return;
        }
        throw new Error('No se encontró un stream directo ni un fallback reproducible');
      }

      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          title: \`${'${showTitle}'} - ${'${resolvedTitle}'}\`,
          streamUrl: primaryStream,
          all_streams: mergedStreams.length > 0 ? mergedStreams : [primaryStream],
          ranked_streams: mergedRanked,
          isLoading: false,
        };
      });
    } catch (e: any) {
      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          loadError: e.message || 'Error al iniciar la reproducción',
          isLoading: false,
        };
      });
    }
  };
`;

app = app.slice(0, handlerStart) + nextHandler + app.slice(handlerEnd);
fs.writeFileSync(appPath, app);

const playerPath = 'src/components/HLSPlayerModal.tsx';
let player = fs.readFileSync(playerPath, 'utf8');
const playerImportAnchor = "import { APP_PREFERENCES_EVENT, getAppPreferences } from '../utils/appPreferences';";
if (!player.includes("from '../utils/playerLanguages'")) {
  player = replaceExactlyOnce(
    player,
    playerImportAnchor,
    `${playerImportAnchor}\nimport { normalizePlayerLanguage, playerLanguageLabel } from '../utils/playerLanguages';`,
    'HLS player language import',
  );
}

const oldLanguageHelpers = `function normalizedLanguageKey(value: unknown): string {
  const raw = String(value || '').trim().toLowerCase().replace('_', '-');
  if (!raw) return 'und';
  if (raw === 'es-419' || raw === 'es-la' || raw === 'lat' || raw === 'latino') return 'es-419';
  if (raw.startsWith('es')) return 'es';
  if (raw.startsWith('en')) return 'en';
  if (raw.startsWith('ja') || raw === 'dub') return raw === 'dub' ? 'dub' : 'ja';
  if (raw.startsWith('pt')) return 'pt';
  if (raw.startsWith('fr')) return 'fr';
  return raw;
}

function languageDisplayName(value: unknown): string {
  const key = normalizedLanguageKey(value);
  const labels: Record<string, string> = {
    'es-419': 'Español latino', es: 'Español', en: 'Inglés', ja: 'Japonés',
    pt: 'Portugués', fr: 'Francés', dub: 'Doblado', und: 'Idioma alternativo',
  };
  return labels[key] || String(value || 'Idioma alternativo').toUpperCase();
}`;
const newLanguageHelpers = `function normalizedLanguageKey(value: unknown): string {
  return normalizePlayerLanguage(value);
}

function languageDisplayName(value: unknown): string {
  return playerLanguageLabel(value);
}`;
if (player.includes(oldLanguageHelpers)) {
  player = replaceExactlyOnce(player, oldLanguageHelpers, newLanguageHelpers, 'HLS player language helpers');
} else if (!player.includes('return normalizePlayerLanguage(value);')) {
  throw new Error('HLS player language helpers are not in the expected state');
}

const oldRenditionLabels = `  if (audio) return \`Audio ${'${audio.toUpperCase()}'}\`;
  if (subtitle) return \`Subtítulos ${'${subtitle.toUpperCase()}'}\`;`;
const newRenditionLabels = `  if (audio) return \`Audio ${'${languageDisplayName(audio)}'}\`;
  if (subtitle) return \`Subtítulos ${'${languageDisplayName(subtitle)}'}\`;`;
if (player.includes(oldRenditionLabels)) {
  player = replaceExactlyOnce(player, oldRenditionLabels, newRenditionLabels, 'HLS rendition language labels');
}

fs.writeFileSync(playerPath, player);
console.log('Playback integration patch applied successfully.');
