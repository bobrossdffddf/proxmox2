# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json ./
# package-lock.json is optional; if it doesn't exist, npm install runs fresh.
COPY package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && \
    mkdir -p dist/db && cp src/db/schema.sql dist/db/schema.sql

# ---- runtime ----
FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production

COPY package.json ./
COPY package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
