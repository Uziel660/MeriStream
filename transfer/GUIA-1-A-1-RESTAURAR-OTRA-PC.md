# Restaurar MeriStream en otra PC — guía 1 a 1

Esta guía mueve **código, configuración privada y catálogo** a una PC nueva sin depender de la PC anterior después de comprobar la restauración.

La rama que debes usar es `codex/pc-transfer-2026-09-10`. Contiene el código y un paquete cifrado en dos partes. El paquete contiene:

- `.env` con las credenciales locales;
- un dump completo y fresco de PostgreSQL creado el 10 de septiembre de 2026 desde `voidstream-pg`;
- datos operativos pequeños de `data/`.

No incluye `data/write-buffer.jsonl.tmp`: es un temporal regenerable, no la fuente del catálogo, y ocupa más de 500 MB. La fuente de datos que importa es el dump de PostgreSQL incluido.

> No borres nada de la PC anterior hasta llegar al paso 8 y comprobar que la app abre y el catálogo está presente.

## 1. Prepara la PC nueva

Instala estas tres herramientas antes de clonar nada:

1. [Git for Windows](https://git-scm.com/download/win)
2. Node.js LTS (incluye `npm`)
3. Docker Desktop para Windows, usando contenedores Linux

Instala además [7-Zip](https://www.7-zip.org/) si Docker Desktop no aporta `7zr.exe`. 7-Zip se usa solo para abrir el backup cifrado.

Abre **PowerShell** y verifica lo básico:

```powershell
git --version
node --version
npm --version
docker version
```

Abre Docker Desktop y espera a que indique que el motor está en ejecución. Si `docker version` no muestra una sección `Server`, no continúes todavía.

## 2. Clona exactamente la rama de transferencia

El repositorio es privado, así que inicia sesión en GitHub cuando Git lo solicite.

```powershell
Set-Location $HOME\Desktop
git clone --branch codex/pc-transfer-2026-09-10 https://github.com/Uziel660/MeriStream.git
Set-Location .\MeriStream
git branch --show-current
```

El último comando debe responder:

```text
codex/pc-transfer-2026-09-10
```

## 3. Comprueba que llegaron las dos partes del backup

No muevas, renombres ni extraigas manualmente los archivos. Deben permanecer juntos dentro de `transfer`:

```powershell
Get-ChildItem .\transfer\Meristream-PC-Transfer-2026-09-10.7z.* |
  Select-Object Name, Length
```

Debes ver exactamente estas dos piezas:

| Archivo | Tamaño esperado |
| --- | ---: |
| `Meristream-PC-Transfer-2026-09-10.7z.001` | 94,371,840 bytes |
| `Meristream-PC-Transfer-2026-09-10.7z.002` | 23,904,513 bytes |

Para una comprobación criptográfica adicional, ejecuta:

```powershell
Get-FileHash .\transfer\Meristream-PC-Transfer-2026-09-10.7z.001 -Algorithm SHA256
Get-FileHash .\transfer\Meristream-PC-Transfer-2026-09-10.7z.002 -Algorithm SHA256
```

Los hashes deben ser, respectivamente:

```text
D66F3DBDF2DAC65074D6C102E657BEB17464472B3A9C57FAD6EF68DF91818F6C
116560482E5D6C7711CE138402956CC23D0D818EE992C6869E5A84718EC2FC76
```

Si falta una pieza o un hash no coincide, elimina ese clon y vuelve a clonarlo antes de seguir.

## 4. Restaura todo con un único comando

Este es el único paso que cambia datos en la PC nueva. Crea una base PostgreSQL local nueva, recupera el `.env`, importa el catálogo y alinea Prisma con el código.

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\tools\restore-pc-transfer.ps1 -RestoreDatabase
```

El script te pedirá la contraseña del paquete. Escríbela cuando la solicite; no la pegues en el comando para que no quede guardada en el historial de PowerShell.

El proceso hace, en este orden:

1. verifica y descifra las dos partes del backup;
2. crea `.env` en el clon;
3. deja una copia del dump en `backups\meristream-transfer.dump`;
4. inicia el contenedor local `meristream-db`;
5. restaura PostgreSQL desde el dump;
6. ejecuta `npm ci`, `prisma generate` y `prisma db push`.

No cierres PowerShell. Según la conexión, `npm ci` puede tardar varios minutos.

## 5. Si el script se detiene por un `.env` existente

Eso es una protección intencional. En una PC nueva no debería ocurrir. Si estás seguro de que quieres reemplazar el `.env` de destino, primero guárdalo con otro nombre y repite:

```powershell
Copy-Item .\.env .\.env.antes-de-transferencia
.\tools\restore-pc-transfer.ps1 -RestoreDatabase -OverwriteEnv
```

No uses `-OverwriteEnv` si el `.env` actual contiene secretos de una instalación que quieres conservar.

## 6. Comprueba PostgreSQL antes de abrir la app

```powershell
docker compose ps
docker exec meristream-db psql -U voidstream -d voidstream -c 'SELECT COUNT(*) AS shows FROM "Show";'
```

El primer comando debe mostrar `meristream-db` como `healthy`. El segundo debe devolver una cantidad grande de obras, no cero.

Si el contenedor no está `healthy`, mira el motivo sin modificar datos:

```powershell
docker logs --tail 100 meristream-db
```

## 7. Abre MeriStream

```powershell
npm run dev
```

Abre la URL que Vite muestre normalmente (`http://localhost:3010`). Comprueba, al menos:

1. La página principal carga contenido.
2. La búsqueda devuelve obras antiguas del catálogo.
3. Puedes abrir `/admin` e iniciar sesión con las credenciales restauradas.
4. Un detalle de obra muestra sus enlaces/servidores.

## 8. Marca la migración como terminada

Solo cuando los cuatro puntos anteriores funcionen, la nueva PC ya es una copia operativa.

Conserva la PC anterior y estas dos piezas de backup hasta que hayas usado la nueva instalación durante unos días. La copia de base restaurada también queda en `backups\meristream-transfer.dump`, por lo que puedes repetir la importación local si hiciera falta.

## Solución de problemas

| Síntoma | Solución segura |
| --- | --- |
| `No se encontró la primera parte del paquete` | Vuelve a la carpeta raíz `MeriStream` y comprueba que existen ambas piezas en `transfer`. |
| `contraseña incorrecta o partes incompletas` | Revisa hashes del paso 3; si coinciden, vuelve a pedir/verificar la contraseña. |
| `No se encontró 7-Zip` | Instala 7-Zip, cierra y abre PowerShell, y repite el paso 4. |
| `docker compose` no responde | Abre Docker Desktop, espera a que termine de iniciar y repite el paso 4. |
| El puerto `5433` ya está ocupado | Cierra o detén únicamente el servicio que ya usa el puerto. No borres volúmenes de Docker. Luego repite el paso 4. |
| `P1001` o fallo de conexión a la base | Ejecuta `docker compose ps`. Si `meristream-db` no está healthy, usa `docker logs --tail 100 meristream-db`. |
| `npm ci` falla por red | Comprueba Internet y ejecuta de nuevo `npm ci`; no es necesario volver a importar la base. |
| La app abre pero el catálogo está vacío | No continúes usando esa instalación. Repite el paso 4 y confirma que el comando del paso 6 devuelve obras antes de lanzar `npm run dev`. |

## Restaurar de nuevo la misma base a propósito

En la PC nueva, el comando de restauración reemplaza solamente la base `meristream-db` gestionada por este proyecto. Si ya has creado datos nuevos que deseas conservar, primero realiza otro dump antes de repetir el paso 4.

El script no toca `voidstream-pg` ni ningún contenedor ajeno.
