#!/usr/bin/env node
// tools/add-fulltext-search.ts
// Agrega full-text search con tsvector + GIN index + pg_trgm a la tabla Show

import { PrismaClient } from "@prisma/client";
const pg = new PrismaClient();

async function main() {
  console.log("🔍 Agregando full-text search a PostgreSQL...\n");

  await pg.$connect();

  // 1. Habilitar extensión pg_trgm (fuzzy matching)
  console.log("1. Habilitando extensión pg_trgm...");
  await pg.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  console.log("   ✅ pg_trgm habilitado");

  // 2. Agregar columna search_vector
  console.log("2. Agregando columna search_vector...");
  await pg.$executeRawUnsafe(
    'ALTER TABLE "Show" ADD COLUMN IF NOT EXISTS search_vector tsvector'
  );
  console.log("   ✅ Columna search_vector agregada");

  // 3. Poblar search_vector con datos existentes
  console.log("3. Poblando search_vector...");
  await pg.$executeRawUnsafe(`
    UPDATE "Show" SET search_vector =
      setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
      setweight(to_tsvector('simple', coalesce("english_title", '')), 'A') ||
      setweight(to_tsvector('simple', coalesce("japanese_title", '')), 'B') ||
      setweight(to_tsvector('simple', coalesce("genres", '')), 'C') ||
      setweight(to_tsvector('simple', coalesce("description", '')), 'D')
  `);
  console.log("   ✅ search_vector poblado");

  // 4. Crear índice GIN para búsqueda full-text
  console.log("4. Creando índice GIN...");
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_search_vector ON "Show" USING GIN (search_vector)'
  );
  console.log("   ✅ Índice GIN creado");

  // 5. Crear índice trigram para fuzzy matching
  console.log("5. Creando índices trigram...");
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_title_trgm ON "Show" USING GIN (title gin_trgm_ops)'
  );
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_title_lower_trgm ON "Show" USING GIN (lower(title) gin_trgm_ops)'
  );
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_english_title_lower_trgm ON "Show" USING GIN (lower("english_title") gin_trgm_ops)'
  );
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_japanese_title_lower_trgm ON "Show" USING GIN (lower("japanese_title") gin_trgm_ops)'
  );
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_original_title_lower_trgm ON "Show" USING GIN (lower("original_title") gin_trgm_ops)'
  );
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_genres_trgm ON "Show" USING GIN (genres gin_trgm_ops)'
  );
  console.log("   ✅ Índices trigram creados");

  // 6. Crear índice en category
  console.log("6. Creando índice en category...");
  await pg.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS idx_show_category ON "Show" (category)'
  );
  console.log("   ✅ Índice category creado");

  // 7. Crear trigger para mantener search_vector actualizado
  console.log("7. Creando trigger para auto-actualizar search_vector...");
  await pg.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION update_show_search_vector()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.search_vector :=
        setweight(to_tsvector('simple', coalesce(NEW."title", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW."english_title", '')), 'A') ||
        setweight(to_tsvector('simple', coalesce(NEW."japanese_title", '')), 'B') ||
        setweight(to_tsvector('simple', coalesce(NEW."genres", '')), 'C') ||
        setweight(to_tsvector('simple', coalesce(NEW."description", '')), 'D');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pg.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS trg_update_search_vector ON "Show"'
  );
  await pg.$executeRawUnsafe(`
    CREATE TRIGGER trg_update_search_vector
    BEFORE INSERT OR UPDATE OF "title", "english_title", "japanese_title", "genres", "description"
    ON "Show"
    FOR EACH ROW
    EXECUTE FUNCTION update_show_search_vector()
  `);
  console.log("   ✅ Trigger creado");

  // 8. Verificar
  console.log("\n🔍 Verificando:");
  const indexes = await pg.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'Show' AND schemaname = 'public' ORDER BY indexname`
  ) as any[];
  console.log("   Índices:", indexes.map((i: any) => i.indexname).join(", "));

  const sampleSearch = await pg.$queryRawUnsafe(
    `SELECT "title", ts_rank(search_vector, plainto_tsquery('simple', 'naruto')) as rank
     FROM "Show"
     WHERE search_vector @@ plainto_tsquery('simple', 'naruto')
     ORDER BY rank DESC LIMIT 3`
  ) as any[];
  console.log("   Búsqueda 'naruto':", sampleSearch.map((s: any) => `${s.title} (${Number(s.rank).toFixed(4)})`).join(", "));

  await pg.$disconnect();
  console.log("\n✅ Full-text search configurado correctamente");
}

main().catch(console.error);
