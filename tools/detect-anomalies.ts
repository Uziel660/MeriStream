import { PrismaClient } from "@prisma/client";

const p = new PrismaClient();

interface Anomaly {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  category: string;
  entity_type: 'show' | 'episode';
  entity_id: string;
  entity_title: string;
  detail: string;
}

async function detectAnomalies() {
  await p.$connect();
  
  const anomalies: Anomaly[] = [];
  
  console.log('=== ANOMALY DETECTION SCAN ===\n');
  
  // Get all shows with counts
  const shows = await p.show.findMany({
    select: {
      id: true, title: true, description: true, poster_url: true,
      backdrop_path: true, category: true, genres: true, year: true,
      _count: { select: { episodes: true } }
    }
  });
  
  console.log(`Scanning ${shows.length} shows...\n`);
  
  for (const show of shows) {
    const desc = (show.description || '').trim();
    
    // CRITICAL: Empty title
    if (!show.title || show.title.trim() === '') {
      anomalies.push({
        severity: 'CRITICAL', category: 'title', entity_type: 'show',
        entity_id: show.id, entity_title: show.title || '(vacío)',
        detail: 'Título vacío'
      });
    }
    
    // CRITICAL: Title is "undefined" or "null"
    if (/^(undefined|null|test|sample)$/i.test(show.title)) {
      anomalies.push({
        severity: 'CRITICAL', category: 'title', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: `Título es placeholder: "${show.title}"`
      });
    }
    
    // HIGH: Description is placeholder
    if (/^obra multimedia indexada/i.test(desc) || 
        /^importado de/i.test(desc) ||
        /^sinopsis no disponible/i.test(desc) ||
        desc === '') {
      anomalies.push({
        severity: 'HIGH', category: 'metadata', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: `Descripción placeholder: "${desc || '(vacío)'}"`
      });
    }
    
    // HIGH: Description too short (<30 chars but not empty)
    if (desc.length > 0 && desc.length < 30) {
      anomalies.push({
        severity: 'HIGH', category: 'metadata', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: `Descripción muy corta (${desc.length} chars): "${desc}"`
      });
    }
    
    // MEDIUM: No poster URL
    if (!show.poster_url || show.poster_url === '') {
      anomalies.push({
        severity: 'MEDIUM', category: 'image', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: 'Sin poster URL'
      });
    }
    
    // MEDIUM: Poster URL is relative path
    if (show.poster_url && !show.poster_url.startsWith('http')) {
      anomalies.push({
        severity: 'MEDIUM', category: 'image', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: `Poster URL relativa: "${show.poster_url}"`
      });
    }
    
    // MEDIUM: No backdrop
    if (!show.backdrop_path) {
      anomalies.push({
        severity: 'MEDIUM', category: 'image', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: 'Sin backdrop_path'
      });
    }
    
    // HIGH: 0 episodes
    if (show._count.episodes === 0) {
      anomalies.push({
        severity: 'HIGH', category: 'content', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: 'Show sin episodios (vacío)'
      });
    }
    
    // LOW: Only 1 episode (possibly incomplete)
    if (show._count.episodes === 1 && show.category !== 'movie') {
      anomalies.push({
        severity: 'LOW', category: 'content', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: 'Solo 1 episodio (¿incompleto?)'
      });
    }
    
    // MEDIUM: No genres
    if (!show.genres || show.genres === '' || show.genres === '[]') {
      anomalies.push({
        severity: 'MEDIUM', category: 'metadata', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: 'Sin géneros asignados'
      });
    }
    
    // LOW: No year
    if (!show.year || show.year === 0) {
      anomalies.push({
        severity: 'LOW', category: 'metadata', entity_type: 'show',
        entity_id: show.id, entity_title: show.title,
        detail: 'Sin año asignado'
      });
    }
  }
  
  // Check for duplicate titles
  const titleCounts: Record<string, number> = {};
  for (const show of shows) {
    const key = show.title.toLowerCase().trim();
    titleCounts[key] = (titleCounts[key] || 0) + 1;
  }
  for (const [title, count] of Object.entries(titleCounts)) {
    if (count > 1) {
      const dupes = shows.filter(s => s.title.toLowerCase().trim() === title);
      anomalies.push({
        severity: 'MEDIUM', category: 'duplicate', entity_type: 'show',
        entity_id: dupes[0].id, entity_title: title,
        detail: `${count} shows con título identical: "${title}"`
      });
    }
  }
  
  // Check episodes without source_url
  const epsNoSource = await p.$queryRawUnsafe<{count: number}[]>(
    `SELECT COUNT(*)::int as count FROM "Episode" WHERE source_url IS NULL OR source_url = ''`
  );
  const epsNoSourceCount = epsNoSource[0]?.count ?? 0;
  if (epsNoSourceCount > 0) {
    anomalies.push({
      severity: 'HIGH', category: 'content', entity_type: 'episode',
      entity_id: '(global)', entity_title: `${epsNoSourceCount} episodes`,
      detail: `${epsNoSourceCount} episodios sin source_url`
    });
  }
  
  // Sort by severity
  const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  
  // Report
  const critical = anomalies.filter(a => a.severity === 'CRITICAL');
  const high = anomalies.filter(a => a.severity === 'HIGH');
  const medium = anomalies.filter(a => a.severity === 'MEDIUM');
  const low = anomalies.filter(a => a.severity === 'LOW');
  
  console.log('=== SEVERITY SUMMARY ===');
  console.log(`CRITICAL: ${critical.length}`);
  console.log(`HIGH:     ${high.length}`);
  console.log(`MEDIUM:   ${medium.length}`);
  console.log(`LOW:      ${low.length}`);
  console.log(`TOTAL:    ${anomalies.length}\n`);
  
  // Category breakdown
  const byCategory: Record<string, number> = {};
  for (const a of anomalies) {
    byCategory[a.category] = (byCategory[a.category] || 0) + 1;
  }
  console.log('=== BY CATEGORY ===');
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  
  // Show top anomalies
  console.log('\n=== CRITICAL ANOMALIES ===');
  for (const a of critical.slice(0, 20)) {
    console.log(`  [${a.severity}] ${a.entity_title} → ${a.detail}`);
  }
  
  console.log('\n=== HIGH ANOMALIES (sample) ===');
  for (const a of high.slice(0, 30)) {
    console.log(`  [${a.severity}] ${a.entity_title} → ${a.detail}`);
  }
  
  console.log('\n=== MEDIUM ANOMALIES (sample) ===');
  for (const a of medium.slice(0, 20)) {
    console.log(`  [${a.severity}] ${a.entity_title} → ${a.detail}`);
  }
  
  // Save full report to JSON
  const report = {
    scan_date: new Date().toISOString(),
    total_shows: shows.length,
    summary: { critical: critical.length, high: high.length, medium: medium.length, low: low.length, total: anomalies.length },
    by_category: byCategory,
    anomalies
  };
  
  const fs = await import('fs');
  fs.writeFileSync('data/anomaly-report.json', JSON.stringify(report, null, 2));
  console.log(`\nFull report saved to data/anomaly-report.json`);
  
  await p.$disconnect();
}

detectAnomalies().catch(console.error);
