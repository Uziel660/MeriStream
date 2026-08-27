# Guía de Administración Remota de la Base de Datos y Prisma Studio

Esta guía detalla cómo conectarte, administrar y realizar consultas SQL a la base de datos PostgreSQL de **MeriStream** alojada en el servidor desde tu máquina local (o cualquier cliente en la red/Tailscale).

---

## 1. Credenciales y Conexión Directa

El contenedor `meristream-db` expone el puerto estándar en la IP de Tailscale y red local:

* **Host / Servidor**: `100.107.203.21` *(o IP local LAN del servidor)*
* **Puerto**: `5433`
* **Nombre de Base de Datos**: `voidstream`
* **Usuario (Username)**: `voidstream`
* **Contraseña (Password)**: `voidstream123`
* **URL de Conexión Completa**:
  ```
  postgresql://voidstream:voidstream123@100.107.203.21:5433/voidstream?schema=public
  ```

---

## 2. Cómo usar Prisma Studio (Paso a Paso)

**Prisma Studio** es un panel visual interactivo de última generación en el navegador que te permite:
- Ver todas las 19,819 obras y 123,515 episodios en tablas con paginación fluida.
- Filtrar por títulos, año, género, rating o ID.
- Editar registros, añadir nuevos y ver relaciones entre `Show`, `Episode`, `MediaItem`, etc.

### Pasos para iniciar Prisma Studio:

1. Asegúrate de que el archivo `.env` en la raíz de este proyecto tenga la variable `DATABASE_URL`:
   ```env
   DATABASE_URL="postgresql://voidstream:voidstream123@100.107.203.21:5433/voidstream?schema=public"
   ```

2. Abre una terminal (PowerShell o CMD) en la carpeta del proyecto (`e:\nitiflix clonado`):
   ```powershell
   npx prisma studio
   ```

3. Automáticamente se abrirá en tu navegador la URL:
   👉 **`http://localhost:5555`**

4. En la barra lateral podrás hacer clic en cualquier modelo:
   - **`Show`**: Obras, títulos, pósters, descripciones, categorías.
   - **`Episode`**: Episodios, temporadas, números de capítulo, enlaces de stream.
   - **`MediaItem`**: Ítems multimedia y mapeos de scrapers.
   - **`CrawlTask`**: Cola de tareas de scraping y watchdog.

*(Para cerrar Prisma Studio cuando termines, presiona `Ctrl + C` en la terminal).*

---

## 3. Conexión con Clientes SQL (DBeaver, TablePlus, pgAdmin, DataGrip)

Si prefieres usar un gestor SQL tradicional:

1. Abre tu gestor SQL favorito (ej: **DBeaver** o **TablePlus**).
2. Crea una nueva conexión seleccionando el motor **PostgreSQL**.
3. Rellena los campos:
   - **Host**: `100.107.203.21`
   - **Port**: `5433`
   - **Database**: `voidstream`
   - **Username**: `voidstream`
   - **Password**: `voidstream123`
4. Haz clic en **Test Connection** y luego en **Save / Connect**.
5. ¡Listo! Ya puedes ejecutar consultas SQL directamente, por ejemplo:
   ```sql
   SELECT title, rating, year, created_at 
   FROM "Show" 
   ORDER BY rating DESC 
   LIMIT 20;
   ```

---

## 4. Consultas Rápidas vía Script de Consola

Si quieres consultar rápidamente el conteo de obras desde tu consola de Windows:
```powershell
python tools/check_db_count.py
```
