# tools/sync_db_from_server.py
import os
import sys
import subprocess
import paramiko

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

SERVERS = ['192.168.18.3', 'stream.merith.me']
USERNAME = 'root'
PASSWORD = '2008'

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_DUMP = os.path.join(BASE_DIR, 'meristream_prod.dump')
PG_RESTORE = r"C:\Program Files\PostgreSQL\18\bin\pg_restore.exe"
PSQL = r"C:\Program Files\PostgreSQL\18\bin\psql.exe"

def connect_ssh():
    for host in SERVERS:
        print(f"📡 Intentando conectar a {host} por SSH...")
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(host, username=USERNAME, password=PASSWORD, timeout=10)
            print(f"✔ Conexión SSH exitosa a {host}")
            return client, host
        except Exception as e:
            print(f"❌ Falló conexión a {host}: {e}")
    print("❌ No se pudo conectar a ningún servidor.")
    sys.exit(1)

def dump_remote_db(client):
    print("📦 Identificando contenedor y generando dump en el servidor...")
    # Check docker containers
    stdin, stdout, stderr = client.exec_command("docker ps --format '{{.Names}}'")
    containers = stdout.read().decode('utf-8', errors='replace').strip().splitlines()
    print(f"Contenedores detectados: {containers}")

    db_container = None
    for name in ['meristream-db', 'voidstream-pg', 'postgres']:
        if name in containers:
            db_container = name
            break
    
    if not db_container:
        for c in containers:
            if 'db' in c or 'postgres' in c:
                db_container = c
                break

    if db_container:
        print(f"✔ Usando contenedor de BD: {db_container}")
        dump_cmd = f"docker exec {db_container} pg_dump -U voidstream -d voidstream -F c -b -v > /tmp/meristream_prod.dump"
    else:
        print("⚠ No se detectó contenedor Docker de BD, intentando pg_dump directo del sistema...")
        dump_cmd = "pg_dump -U voidstream -d voidstream -F c -b -v > /tmp/meristream_prod.dump"

    print(f"Ejecutando: {dump_cmd}")
    stdin, stdout, stderr = client.exec_command(dump_cmd)
    exit_status = stdout.channel.recv_exit_status()
    err = stderr.read().decode('utf-8', errors='replace')
    if exit_status != 0:
        print(f"❌ Error al crear dump remoto (code {exit_status}): {err}")
        # Try without password or with postgres user
        alt_cmd = f"docker exec {db_container} pg_dump -U postgres -d voidstream -F c -b -v > /tmp/meristream_prod.dump"
        print(f"Probando alternativa: {alt_cmd}")
        stdin, stdout, stderr = client.exec_command(alt_cmd)
        if stdout.channel.recv_exit_status() != 0:
            print(f"❌ Falló también alternativa: {stderr.read().decode('utf-8')}")
            sys.exit(1)
    
    print("✔ Dump remoto generado en /tmp/meristream_prod.dump")

def download_dump(client):
    print("📥 Descargando dump vía SFTP...")
    sftp = client.open_sftp()
    remote_path = "/tmp/meristream_prod.dump"
    sftp.get(remote_path, LOCAL_DUMP)
    sftp.close()
    size_mb = os.path.getsize(LOCAL_DUMP) / (1024 * 1024)
    print(f"✔ Dump descargado exitosamente: {LOCAL_DUMP} ({size_mb:.2f} MB)")

def restore_local_db():
    print("🔄 Restaurando dump en la base de datos PostgreSQL local (puerto 5432)...")
    env = os.environ.copy()
    env["PGPASSWORD"] = "voidstream123"

    # Restore using pg_restore
    cmd = [
        PG_RESTORE,
        "-h", "localhost",
        "-p", "5432",
        "-U", "voidstream",
        "-d", "voidstream",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "-v",
        LOCAL_DUMP
    ]
    
    print(f"Ejecutando pg_restore...")
    res = subprocess.run(cmd, env=env, capture_output=True, text=True)
    print(res.stdout)
    if res.returncode != 0:
        print("Nota de pg_restore (advertencias normales al limpiar objetos previos):")
        print(res.stderr[:500])
    
    print("✔ ¡Base de datos local actualizada correctamente con los datos de producción!")

if __name__ == '__main__':
    client, host = connect_ssh()
    try:
        dump_remote_db(client)
        download_dump(client)
    finally:
        client.close()
    
    restore_local_db()
