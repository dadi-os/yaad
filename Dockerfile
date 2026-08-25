FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json drizzle.config.ts config.toml ./
COPY src ./src

RUN npm ci && npm run build

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY config.toml ./
COPY prompts ./prompts
COPY drizzle ./drizzle

EXPOSE 8080

CMD ["node", "dist/index.js"]
