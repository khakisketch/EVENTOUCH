FROM node:24-alpine
WORKDIR /app
COPY server/ ./server/
COPY features/ ./features/
COPY styles/ ./styles/
COPY i18n/ ./i18n/
COPY data/sample.json ./data/sample.json
COPY index.html app.js ./
ENV PORT=8776 DATA_DIR=/data/db STORAGE_DIR=/data/storage
EXPOSE 8776
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8776/api/health || exit 1
CMD ["node", "server/server.js"]
