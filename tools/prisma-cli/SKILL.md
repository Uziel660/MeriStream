---
name: prisma-cli
description: Best practices, commands, and workflows for administering databases with Prisma CLI and Prisma Studio. Use when managing, querying, introspecting, or migrating databases with Prisma.
---

# Prisma CLI & Database Administration Skill

This skill provides a comprehensive guide for managing, querying, and introspecting SQL databases (PostgreSQL, MySQL, SQLite, SQL Server) using **Prisma CLI** and **Prisma Studio**.

---

## 1. Environment & Connection Strings

Prisma automatically loads configuration from `.env` in the project root.

### Standard Connection String Format
```env
DATABASE_URL="protocol://<user>:<password>@<host>:<port>/<database>?schema=<schema_name>&sslmode=<mode>"
```

**Examples by Database Engine:**
- **PostgreSQL**: `postgresql://user:password@localhost:5432/mydb?schema=public`
- **MySQL**: `mysql://user:password@localhost:3306/mydb`
- **SQLite**: `file:./dev.db`

---

## 2. Prisma Studio (Visual Data Browser)

**Prisma Studio** is a browser-based visual interface for exploring, filtering, creating, and editing data across all database models.

### Basic Usage
```bash
npx prisma studio
```
*Opens `http://localhost:5555` automatically and connects using `DATABASE_URL` from `.env`.*

### Advanced Flags & Remote Usage

| Command Flag | Purpose | Example |
|---|---|---|
| `--port <port>` | Run on a specific custom port | `npx prisma studio --port 5556` |
| `--browser none` | Start headless without auto-opening a browser window | `npx prisma studio --browser none` |
| `--schema <path>` | Specify custom path to `schema.prisma` | `npx prisma studio --schema=./prisma/schema.prisma` |
| `--url <connection_string>` | Connect directly without touching `.env` | `npx prisma studio --url "postgresql://user:pass@host:5432/db"` |

---

## 3. Database Introspection & Schema Sync

Use these commands to sync between the Prisma schema and the live database:

### A. Introspect Existing Database (`db pull`)
Inspects a live database and updates `schema.prisma` with all models, relations, and types:
```bash
npx prisma db pull
```
*Optionally force overwrite:* `npx prisma db pull --force`

### B. Push Schema directly to Database (`db push`)
Applies the `schema.prisma` structure directly to the database without generating migration files (ideal for rapid prototyping):
```bash
npx prisma db push
```
*To accept data loss warnings explicitly:* `npx prisma db push --accept-data-loss`

---

## 4. Migrations & Version Control

For production-ready workflows with tracked SQL migration files:

| Task | Command | Description |
|---|---|---|
| **Create & Apply Migration (Dev)** | `npx prisma migrate dev --name <migration_name>` | Generates a new SQL migration file and applies it to dev DB. |
| **Apply Pending Migrations (Prod/CI)** | `npx prisma migrate deploy` | Applies existing migrations in production without prompting. |
| **Check Migration Status** | `npx prisma migrate status` | Checks if the database is in sync with applied migrations. |
| **Reset Database (Dev Only)** | `npx prisma migrate reset` | Drops the database, applies all migrations, and runs seed scripts. |

---

## 5. Code Generation & Schema Quality

### A. Generate Client (`prisma generate`)
Generates the type-safe Prisma Client for TypeScript/JavaScript:
```bash
npx prisma generate
```

### B. Format & Lint Schema
```bash
# Formats and aligns models, relations, and attributes
npx prisma format

# Validates syntax and relation integrity
npx prisma validate
```

---

## 6. Multi-Platform & Engine Configuration

When deploying Prisma across different environments (e.g. Docker, Alpine Linux, Debian, Windows), specify `binaryTargets` in `schema.prisma`:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-3.0.x", "linux-musl-openssl-3.0.x"]
}
```

### Engine Type Configuration
To switch between Node-API library and standalone binary process:
```env
PRISMA_CLIENT_ENGINE_TYPE="library"  # or "binary"
```

---

## 7. Direct SQL Queries via Command Line

If direct SQL terminal access is preferred without Prisma Studio:

```bash
# Connect interactively with psql
psql -h <host> -p <port> -U <user> -d <database>

# Run a single query directly
psql -h <host> -p <port> -U <user> -d <database> -c "SELECT COUNT(*) FROM \"YourModel\";"
```
