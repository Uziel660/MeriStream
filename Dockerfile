FROM node:22-slim
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends openssl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3010

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --omit=dev && npx prisma generate

COPY dist ./dist
COPY app.config.ts ./app.config.ts

EXPOSE 3010

CMD ["node", "--max-old-space-size=384", "dist/server.cjs"]
