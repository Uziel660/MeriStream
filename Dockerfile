# Build the browser bundle and the bundled Node API from repository source.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY app.config.ts index.html postcss.config.js tailwind.config.ts tsconfig.json vite.config.ts ./
COPY server.ts ./server.ts
COPY public ./public
COPY src ./src
COPY server ./server

RUN npm run build

# Keep the runtime image separate from the compiler and test dependencies.
FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3010

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Prisma's generated client is produced against the same Debian/OpenSSL
# runtime in the build stage, without adding the Prisma CLI to production.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY app.config.ts ./app.config.ts

RUN mkdir -p data logs \
    && chown -R node:node /app

EXPOSE 3010

USER node

CMD ["node", "--max-old-space-size=512", "dist/server.cjs"]
