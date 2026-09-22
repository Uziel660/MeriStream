import paramiko

COMPOSE_CONTENT = """services:
  # ==========================================
  # NotesApp (Backend 3000, Frontend 3003)
  # ==========================================
  notes-backend:
    image: node:20-alpine
    container_name: apphub-notes-backend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/NotesApp/backend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3000
      - NODE_ENV=production
      - JWT_SECRET=a63786497f3981fb15675361f876f510820dc68e93f94f3956fc0ba523ff26fc
    command: ["node", "server.js"]

  notes-frontend:
    image: node:20-alpine
    container_name: apphub-notes-frontend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/NotesApp/frontend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3003
      - NODE_ENV=production
      - NODE_TLS_REJECT_UNAUTHORIZED=0
      - BACKEND_API_URL=http://127.0.0.1:3000/api
    command: ["node", "server.js"]
    depends_on:
      - notes-backend

  # ==========================================
  # Finanzas (Backend 3001, Frontend 3004)
  # ==========================================
  finanzas-backend:
    image: node:20-alpine
    container_name: apphub-finanzas-backend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/Finanzas/backend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3001
      - NODE_ENV=production
      - JWT_SECRET=a63786497f3981fb15675361f876f510820dc68e93f94f3956fc0ba523ff26fc
    command: ["node", "server.js"]

  finanzas-frontend:
    image: node:20-alpine
    container_name: apphub-finanzas-frontend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/Finanzas/frontend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3004
      - NODE_ENV=production
      - NODE_TLS_REJECT_UNAUTHORIZED=0
      - BACKEND_API_URL=http://127.0.0.1:3001/api
    command: ["node", "server.js"]
    depends_on:
      - finanzas-backend

  # ==========================================
  # Dashboard (Backend 3002, Frontend 3005)
  # ==========================================
  dashboard-backend:
    image: node:20-alpine
    container_name: apphub-dashboard-backend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/Dashboard/backend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3002
      - NODE_ENV=production
      - JWT_SECRET=a63786497f3981fb15675361f876f510820dc68e93f94f3956fc0ba523ff26fc
      - JWT_EXPIRES_IN=30d
    command: ["node", "server.js"]

  dashboard-frontend:
    image: node:20-alpine
    container_name: apphub-dashboard-frontend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/Dashboard/frontend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3005
      - BACKEND_PORT=3002
      - NODE_ENV=production
      - NODE_TLS_REJECT_UNAUTHORIZED=0
      - BACKEND_API_URL=http://127.0.0.1:3002/api
    command: ["node", "server.js"]
    depends_on:
      - dashboard-backend

  # ==========================================
  # Task (Backend 3006, Frontend 3007)
  # ==========================================
  task-backend:
    image: node:20-alpine
    container_name: apphub-task-backend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/Task/backend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3006
      - NODE_ENV=production
      - JWT_SECRET=a63786497f3981fb15675361f876f510820dc68e93f94f3956fc0ba523ff26fc
    command: ["node", "server.js"]

  task-frontend:
    image: node:20-alpine
    container_name: apphub-task-frontend
    restart: always
    network_mode: host
    working_dir: /opt/apphub/Task/frontend
    volumes:
      - /opt/apphub:/opt/apphub
    environment:
      - PORT=3007
      - NODE_ENV=production
      - NODE_TLS_REJECT_UNAUTHORIZED=0
      - BACKEND_API_URL=http://127.0.0.1:3006/api
    command: ["node", "server.js"]
    depends_on:
      - task-backend
"""

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print("Connecting to 100.107.203.21...")
    ssh.connect('100.107.203.21', username='root', password='2008', timeout=15)
    
    sftp = ssh.open_sftp()
    print("Writing /opt/apphub/docker-compose.yml...")
    with sftp.file('/opt/apphub/docker-compose.yml', 'w') as f:
        f.write(COMPOSE_CONTENT)
    sftp.close()
    
    print("Re-deploying AppHub with network_mode: host...")
    stdin, stdout, stderr = ssh.exec_command("cd /opt/apphub && docker compose down && docker compose up -d")
    out = stdout.read().decode()
    err = stderr.read().decode()
    print("STDOUT:", out)
    if err:
        print("STDERR:", err)
        
    ssh.close()

if __name__ == '__main__':
    main()
