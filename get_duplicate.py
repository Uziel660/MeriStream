import sys

def extract_lines(file_path, start, end):
    with open(file_path, 'r') as f:
        lines = f.readlines()
    return "".join(lines[start-1:end])

print("metadataEngine.ts 185-198:")
print(extract_lines('server/metadataEngine.ts', 185, 198))
print("---")
print("metadataEngine.ts 225-238:")
print(extract_lines('server/metadataEngine.ts', 225, 238))

print("===")
print("resolvers.ts 34-43:")
print(extract_lines('server/resolvers.ts', 34, 43))
print("---")
print("resolvers.ts 51-60:")
print(extract_lines('server/resolvers.ts', 51, 60))

print("===")
print("taskWorker.ts 100-118:")
print(extract_lines('server/taskWorker.ts', 100, 118))
print("---")
print("taskWorker.ts 129-147:")
print(extract_lines('server/taskWorker.ts', 129, 147))

print("===")
print("universalScraper.ts 344-353:")
print(extract_lines('server/universalScraper.ts', 344, 353))
print("---")
print("universalScraper.ts 818-825:")
print(extract_lines('server/universalScraper.ts', 818, 825))
