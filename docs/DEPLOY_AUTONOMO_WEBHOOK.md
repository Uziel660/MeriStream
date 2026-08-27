# Arquitectura de Despliegue Autónomo (GitHub Webhook + Docker)

Documentación técnica del pipeline de integración y despliegue continuo (CI/CD) autónomo y de ultra bajo consumo para **MeriStream** y el ecosistema **AppHub** en el servidor Alpine Linux.

---

## 1. Motivación y Eliminación del Runner Pesado

Anteriormente se evaluó usar un GitHub Self-Hosted Runner en contenedor Docker (`myoung34/github-runner:latest`). Sin embargo:
- **Consumo innecesario**: Ocupaba ~3.3 GB de espacio en disco y ~800 MB de memoria RAM 24/7 en un servidor con 1.9 GB de RAM total.
- **Riesgo de bloqueo**: Al competir por memoria con PostgreSQL y los microservicios, causaba contención innecesaria.

### Solución Implementada:
Se eliminó por completo el runner del host (0 MB de consumo de RAM en reposo) y se reemplazó por un **Webhook HTTP seguro directo con firma HMAC SHA-256**.

---

## 2. Flujo de Auto-Despliegue

```
┌─────────────────┐       git push main        ┌──────────────────────┐
│  Desarrollador  │ ─────────────────────────> │ GitHub (MeriStream)  │
└─────────────────┘                            └──────────┬───────────┘
                                                          │
                                            POST Webhook  │  (Firma HMAC SHA-256)
                                                          ▼
                                               ┌──────────────────────┐
                                               │ Cloudflare Tunnel    │
                                               │ stream.merith.me     │
                                               └──────────┬───────────┘
                                                          │
                                               POST /api/v1/webhook/github
                                                          │
                                                          ▼
                                               ┌──────────────────────┐
                                               │ Express 5 Backend    │
                                               │ (meristream-app)     │
                                               └──────────┬───────────┘
                                                          │
                                             Valida firma & Ejecuta script
                                                          │
                                                          ▼
                                               ┌──────────────────────┐
                                               │ /opt/meristream/     │
                                               │ update_server.sh     │
                                               └──────────┬───────────┘
                                                          │
1. git fetch & reset (git en la imagen de la app)
                                               2. Build efímero (Node 22 Alpine) -> dist en host
                                               3. docker restart (recarga dist del bind mount)
```

---

## 3. Componentes Técnicos

### 3.1 Endpoint del Webhook en `server.ts`
* **Rutas**: `POST /api/v1/webhook/github` y `POST /api/v1/webhook/deploy`
* **Seguridad**:
  - Valida el encabezado `x-hub-signature-256` enviado por GitHub calculando el hash HMAC-SHA256 del cuerpo crudo (`req.rawBody`) contra el secreto configurado (`uziel20082` o variable `DEPLOY_WEBHOOK_SECRET`).
  - También acepta tokens directos vía `x-webhook-secret` o `?secret=...`.
  - Si la firma no coincide, responde `403 Forbidden` inmediatamente.
  - Filtra para solo ejecutar cuando la rama afectada sea `refs/heads/main`.
  - Responde `200 OK` en < 200 ms y despacha la ejecución del script en segundo plano.

### 3.2 Endpoint de Monitoreo de Despliegue
* **Ruta**: `GET /api/v1/webhook/deploy/status`
* **Función**: Devuelve las últimas 60 líneas del log de compilación y despliegue (`/var/log/meristream_deploy.log`).

### 3.3 Script Autónomo en el Servidor (`/opt/meristream/update_server.sh`)
```sh
#!/bin/sh
set -e
LOG_FILE="/var/log/meristream_deploy.log"

echo "==========================================" >> "$LOG_FILE"
echo "[AutoDeploy] $(date): Iniciando actualizacion desde GitHub..." >> "$LOG_FILE"

cd /opt/meristream
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git fetch origin main >> "$LOG_FILE" 2>&1
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git reset --hard origin/main >> "$LOG_FILE" 2>&1

echo "[AutoDeploy] Compilando dist..." >> "$LOG_FILE"
docker run --rm -v /opt/meristream:/app -w /app node:22-alpine sh -c "npm install --include=dev && npm run build" >> "$LOG_FILE" 2>&1

echo "[AutoDeploy] Reiniciando contenedor..." >> "$LOG_FILE"
docker restart meristream-app >> "$LOG_FILE" 2>&1

echo "[AutoDeploy] $(date): Despliegue completado con exito!" >> "$LOG_FILE"
```

> **Nota importante de arquitectura**: el contenedor `meristream-app` (basado en `node:22-slim`) recibe el webhook y ejecuta `update_server.sh` directamente. La imagen incluye `git` y `docker.io` (cliente Docker), y monta el socket de Docker (`/var/run/docker.sock`), el repositorio (`/opt/meristream`), las claves SSH (`/root/.ssh`), los logs (`/var/log`) y **el `dist` compilado** (`/opt/meristream/dist:/app/dist:ro`). El script hace `git fetch`/`reset`, compila con `docker run node:22-alpine` (escribe el `dist` en el host) y reinicia el contenedor con `docker restart`. Al correr el código desde el mount de `dist`, el `restart` basta para cargar el código nuevo, sin reconstruir la imagen.

---

## 4. Configuración en GitHub

1. Ingresar al repositorio: `https://github.com/Uziel660/MeriStream/settings/hooks`
2. **Payload URL**: `https://stream.merith.me/api/v1/webhook/github`
3. **Content type**: `application/json`
4. **Secret**: `uziel20082`
5. **SSL verification**: `Enable SSL verification`
6. **Events**: `Just the push event`

---

## 5. Resumen del Ecosistema de Producción

| Servicio | Dominio | Puerto | Motor |
|---|---|---|---|
| **MeriStream** | `stream.merith.me` | `3010` | Node 22 (Slim) / Postgres 16 |
| **Dashboard** | `www.merith.me` | `3005` | Node 20 (Alpine) / Next.js |
| **Notas** | `notas.merith.me` | `3003` | Node 20 (Alpine) / SQLite |
| **Finanzas** | `finanzas.merith.me` | `3004` | Node 20 (Alpine) / SQLite |
| **Tareas** | `tareas.merith.me` | `3007` | Node 20 (Alpine) / SQLite |

* **Memoria RAM Total en Uso**: ~830 MiB de 1.86 GB disponibles.
* **Consumo CI/CD en reposo**: 0 MB.
