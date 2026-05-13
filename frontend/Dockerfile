# ---- builder ----
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./
RUN npm install --no-audit --no-fund --legacy-peer-deps

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src

RUN npm run build

# ---- runtime ----
FROM nginx:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
