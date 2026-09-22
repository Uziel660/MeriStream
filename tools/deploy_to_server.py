# tools/deploy_to_server.py
import os
import sys
import zipfile
import paramiko
import subprocess
import time

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

SERVER_IP = '100.107.203.21'
USERNAME = 'root'
PASSWORD = '2008'

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP_PATH = os.path.join(BASE_DIR, 'meristream_deploy.zip')
DUMP_PATH = os.path.join(BASE_DIR, 'meristream_db.dump')

def build_app():
    print("🔨 [1/5] Compilando frontend y servidor...")
    res = subprocess.run(["npm", "run", "build"], cwd=BASE_DIR, shell=True)
    if res.returncode != 0:
        print("❌ Error en npm run build")
        sys.exit(1)
    print("✔ Compilación completada.")

def dump_database():
    print("📦 [2/5] Generando volcado actualizado de la base de datos...")
    if not os.path.exists(DUMP_PATH):
        # Intentar extraer del docker local
        cmd = 'docker exec voidstream-pg pg_dump -U voidstream voidstream -F c -f /tmp/meristream_db.dump && docker cp voidstream-pg:/tmp/meristream_db.dump meristream_db.dump'
        subprocess.run(cmd, cwd=BASE_DIR, shell=True)
    
    if os.path.exists(DUMP_PATH):
        size_mb = os.path.getsize(DUMP_PATH) / (1024 * 1024)
        print(f"✔ Dump de base de datos listo ({size_mb:.2f} MB)")
    else:
        print("⚠ Advertencia: no se encontró meristream_db.dump local.")

def create_zip():
    print("🗜 [3/5] Creando paquete de despliegue meristream_deploy.zip...")
    if os.path.exists(ZIP_PATH):
        os.remove(ZIP_PATH)

    include_files = [
        'package.json',
        'package-lock.json',
        'app.config.ts',
        'Dockerfile',
        'docker-compose.yml',
        '.dockerignore',
        'meristream_db.dump',
    ]

    include_dirs = [
        'dist',
        'prisma',
        'public',
        'server',
        'src',
        'tools',
    ]

    with zipfile.ZipFile(ZIP_PATH, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for file in include_files:
            fp = os.path.join(BASE_DIR, file)
            if os.path.exists(fp):
                zipf.write(fp, file)
        
        for dir_name in include_dirs:
            dp = os.path.join(BASE_DIR, dir_name)
            if os.path.exists(dp):
                for root, dirs, files in os.walk(dp):
                    # Excluir node_modules o temporales
                    if 'node_modules' in root or '.git' in root:
                        continue
                    for file in files:
                        full_path = os.path.join(root, file)
                        rel_path = os.path.relpath(full_path, BASE_DIR)
                        zipf.write(full_path, rel_path)

    size_mb = os.path.getsize(ZIP_PATH) / (1024 * 1024)
    print(f"✔ Paquete ZIP creado con éxito ({size_mb:.2f} MB).")

def upload_and_deploy():
    print(f"🚀 [4/5] Conectando al servidor {SERVER_IP} por SFTP...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(SERVER_IP, username=USERNAME, password=PASSWORD, timeout=15)
        sftp = client.open_sftp()

        remote_zip = "/root/meristream_deploy.zip"
        print(f"Subiendo {ZIP_PATH} -> {remote_zip}...")
        sftp.put(ZIP_PATH, remote_zip)
        print("✔ Subida completada.")

        sftp.close()

        print("⚡ [5/5] Ejecutando despliegue remoto en Docker...")
        deploy_cmd = "unzip -p /root/meristream_deploy.zip tools/deploy_remote.sh > /root/deploy_remote.sh && chmod +x /root/deploy_remote.sh && /bin/sh /root/deploy_remote.sh"
        stdin, stdout, stderr = client.exec_command(deploy_cmd, get_pty=True)

        for line in iter(stdout.readline, ""):
            print(line, end="")

        status = stdout.channel.recv_exit_status()
        if status == 0:
            print("\n🎉 ¡DESPLIEGUE FINALIZADO CON ÉXITO!")
        else:
            print(f"\n❌ El script remoto terminó con error code {status}")
    except Exception as e:
        print("❌ Error de conexión/despliegue:", e)
        sys.exit(1)
    finally:
        client.close()

if __name__ == '__main__':
    build_app()
    dump_database()
    create_zip()
    upload_and_deploy()
