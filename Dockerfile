FROM node:24-alpine
WORKDIR /app
# Release identifier contract (main owns /api/diagnostics display):
# EVENTOUCH_BUILD_REVISION is [A-Za-z0-9_.-]{1,64} or "unknown".
# The default claims nothing: "unknown" means no source hash was recorded.
ARG EVENTOUCH_BUILD_REVISION=unknown
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY data/sample.json ./data/sample.json
RUN mkdir -p /data/db /data/storage \
    && chown node:node /data/db /data/storage \
    && chmod 700 /data/db /data/storage
# NODE_ENV=production: safe because the server gates the dev quick login to
# development only (server/runtime-security.ts, main-owned) and refuses it
# in production or when NODE_ENV is unset.
ENV NODE_ENV=production PORT=8776 DATA_DIR=/data/db STORAGE_DIR=/data/storage \
    EVENTOUCH_BUILD_REVISION=$EVENTOUCH_BUILD_REVISION
LABEL org.opencontainers.image.revision=$EVENTOUCH_BUILD_REVISION
EXPOSE 8776
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8776/api/readyz || exit 1
CMD ["node", "server/server.js"]
