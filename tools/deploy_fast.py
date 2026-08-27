# tools/deploy_fast.py
import os
import sys
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
DIST_DIR = os.path.join(BASE_DIR, 'dist')

def build_app():
    print("🔨 [1/3] Compilando frontend y backend con Vite y esbuild...")
    res = subprocess.run(["npm", "run", "build"], cwd=BASE_DIR, shell=True)
    if res.returncode != 0:
        print("❌ Error en npm run build. Cancelando despliegue.")
        sys.exit(1)
    print("✔ Compilación completada con éxito.")

def sftp_upload_dist(sftp, local_dir, remote_dir):
    try:
        sftp.mkdir(remote_dir)
    except:
        pass
    for root, dirs, files in os.walk(local_dir):
        rel = os.path.relpath(root, local_dir)
        dest_dir = os.path.normpath(os.path.join(remote_dir, rel)).replace('\\', '/')
        try:
            sftp.mkdir(dest_dir)
        except:
            pass
        for f in files:
            local_f = os.path.join(root, f)
            remote_f = os.path.normpath(os.path.join(dest_dir, f)).replace('\\', '/')
            sftp.put(local_f, remote_f)

def deploy():
    print(f"🚀 [2/3] Conectando a {SERVER_IP} por SFTP...")
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(SERVER_IP, username=USERNAME, password=PASSWORD, timeout=15)
        sftp = client.open_sftp()

        print("📤 Subiendo /dist actualizado al servidor...")
        sftp_upload_dist(sftp, DIST_DIR, "/opt/meristream/dist")
        print("✔ Archivos sincronizados en /opt/meristream/dist.")

        sftp.close()

        print("⚡ [3/3] Reiniciando contenedor meristream-app...")
        stdin, stdout, stderr = client.exec_command("docker restart meristream-app")
        out = stdout.read().decode().strip()
        print(f"✔ Contenedor {out} reiniciado y activo en Docker.")

        print("\n🎉 ¡DESPLIEGUE RÁPIDO FINALIZADO CON ÉXITO! (https://stream.merith.me)")
    except Exception as e:
        print("❌ Error durante el despliegue:", e)
        sys.exit(1)
    finally:
        client.close()

if __name__ == '__main__':
    build_app()
    deploy()
