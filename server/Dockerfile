# Multi-stage build (PLAN 7.1). Build context is the REPOSITORY ROOT (see
# docker-compose.yml), because the image carries two frontends: the technician
# console (server/public) and the separate admin portal (admin-portal/public).

FROM node:22-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app/server
# NODE_ENV=production makes AUTH_MODE=dev (the development sign-in form) fatal at
# startup: this image cannot run with a login bypass, whatever .env says.
ENV NODE_ENV=production

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./dist
COPY server/public ./public
COPY server/migrations ./migrations
COPY admin-portal/public /app/admin-portal/public

# Non-root. `node` (uid 1000) ships with the base image.
RUN mkdir -p /app/audit && chown -R node:node /app
USER node

# 8080 = agent application (app.<domain>), 8081 = admin portal (admin.<domain>).
EXPOSE 8080 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "Promise.all([process.env.PORT||8080,process.env.ADMIN_PORT||8081].map(p=>fetch('http://127.0.0.1:'+p+'/healthz'))).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
