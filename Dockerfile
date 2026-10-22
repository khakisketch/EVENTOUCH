FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY data/sample.json ./data/sample.json
RUN mkdir -p /data/db /data/storage \
    && chown node:node /data/db /data/storage \
    && chmod 700 /data/db /data/storage
ENV PORT=8776 DATA_DIR=/data/db STORAGE_DIR=/data/storage
EXPOSE 8776
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8776/api/readyz || exit 1
CMD ["node", "server/server.js"]
