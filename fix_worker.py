import os

file_path = 'server/taskWorker.ts'
with open(file_path, 'r') as f:
    content = f.read()

# the warning on line 48 was about unused variable, but looking at line 48: export interface WorkerSettings
# Wait, let's just make it shorter.

content = content.replace("export class BackgroundCrawlerWorker {", "export class BackgroundCrawlerWorker {")

with open(file_path, 'w') as f:
    f.write(content)
print("done")
