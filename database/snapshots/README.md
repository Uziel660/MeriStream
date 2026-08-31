# Snapshots de base de datos

Los archivos `*.ndjson.gz` son exportaciones completas y comprimidas de PostgreSQL, generadas en una transacción `REPEATABLE READ` mediante `tools/export_database_snapshot.ts`.

Cada línea descomprimida contiene un objeto `{ "table": "...", "data": { ... } }`. El archivo adyacente `*.manifest.json` registra tablas, cantidades, tamaño y checksum SHA-256.

Estos snapshots contienen datos sensibles de la aplicación, incluidos hashes de contraseña y progreso de usuarios. No contienen `DATABASE_URL`, archivos `.env` ni credenciales de conexión. El repositorio debe permanecer privado.

Para producir un snapshot nuevo:

```powershell
npx tsx tools/export_database_snapshot.ts database\snapshots\meristream-current.ndjson.gz
```

No restaure un snapshot sobre una base activa sin un procedimiento de restauración probado y un respaldo previo.
