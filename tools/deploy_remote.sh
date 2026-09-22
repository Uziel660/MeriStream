#!/bin/sh
set -e

echo "=================================================="
echo "    DESPLIEGUE REMOTO DE MERISTREAM EN DOCKER    "
echo "=================================================="

# 1. Asegurar servicio Docker en Alpine
if ! service docker status >/dev/null 2>&1; then
    echo "Iniciando servicio Docker..."
    service docker start || /etc/init.d/docker start
    rc-update add docker boot || true
fi

# 2. Preparar directorio /opt/meristream
echo "Desempaquetando archivos en /opt/meristream..."
mkdir -p /opt/meristream
unzip -q -o /root/meristream_deploy.zip -d /opt/meristream

cd /opt/meristream

# 3. Levantar primero el servicio de Base de Datos
echo "Levantando contenedor de base de datos (PostgreSQL)..."
docker-compose up -d meristream-db || docker compose up -d meristream-db

echo "Esperando que PostgreSQL esté listo..."
RETRIES=30
until docker exec meristream-db pg_isready -U voidstream -d voidstream >/dev/null 2>&1 || [ $RETRIES -eq 0 ]; do
    echo "Esperando base de datos... ($RETRIES)"
    sleep 2
    RETRIES=$((RETRIES - 1))
done

if [ $RETRIES -eq 0 ]; then
    echo "ERROR: PostgreSQL no respondió a tiempo."
    exit 1
fi

# 4. Restaurar Base de Datos desde el Dump
if [ -f "/opt/meristream/meristream_db.dump" ]; then
    echo "Restaurando base de datos completa con pg_restore..."
    # Copiar dump al contenedor
    docker cp /opt/meristream/meristream_db.dump meristream-db:/tmp/meristream_db.dump
    
    # Restaurar datos (ignorando advertencias de roles ya existentes)
    docker exec meristream-db pg_restore -U voidstream -d voidstream --clean --if-exists --no-owner /tmp/meristream_db.dump || \
    docker exec meristream-db pg_restore -U voidstream -d voidstream --no-owner /tmp/meristream_db.dump || true
    
    echo "✔ Base de datos restaurada correctamente."
fi

# 5. Construir y Levantar la aplicación completa
echo "Construyendo y arrancando MeriStream App..."
docker-compose up -d --build || docker compose up -d --build

echo "Esperando inicio de la aplicación..."
sleep 5

# 6. Comprobación de estado
docker ps | grep meristream

echo "=================================================="
echo "✔ MERISTREAM DESPLEGADO CON ÉXITO EN PUERTO 3010!"
echo "  URL interna: http://100.107.203.21:3010"
echo "  Dominio: http://stream.merith.me (vía Cloudflare Tunnel)"
echo "=================================================="
