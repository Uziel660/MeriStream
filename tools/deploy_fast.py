import os
import shlex
import shutil
import subprocess
import sys


if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


SSH_TARGET = os.environ.get("MERISTREAM_SSH_TARGET", "").strip()
REMOTE_DIR = os.environ.get("MERISTREAM_REMOTE_DIR", "/opt/meristream").strip()


def build_app() -> None:
    print("🔨 [1/2] Comprobando la compilación de la app...")
    result = subprocess.run(["npm", "run", "build"], check=False)
    if result.returncode != 0:
        print("❌ La compilación falló. No se desplegó ningún cambio.")
        raise SystemExit(result.returncode)
    print("✔ Compilación completada.")


def deploy() -> None:
    if not SSH_TARGET:
        print("❌ Define MERISTREAM_SSH_TARGET con el alias SSH o destino del servidor.")
        raise SystemExit(2)

    ssh = shutil.which("ssh")
    if not ssh:
        print("❌ No se encontró OpenSSH. Instálalo o añádelo al PATH.")
        raise SystemExit(2)

    remote_dir = shlex.quote(REMOTE_DIR)
    remote_command = (
        f"cd {remote_dir}"
        " && git pull --ff-only origin main"
        " && sudo docker compose up -d --build --no-deps app"
    )
    print(f"🚀 [2/2] Reconstruyendo solo el servicio app en {SSH_TARGET}...")
    result = subprocess.run([ssh, SSH_TARGET, remote_command], check=False)
    if result.returncode != 0:
        print("❌ El despliegue falló. PostgreSQL y el túnel no se modificaron.")
        raise SystemExit(result.returncode)
    print("✔ Servicio app actualizado. PostgreSQL y el túnel permanecen intactos.")


if __name__ == "__main__":
    build_app()
    deploy()
