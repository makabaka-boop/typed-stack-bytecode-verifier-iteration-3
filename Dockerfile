# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY examples ./examples

USER node
ENTRYPOINT ["node", "dist/cli.js"]
