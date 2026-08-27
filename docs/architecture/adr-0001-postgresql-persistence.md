# ADR 0001: Persistencia PostgreSQL con Prisma ORM

## Contexto

El proyecto requiere una base de datos relacional para manejar catálogos multimedia, tareas de rastreo y configuraciones persistentes. La solución actual usa un almacenamiento en memoria (Map) que no persiste entre reinicios.

## Decisión

Implementar PostgreSQL 17 con Prisma ORM para:

1. **Persistencia**: Guardar datos de forma permanente entre reinicios
2. **Relaciones**: Modelar relaciones entre entidades (Show → Episodes)
3. **Deduplicación**: Implementar sistema anti-duplicados por mal_id + títulos normalizados
4. **Escalabilidad**: Preparar para crecimiento futuro

## Estructura de Datos

```prisma
model Show {
  id               String    @id @default(cuid())
  mal_id           Int?      @unique
  anilist_id       Int?
  title            String
  japanese_title   String?
  english_title    String?
  normalized_title String    @index
  description      String
  poster_url       String?
  banner_url       String?
  category         String    @default("anime")
  rating           Float     @default(8.0)
  year             Int       @default(2024)
  status           String    @default("Finalizado")
  genres           String    @default("Multimedia")
  created_at       DateTime  @default(now())
  updated_at       DateTime  @updatedAt
  episodes         Episode[]
}

model Episode {
  id             String   @id @default(cuid())
  show_id        String
  show           Show     @relation(fields: [show_id], references: [id], onDelete: Cascade)
  title          String
  episode_number Float
  source_url     String
  created_at     DateTime @default(now())
  updated_at     DateTime @updatedAt

  @@index([show_id])
}
```

## Beneficios

- **Consistencia**: Datos persistentes entre reinicios
- **Rendimiento**: Consultas optimizadas por Prisma
- **Mantenibilidad**: Esquema claro y documentado

## Contras

- Requiere configuración inicial de PostgreSQL
- Dependencia adicional de Prisma

## Estado

Aceptado (2026-08-20)
