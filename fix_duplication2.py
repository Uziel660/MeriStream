import os

with open('server/metadataEngine.ts', 'r') as f:
    content = f.read()

new_anime_res = """
  const createAnimeResponse = (title: string, poster: string, cover: string, status: string, attr: any) => {
    return {
      title: attr.canonicalTitle || attr.titles?.en_jp || attr.titles?.en || title,
      original_title: attr.titles?.ja_jp || undefined,
      description: attr.synopsis ? sanitizeHtml(attr.synopsis, { allowedTags: [] }).trim() : "Sin descripción disponible.",
      poster_url: poster,
      banner_url: cover,
      rating: attr.averageRating ? Math.round((parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
      year: attr.startDate ? parseInt(attr.startDate.slice(0, 4), 10) : 2024,
      status: status === "current" ? "En emisión" : "Finalizado",
      genres: ["Anime"],
      content_type: "anime" as ContentKind,
    };
  };
"""

content = content.replace("export async function enrichUniversalMetadata(", new_anime_res + "\nexport async function enrichUniversalMetadata(")

content = content.replace("""        return {
          title: attr.canonicalTitle || attr.titles?.en_jp || attr.titles?.en || query,
          original_title: attr.titles?.ja_jp || undefined,
          description: attr.synopsis ? sanitizeHtml(attr.synopsis, { allowedTags: [] }).trim() : "Sin descripción disponible.",
          poster_url: poster,
          banner_url: cover,
          rating: attr.averageRating ? Math.round((parseFloat(attr.averageRating) / 10) * 10) / 10 : 8.0,
          year: attr.startDate ? parseInt(attr.startDate.slice(0, 4), 10) : 2024,
          status: attr.status === "current" ? "En emisión" : "Finalizado",
          genres: ["Anime"],
          content_type: "anime",
        };""", "        return createAnimeResponse(query, poster, cover, attr.status, attr);")

with open('server/metadataEngine.ts', 'w') as f:
    f.write(content)

print("done")
