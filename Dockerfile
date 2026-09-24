# Game server image for Bloxity Legion (or any Docker host).
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Run as the image's non-root "node" user. data/ only matters when MONGODB_URI
# is unset (local JSON saves).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Legion injects PORT; 2567 is the local default.
ENV PORT=2567
EXPOSE 2567

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

# node as PID 1 receives SIGTERM directly, so Colyseus can drain on deploys.
CMD ["node", "src/index.js"]
