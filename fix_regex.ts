import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('server/metadataEngine.ts', 'utf-8');
content = content.replace(/\.replace\(\/\ns\*\n\/g, "\\n"\)/g, '.replace(/\\n\\s*\\n/g, "\\n")');
writeFileSync('server/metadataEngine.ts', content, 'utf-8');
