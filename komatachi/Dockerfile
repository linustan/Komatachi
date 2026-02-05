FROM node:22-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS test
COPY tsconfig.json vitest.config.ts ./
COPY src/ src/
CMD ["npm", "test"]

FROM base AS build
COPY tsconfig.json tsconfig.build.json vitest.config.ts ./
COPY src/ src/
RUN npx tsc -p tsconfig.build.json

FROM node:22-slim AS app
WORKDIR /app
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY --from=build /app/package.json ./
CMD ["node", "dist/index.js"]
