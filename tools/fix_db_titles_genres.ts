import { prisma } from '../server/db';
import { cleanSlugToWords } from '../server/utils/titleNormalizer';
import { translateGenresToEs } from '../server/metadataEngine';

function toTitleCase(str: string): string {
  return str.replace(
    /\w\S*/g,
    (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()
  );
}

function fixTitle(originalTitle: string): { newTitle: string; titleChanged: boolean } {
  let newTitle = originalTitle;
  let titleChanged = false;

  if (!newTitle.includes(" ") && newTitle.length >= 8) {
    let processed = newTitle.replace(/([a-z])([A-Z])/g, '$1 $2');

    if (!processed.includes(" ")) {
      const cleaned = cleanSlugToWords(processed);
      if (cleaned && cleaned.toLowerCase() !== processed.toLowerCase()) {
        processed = cleaned;
      }
    }

    if (processed !== newTitle) {
      newTitle = toTitleCase(processed);
      titleChanged = true;
    }
  }

  return { newTitle, titleChanged };
}

function fixGenres(originalGenres: unknown): { newGenresStr: string; genresChanged: boolean } {
  let currentGenres: string[] = [];

  if (typeof originalGenres === 'string') {
    try {
      const parsed = JSON.parse(originalGenres);
      if (Array.isArray(parsed)) {
        currentGenres = parsed.map((genre) => String(genre).trim());
      } else if (typeof parsed === 'string') {
        currentGenres = parsed.split(',').map((genre) => genre.trim());
      } else if (parsed != null) {
        currentGenres = [String(parsed).trim()];
      }
    } catch {
      currentGenres = originalGenres.split(',').map(g => g.trim());
    }
  } else if (Array.isArray(originalGenres)) {
    currentGenres = originalGenres as string[];
  }

  currentGenres = currentGenres.filter(Boolean);
  const newGenresList = translateGenresToEs(currentGenres);
  const genresChanged = JSON.stringify(currentGenres) !== JSON.stringify(newGenresList);

  return { newGenresStr: newGenresList.join(', '), genresChanged };
}

async function run(): Promise<void> {
  console.log("Starting DB titles and genres repair...");
  
  const shows = await prisma.show.findMany({
    select: { id: true, title: true, genres: true }
  });
  
  let titlesFixed = 0;
  let genresFixed = 0;
  
  for (const show of shows) {
    const { newTitle, titleChanged } = fixTitle(show.title);
    const { newGenresStr, genresChanged } = fixGenres(show.genres);
    
    if (titleChanged || genresChanged) {
      const updateData: Record<string, string> = {};
      if (titleChanged) updateData.title = newTitle;
      if (genresChanged) updateData.genres = newGenresStr;
      
      console.log(`Updating ${show.title}...`);
      if (titleChanged) console.log(`  Title: -> ${newTitle}`);
      if (genresChanged) console.log(`  Genres: -> ${newGenresStr}`);
      
      await prisma.show.update({
        where: { id: show.id },
        data: updateData
      });
      
      if (titleChanged) titlesFixed++;
      if (genresChanged) genresFixed++;
    }
  }
  
  console.log(`\nFinished! Fixed ${titlesFixed} titles and ${genresFixed} genres.`);
}

run()
  .catch((error) => {
    console.error("Migration failed:", error);
  })
  .finally(() => {
    // Sonarcloud might complain about floating promise if void is missing.
    // We already use void or just await.
    prisma.$disconnect().catch(() => {});
  });
