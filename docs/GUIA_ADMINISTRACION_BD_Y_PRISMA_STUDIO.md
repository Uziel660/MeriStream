# Administración de la base de datos

La instalación recomendada usa PostgreSQL dentro de Compose. Las credenciales se leen únicamente desde `.env`; nunca se guardan en esta documentación ni se exponen en una dirección pública.

## Comprobaciones rápidas

```powershell
docker compose ps
docker compose logs --tail=100 db
docker compose exec db psql -U $env:POSTGRES_USER -d $env:POSTGRES_DB -c 'SELECT count(*) FROM "Show";'
```

La base se mantiene en el volumen `meristream_pgdata`. `docker compose down` conserva los datos; `docker compose down -v` los elimina y fuerza una restauración limpia de la semilla.

## Prisma Studio

Para abrir Prisma Studio contra una instalación local, crea una copia temporal de `.env` con una `DATABASE_URL` que apunte al puerto publicado por Compose (por defecto `127.0.0.1:5433`) y ejecuta:

```powershell
npx prisma studio
```

No publiques el puerto de PostgreSQL en una interfaz externa. Si necesitas acceso remoto, usa una red privada y credenciales propias del despliegue.

## Copias de seguridad

Usa `scripts/docker/backup.ps1` en Windows o `scripts/docker/backup.sh` en Linux/macOS. Los archivos producidos contienen datos de la instalación, incluidas cuentas e historiales, y deben mantenerse fuera del repositorio y con acceso restringido.

Para restaurar, conserva primero la copia actual y utiliza un proyecto Compose aislado. La restauración automática de la semilla solo ocurre cuando se crea un volumen nuevo.
