# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json ./
# package-lock.json is optional; if it doesn't exist, npm install runs fresh.
COPY package-lock.json* ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && \
    mkdir -p dist/db && cp src/db/schema.sql dist/db/schema.sql && \
    npm prune --omit=dev --legacy-peer-deps

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

# Reuse the already-resolved, pruned production tree from the builder stage.
# No second npm install means no second chance to fail.
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
