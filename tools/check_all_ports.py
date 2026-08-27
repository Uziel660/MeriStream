import paramiko

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect('100.107.203.21', username='root', password='2008', timeout=15)
    
    ports = [
        (3000, "/api/notes", "NotesApp Backend"),
        (3001, "/api/health", "Finanzas Backend"),
        (3002, "/api/health", "Dashboard Backend"),
        (3003, "/", "NotesApp Frontend"),
        (3004, "/", "Finanzas Frontend"),
        (3005, "/", "Dashboard Frontend"),
        (3006, "/api/health", "Task Backend"),
        (3007, "/", "Task Frontend"),
        (3010, "/api/v1/verify/pipeline", "MeriStream (App)")
    ]
    
    print("==================================================")
    print("      ESTADO DE TODOS LOS SERVICIOS EN DOCKER     ")
    print("==================================================")
    for p, path, name in ports:
        stdin, stdout, stderr = ssh.exec_command(f'curl -s -o /dev/null -w "%{{http_code}}" http://127.0.0.1:{p}{path}')
        code = stdout.read().decode().strip()
        print(f"[{code}] Puerto {p}{path} -> {name}")
        
    ssh.close()

if __name__ == '__main__':
    main()
