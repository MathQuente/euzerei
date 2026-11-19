FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm install --no-save --ignore-scripts prisma@7.10.1 && npm cache clean --force && chown -R node:node /app
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3333
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
