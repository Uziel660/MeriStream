import { readFileSync, writeFileSync } from 'fs';

let content = readFileSync('src/components/MediaDetailsModal.tsx', 'utf-8');

// Enhance the episodes display to be a grid instead of a long single column list, to make it easier to visualize
// Reemplazar la renderización de los episodios (div class="space-y-2 max-h-[420px] overflow-y-auto pr-1")
content = content.replace(
  '<div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">',
  '<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-[420px] overflow-y-auto pr-1">'
);

writeFileSync('src/components/MediaDetailsModal.tsx', content, 'utf-8');
