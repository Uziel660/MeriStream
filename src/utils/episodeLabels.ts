/**
 * Etiqueta estable para mostrar un episodio sin alterar el título persistido.
 * Algunos catálogos concatenan el número de capítulo, temporada y fecha al
 * título durante la extracción (por ejemplo: "Capitulo 1S1.E117 de Mayo del
 * 2026"). Esos valores no son títulos editoriales útiles para el usuario.
 */
export function displayEpisodeTitle(
  title: string | null | undefined,
  episodeNumber: number | null | undefined,
): string {
  const clean = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : "";
  const fallback = Number.isFinite(episodeNumber) ? `Episodio ${episodeNumber}` : "Episodio";
  if (!clean || /^(?:undefined|null)$/i.test(clean)) return fallback;

  // Un título que solo repite el rótulo del capítulo no aporta información y
  // se presenta con la misma etiqueta que el resto de la lista.
  if (/^(?:cap[ií]tulo|chapter)\s*\d+$/i.test(clean)) return fallback;

  const hasEpisodeMarker = /^(?:cap[ií]tulo|episodio|episode)\s*\d+/i.test(clean);
  const hasSeasonEpisodeCode = /S\s*\d{1,2}\s*\.?\s*E\s*\d{1,4}\b/i.test(clean);
  const hasScrapeDate = /\bde\s+[a-záéíóúñ]+\s+del\s+\d{4}\b/i.test(clean);
  const onlyStructuralText = /^[\p{L}\p{N}\s.:-]+$/u.test(clean);

  // Solo ocultar el valor cuando hay señales convergentes de artefacto de
  // scraping. Un título legítimo como "Capítulo 1: La llegada" se conserva.
  if (hasEpisodeMarker && (hasSeasonEpisodeCode || hasScrapeDate) && onlyStructuralText) {
    return fallback;
  }

  return clean;
}
