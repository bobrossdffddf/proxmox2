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
ENV NODE_OPTIONS=--openssl-legacy-provider

# VMware splits disks into 2 GB extents, and Proxmox cannot read that set in
# either form it accepts — not inside an OVA (it extracts one member) and not as
# separate uploads (it validates each file, and an extent alone is not a valid
# image). qemu-img merges them into one image here first. ~10 MB installed,
# from the community repo, which the node:*-alpine base already has enabled.
RUN apk add --no-cache qemu-img

# Reuse the already-resolved, pruned production tree from the builder stage.
# No second npm install means no second chance to fail.
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/index.js"]
