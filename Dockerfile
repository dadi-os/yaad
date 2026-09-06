FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json drizzle.config.ts config.toml ./
COPY src ./src
RUN npm run build

FROM deps AS dev

COPY tsconfig.json drizzle.config.ts config.toml ./
COPY prompts ./prompts
COPY drizzle ./drizzle
# src/ and test/ arrive via Nas's bind mount, not COPY —
# this stage exists to have devDependencies (tsx, drizzle-kit, typescript) installed,
# not to hold a frozen copy of the source.
EXPOSE 8080
CMD ["npm", "run", "dev"]

FROM node:22-slim AS production

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY config.toml ./
COPY prompts ./prompts
COPY drizzle ./drizzle
EXPOSE 8080
CMD ["node", "dist/index.js"]
