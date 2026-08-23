import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('server/metadataEngine.ts', 'utf-8');
content = content.replace(/const createAnimeResponse = \(title: string, poster: string, cover: string, status: string, attr: any\) => \{/g,
  'const createAnimeResponse = async (title: string, poster: string, cover: string, status: string, attr: any) => {');
writeFileSync('server/metadataEngine.ts', content, 'utf-8');
