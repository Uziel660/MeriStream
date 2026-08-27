import paramiko

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect('100.107.203.21', username='root', password='2008', timeout=15)
    
    cmd = 'docker exec meristream-db psql -U voidstream -d voidstream -c "SELECT COUNT(*) AS total_shows FROM \\"Show\\"; SELECT COUNT(*) AS total_media_items FROM \\"MediaItem\\"; SELECT COUNT(*) AS total_episodes FROM \\"Episode\\";"'
    stdin, stdout, stderr = ssh.exec_command(cmd)
    print("PostgreSQL Counts:")
    print(stdout.read().decode())
    err = stderr.read().decode()
    if err:
        print("Error:", err)
        
    ssh.close()

if __name__ == '__main__':
    main()
