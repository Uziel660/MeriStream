import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('server/metadataEngine.ts', 'utf-8');

// The typescript checking error indicates the missing error catching issue reported in the linter
content = content.replace(
  /} catch \(e\) {/g,
  '} catch {'
);

writeFileSync('server/metadataEngine.ts', content, 'utf-8');
