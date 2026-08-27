FROM node:22-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates wget git docker.io && \
    wget -q http://ftp.debian.org/debian/pool/main/o/openssl/libssl1.1_1.1.1w-0+deb11u1_amd64.deb && \
    dpkg -i libssl1.1_1.1.1w-0+deb11u1_amd64.deb && \
    rm -f libssl1.1_1.1.1w-0+deb11u1_amd64.deb

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3010

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci && npx prisma generate

COPY dist ./dist
COPY app.config.ts ./app.config.ts

EXPOSE 3010

CMD ["node", "dist/server.cjs"]
