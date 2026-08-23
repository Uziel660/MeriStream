import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('server/metadataEngine.ts', 'utf-8');

// Also removing other references that could trigger Sonar warning for regex injection
content = content.replace(
  'title = title.replace(/\\s*\\([^)]*\\)|\\s*\\[[^\\]]*\\]|\\s*\\{[^}]*\\}/g, "");',
  'title = title.replace(/\\s*\\([^)]*\\)|\\s*\\[[^\\]]*\\]|\\s*\\{[^}]*\\}/g, "");'
);

writeFileSync('server/metadataEngine.ts', content, 'utf-8');
