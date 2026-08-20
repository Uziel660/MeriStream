import os

file_path = 'server/showService.ts'
with open(file_path, 'r') as f:
    content = f.read()

# Refactor the saveShowWithDeduplication cognitive complexity and lines
new_func = """
function applyEnrichedMetadata(target: any, enriched: any) {
  if (!enriched) return;
  if (enriched.mal_id) target.malId = enriched.mal_id;
  if (enriched.anilist_id) target.anilistId = enriched.anilist_id;
  if (enriched.title) target.title = enriched.title;
  if (enriched.japanese_title) target.japaneseTitle = enriched.japanese_title;
  if (enriched.english_title) target.englishTitle = enriched.english_title;
  if (enriched.description && enriched.description.length > 20) target.description = enriched.description;
  if (enriched.poster_url) target.posterUrl = enriched.poster_url;
  if (enriched.banner_url) target.bannerUrl = enriched.banner_url || enriched.poster_url;
  if (enriched.rating) target.rating = enriched.rating;
  if (enriched.year) target.year = enriched.year;
  if (enriched.status) target.status = enriched.status;
  if (enriched.genres && enriched.genres.length > 0) target.genresStr = enriched.genres.join(", ");
}

export async function saveShowWithDeduplication(input: SaveShowInput) {
  let rawTitle = cleanQueryTitle(input.title);
  let kind: ContentKind = (input.content_type || input.category || "anime") as ContentKind;

  let showData = {
    malId: input.mal_id || null,
    anilistId: input.anilist_id || null,
    title: input.title,
    japaneseTitle: input.japanese_title || null,
    englishTitle: input.english_title || null,
    description: input.description || "",
    posterUrl: input.poster_url || null,
    bannerUrl: input.banner_url || null,
    rating: input.rating || 8.0,
    year: input.year || new Date().getFullYear(),
    status: input.status || "Finalizado",
    genresStr: Array.isArray(input.genres) ? input.genres.join(", ") : (input.genres || "Multimedia")
  };

  try {
    const enriched = await enrichUniversalMetadata(rawTitle, kind);
    applyEnrichedMetadata(showData, enriched);
  } catch (e) {
    console.error("Enrichment warning during deduplication:", e);
  }

  const normTitle = normalizeTitle(showData.title);
  const normJap = showData.japaneseTitle ? normalizeTitle(showData.japaneseTitle) : "";
  const normEng = showData.englishTitle ? normalizeTitle(showData.englishTitle) : "";
"""

content = content.replace("""export async function saveShowWithDeduplication(input: SaveShowInput) {
  let rawTitle = cleanQueryTitle(input.title);
  let kind: ContentKind = (input.content_type || input.category || "anime") as ContentKind;

  // 1. Mandatory Enrichment via AniList / Jikan MAL if metadata is incomplete or missing mal_id
  let malId = input.mal_id || null;
  let anilistId = input.anilist_id || null;
  let title = input.title;
  let japaneseTitle = input.japanese_title || null;
  let englishTitle = input.english_title || null;
  let description = input.description || "";
  let posterUrl = input.poster_url || null;
  let bannerUrl = input.banner_url || null;
  let rating = input.rating || 8.0;
  let year = input.year || new Date().getFullYear();
  let status = input.status || "Finalizado";
  let genresStr = Array.isArray(input.genres) ? input.genres.join(", ") : (input.genres || "Multimedia");

  try {
    const enriched = await enrichUniversalMetadata(rawTitle, kind);
    if (enriched) {
      if (enriched.mal_id) malId = enriched.mal_id;
      if (enriched.anilist_id) anilistId = enriched.anilist_id;
      if (enriched.title) title = enriched.title;
      if (enriched.japanese_title) japaneseTitle = enriched.japanese_title;
      if (enriched.english_title) englishTitle = enriched.english_title;
      if (enriched.description && enriched.description.length > 20) description = enriched.description;
      if (enriched.poster_url) posterUrl = enriched.poster_url;
      if (enriched.banner_url) bannerUrl = enriched.banner_url || enriched.poster_url;
      if (enriched.rating) rating = enriched.rating;
      if (enriched.year) year = enriched.year;
      if (enriched.status) status = enriched.status;
      if (enriched.genres && enriched.genres.length > 0) genresStr = enriched.genres.join(", ");
    }
  } catch (e) {
    console.error("Enrichment warning during deduplication:", e);
  }

  const normTitle = normalizeTitle(title);
  const normJap = japaneseTitle ? normalizeTitle(japaneseTitle) : "";
  const normEng = englishTitle ? normalizeTitle(englishTitle) : "";""", new_func)

# Fix the variable references in the rest of the function
content = content.replace("mal_id: malId,", "mal_id: showData.malId,")
content = content.replace("anilist_id: anilistId,", "anilist_id: showData.anilistId,")
content = content.replace("title: title,", "title: showData.title,")
content = content.replace("japanese_title: japaneseTitle,", "japanese_title: showData.japaneseTitle,")
content = content.replace("english_title: englishTitle,", "english_title: showData.englishTitle,")
content = content.replace("description: description,", "description: showData.description,")
content = content.replace("poster_url: posterUrl,", "poster_url: showData.posterUrl,")
content = content.replace("banner_url: bannerUrl,", "banner_url: showData.bannerUrl,")
content = content.replace("rating: rating,", "rating: showData.rating,")
content = content.replace("year: year,", "year: showData.year,")
content = content.replace("status: status,", "status: showData.status,")
content = content.replace("genres: genresStr,", "genres: showData.genresStr,")
content = content.replace("malId", "showData.malId")
content = content.replace("anilistId", "showData.anilistId")
content = content.replace("title'", "showData.title'")
content = content.replace("title.", "showData.title.")
content = content.replace("let dbShow = await prisma.show.findFirst({", "let dbShow = await prisma.show.findFirst({")
content = content.replace("console.log(`[Deduplication] Nueva obra verificada sin duplicados: '${title}'. Guardando en PostgreSQL...`);", "console.log(`[Deduplication] Nueva obra verificada sin duplicados: '${showData.title}'. Guardando en PostgreSQL...`);")
content = content.replace("  let dbShow", "  let dbShow")

with open(file_path, 'w') as f:
    f.write(content)
print("done")
