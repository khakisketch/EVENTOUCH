# New frontend (apps/web). Separate image from the API on purpose: the app
# has its own lockfile and build, and the API keeps serving with zero web
# downtime during a web deploy.
#
# Build context is the repository root so the app can be copied whole:
#   docker compose build web
FROM node:24-alpine AS build
WORKDIR /app
# The /api/* rewrite destination is baked into the build output, so the build
# needs the same API base the container will proxy to at runtime — not the
# loopback default developers build with on their laptops.
ARG EVENTOUCH_API_URL=http://127.0.0.1:8776
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
ENV EVENTOUCH_API_URL=$EVENTOUCH_API_URL
# No API needed at build time: all page data is fetched at request time.
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8777
# Whole build output: sources, configs and .next — the app keeps them
# together on purpose so `next start` resolves exactly what was built.
COPY --from=build /app ./
USER node
EXPOSE 8777
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8777/ || exit 1
CMD ["npx", "next", "start", "-p", "8777"]
