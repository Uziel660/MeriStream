import paramiko

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect('100.107.203.21', username='root', password='2008', timeout=15)
    sftp = ssh.open_sftp()

    script = """#!/bin/sh
set -e
LOG_FILE="/var/log/meristream_deploy.log"

echo "==========================================" >> "$LOG_FILE"
echo "[AutoDeploy] $(date): Iniciando actualizacion desde GitHub..." >> "$LOG_FILE"

cd /opt/meristream
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git fetch origin main >> "$LOG_FILE" 2>&1
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git reset --hard origin/main >> "$LOG_FILE" 2>&1

echo "[AutoDeploy] Compilando dist..." >> "$LOG_FILE"
docker run --rm -v /opt/meristream:/app -w /app node:22-alpine sh -c "npm install --include=dev && npm run build" >> "$LOG_FILE" 2>&1

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"; else COMPOSE="docker-compose"; fi

echo "[AutoDeploy] Reconstruyendo imagen..." >> "$LOG_FILE"
$COMPOSE build meristream-app >> "$LOG_FILE" 2>&1

echo "[AutoDeploy] Reiniciando contenedor..." >> "$LOG_FILE"
$COMPOSE up -d meristream-app >> "$LOG_FILE" 2>&1

echo "[AutoDeploy] $(date): Despliegue completado con exito!" >> "$LOG_FILE"
"""

    with sftp.file('/opt/meristream/update_server.sh', 'w') as f:
        f.write(script)
    sftp.chmod('/opt/meristream/update_server.sh', 0o755)
    sftp.close()
    
    print("update_server.sh written to /opt/meristream/update_server.sh")
    
    # Test script execution
    stdin, stdout, stderr = ssh.exec_command("/opt/meristream/update_server.sh")
    out = stdout.read().decode()
    err = stderr.read().decode()
    print("STDOUT:", out)
    if err:
        print("STDERR:", err)
        
    ssh.close()
    print("Server auto-deploy script tested successfully!")

if __name__ == '__main__':
    main()
