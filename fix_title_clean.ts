import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('server/metadataEngine.ts', 'utf-8');

// The original cleanQueryTitle function:
content = content.replace(
  'title = title.replace(/^(?:Ver\\s+Online|Ver|Pelicula|Película|Serie|Anime|Ova|Donghua|Watch|Full\\s+Movie)\\s+/i, "");',
  'title = title.replace(/^(?:Ver\\s+Online|Ver|Pelicula|Película|Serie|Anime|Ova|Donghua|Watch|Full\\s+Movie|Episodios\\s+de)\\s+/i, "");'
);

writeFileSync('server/metadataEngine.ts', content, 'utf-8');
