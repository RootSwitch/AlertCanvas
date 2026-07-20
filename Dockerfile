# build stage: install production deps; compiles better-sqlite3 from source
# if no musl prebuild exists for this Node version
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# runtime
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=9162 \
    ALERTCANVAS_DATA=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY tools ./tools
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 9162
# The server speaks HTTP, or HTTPS when a cert exists in /data/certs - try both.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
    CMD wget -qO- "http://127.0.0.1:$PORT/api/health" || \
        wget -qO- --no-check-certificate "https://127.0.0.1:$PORT/api/health" || exit 1
CMD ["node", "server/server.js"]
