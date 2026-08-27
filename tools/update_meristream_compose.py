import paramiko

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect('100.107.203.21', username='root', password='2008', timeout=15)
    sftp = ssh.open_sftp()

    compose_content = """version: '3.8'

services:
  meristream-db:
    image: postgres:16-alpine
    container_name: meristream-db
    restart: always
    environment:
      POSTGRES_USER: voidstream
      POSTGRES_PASSWORD: voidstream123
      POSTGRES_DB: voidstream
    volumes:
      - meristream_pgdata:/var/lib/postgresql/data
      - ./meristream_db.dump:/tmp/meristream_db.dump:ro
    ports:
      - "127.0.0.1:5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U voidstream -d voidstream"]
      interval: 5s
      timeout: 5s
      retries: 5

  meristream-app:
    image: meristream-app:latest
    container_name: meristream-app
    restart: always
    environment:
      DATABASE_URL: "postgresql://voidstream:voidstream123@meristream-db:5432/voidstream?schema=public"
      TMDB_API_KEY: "4598f607660f5c4eb423d868da148981"
      PORT: "3010"
      NODE_ENV: "production"
    volumes:
      - /opt/meristream/dist:/app/dist
      - /var/log/meristream_deploy.log:/var/log/meristream_deploy.log
    ports:
      - "3010:3010"
    command: node dist/server.cjs
    depends_on:
      meristream-db:
        condition: service_healthy

volumes:
  meristream_pgdata:
"""

    with sftp.file('/opt/meristream/docker-compose.yml', 'w') as f:
        f.write(compose_content)
    sftp.close()
    
    print("Recreating meristream-app with clean dist mount...")
    stdin, stdout, stderr = ssh.exec_command("cd /opt/meristream && docker rm -f meristream-app && docker compose up -d")
    print("STDOUT:", stdout.read().decode())
    print("STDERR:", stderr.read().decode())
    ssh.close()

if __name__ == '__main__':
    main()
