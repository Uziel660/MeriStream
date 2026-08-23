import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
    const shows = await prisma.show.findMany({
        where: {
            title: {
                contains: "Sword Art"
            }
        },
        include: {
            episodes: true
        }
    });
    console.log(`Found ${shows.length} shows`);
    for (const show of shows) {
        console.log(`- ${show.title} (episodes: ${show.episodes.length})`);
    }
}

main().catch(console.error).finally(() => prisma.$disconnect());
