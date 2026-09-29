#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${1:-/opt/meristream}"
SERVICE_NAME="meristream-compose.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

if [[ ! -f "${APP_DIR}/docker-compose.yml" ]]; then
  echo "No se encontró docker-compose.yml en ${APP_DIR}" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd no está disponible; se conservan los restart policies de Compose" >&2
  exit 0
fi

DOCKER_BIN="$(command -v docker || true)"
if [[ -z "${DOCKER_BIN}" ]]; then
  echo "docker no está disponible en PATH; se conservan los restart policies de Compose" >&2
  exit 0
fi

cat >"${SERVICE_PATH}" <<EOF
[Unit]
Description=MeriStream Compose stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${APP_DIR}
RemainAfterExit=yes
ExecStart=${DOCKER_BIN} compose up -d --remove-orphans
ExecStop=${DOCKER_BIN} compose stop
TimeoutStartSec=0
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"
systemctl --no-pager --plain is-enabled "${SERVICE_NAME}"
systemctl --no-pager --plain is-active "${SERVICE_NAME}"
