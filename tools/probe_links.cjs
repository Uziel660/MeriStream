// Get a FRESH goodstream URL from the DB
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find any episode link that points to goodstream
  const links = await prisma.sourceLink.findMany({
    where: { url: { contains: 'goodstream' } },
    take: 5,
  });
  console.log('Goodstream links in DB:');
  links.forEach(l => console.log(l.url));
  
  // Also find lamovie.org episode links
  const laMovieLinks = await prisma.sourceLink.findMany({
    where: { source_site: 'lamovie.org' },
    take: 5,
  });
  console.log('\nLaMovie links:');
  laMovieLinks.forEach(l => console.log(l.url));
  
  // Also check for acek-cdn (direct HLS from tioplus)
  const acekLinks = await prisma.sourceLink.findMany({
    where: { url: { contains: 'acek-cdn' } },
    take: 5,
    orderBy: { last_checked: 'desc' }
  });
  console.log('\nAcek-CDN links (newest):');
  acekLinks.forEach(l => console.log(l.url, '|', l.last_checked));
}

main().finally(() => prisma.$disconnect());
