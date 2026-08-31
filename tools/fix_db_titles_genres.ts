import { prisma } from '../server/db';
import { splitConcatenatedWords } from '../server/utils/titleNormalizer';
import { translateGenresToEs } from '../server/metadataEngine';

function toTitleCase(str: string): string {
  return str.replace(
    /\w\S*/g,
    (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  );
}

async function run() {
  console.log("Starting DB titles and genres repair...");
  
  const shows = await prisma.show.findMany({
    select: { id: true, title: true, genres: true }
  });
  
  let titlesFixed = 0;
  let genresFixed = 0;
  
  for (const show of shows) {
    let titleChanged = false;
    let newTitle = show.title;
    
    // Fix squashed titles
    if (!newTitle.includes(" ") && newTitle.length >= 8) {
      const lower = newTitle.toLowerCase();
      // splitConcatenatedWords returns lowercase spaced words
      const split = splitConcatenatedWords(lower);
      if (split !== lower) {
        newTitle = toTitleCase(split);
        titleChanged = true;
      }
    }
    
    // Fix genres
    let currentGenres: string[] = [];
    if (typeof show.genres === 'string') {
      try {
        currentGenres = JSON.parse(show.genres);
        if (!Array.isArray(currentGenres)) currentGenres = [show.genres];
      } catch {
        currentGenres = (show.genres as string).split(',').map(g => g.trim());
      }
    } else if (Array.isArray(show.genres)) {
      currentGenres = show.genres;
    }
    
    // Translate and split genres (this uses the updated GENRE_ES_ALIASES)
    const newGenres = translateGenresToEs(currentGenres);
    
    // Check if genres actually changed
    const genresChanged = JSON.stringify(currentGenres) !== JSON.stringify(newGenres);
    
    if (titleChanged || genresChanged) {
      const updateData: any = {};
      if (titleChanged) updateData.title = newTitle;
      // In Prisma with SQLite, we might need to JSON stringify it if the schema is String, 
      // but Prisma Client usually handles it if the schema says String. 
      // Actually, if the schema says String, we should pass a string. 
      // Let's check how it's defined:
      // Wait, in my previous script task-976, `s.genres.join` threw an error because it's a string!
      // This means the schema defines it as `String`, and we should pass a string.
      // But wait! `s.genres` was `Acción, Aventura`. Not a JSON string!
      if (genresChanged) {
        updateData.genres = newGenres.join(', ');
      }
      
      console.log(`Updating ${show.title}...`);
      if (titleChanged) console.log(`  Title: -> ${newTitle}`);
      if (genresChanged) console.log(`  Genres: -> ${newGenres.join(', ')}`);
      
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

run().catch(console.error).finally(() => prisma.$disconnect());
