import os

with open('server/taskWorker.ts', 'r') as f:
    content = f.read()

content = content.replace("""  constructor() {
    this.initSettings();
    setInterval(() => this.processNextInQueue(), 1000);
  }""", """  constructor() {
    setInterval(() => this.processNextInQueue(), 1000);
  }

  public init() {
    this.initSettings();
  }""")

with open('server/taskWorker.ts', 'w') as f:
    f.write(content)
print("done")
