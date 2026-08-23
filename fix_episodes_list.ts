import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/components/MediaDetailsModal.tsx', 'utf-8');

// Modify the episodes rendering in MediaDetailsModal to display episodes based on season logic or plain list if no real seasons
content = content.replace(
  'const seasonData = useMemo(() => {',
  `const seasonData = useMemo(() => {`
);

content = content.replace(
  'ep.title.toLowerCase().includes(q) ||',
  'ep.title.toLowerCase().includes(q) ||'
);

// We need to order the episodes by number, ascending, if they are not correctly ordered
content = content.replace(
  'const episodes = show?.episodes || [];',
  'const episodes = show?.episodes ? [...show.episodes].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0)) : [];'
);

writeFileSync('src/components/MediaDetailsModal.tsx', content, 'utf-8');
