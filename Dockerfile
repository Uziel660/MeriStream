FROM node:20-slim

WORKDIR /app

# Instalar dependencias del sistema para better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copiar package.json e instalar
COPY package.json package-lock.json* ./
RUN npm install

# Copiar código
COPY . .

# Generar cliente Prisma
RUN npx prisma generate

# Puerto
EXPOSE 3000

# Comando: arrancar server + auto-queue de jobs
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx tools/fast-start.ts && npx tsx server.ts"]
