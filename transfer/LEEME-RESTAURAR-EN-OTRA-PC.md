# Transferencia de MeriStream a otra PC

Esta rama incluye todo el código y un paquete cifrado con el `.env`, un dump fresco de PostgreSQL y los datos operativos locales. No hay secretos legibles en GitHub: el paquete usa AES-256 y su contraseña se transmite por separado.

Para la migración completa, sigue [la guía 1 a 1](GUIA-1-A-1-RESTAURAR-OTRA-PC.md).

## En la nueva PC

1. Instala Git, Node.js LTS y Docker Desktop.
2. Clona el repositorio privado y abre la rama de transferencia:

```powershell
git clone https://github.com/Uziel660/MeriStream.git
Set-Location MeriStream
git switch codex/pc-transfer-2026-09-10
```

3. Ejecuta una restauración completa. La contraseña del paquete se transmite por separado y no debe subirse ni guardarse junto al archivo:

```powershell
.\tools\restore-pc-transfer.ps1 -RestoreDatabase
```

El script pide la contraseña, restaura `.env`, los datos locales, PostgreSQL y después alinea el esquema con el código de esta rama. Las partes `transfer/*.7z.00*` deben conservarse juntas. Al terminar, inicia el proyecto con `npm run dev`.

## Precauciones

- `-RestoreDatabase` reemplaza la base local de Docker de la nueva PC. Úsalo solo si esa base no contiene trabajo que quieras conservar.
- Si ya existe un `.env` en destino, agrega `-OverwriteEnv` únicamente si deseas reemplazarlo.
- El dump incluido fue creado el **10 de septiembre de 2026** directamente desde `voidstream-pg`, la instancia persistente real de esta PC.
- Para crear una copia nueva más adelante: `./tools/new-pc-transfer-bundle.ps1 -Password 'una-contraseña-larga' -DatabaseDumpPath 'ruta\al\dump.dump'`.
- El temporal `data/write-buffer.jsonl.tmp` no entra al paquete: es un buffer regenerable de más de 500 MB y no es la fuente canónica; la base de datos sí contiene el estado que importa.
