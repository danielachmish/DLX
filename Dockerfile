# DLX — תמונה אחת לשרת ולממשק (multi-stage). בנייה: docker build -t dlx .
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# תעודת CA של פרוקסי ארגוני (אופציונלי): docker build --secret id=ca,src=ca.pem
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps apps
RUN pnpm --filter @dlx/web build

# שרת ה-API (tsx מריץ את ה-TypeScript ישירות — אין שלב קומפילציה נפרד שעלול לסטות מהבדיקות)
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY packages/core packages/core
COPY apps/api apps/api
WORKDIR /app/apps/api
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "--import", "tsx", "src/main.ts"]

# הממשק + HTTPS אוטומטי (Caddy): קבצים סטטיים, ו-/v1 מועבר לשרת
FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv

# גיבוי לילי מוצפן (scripts/backup.sh) — pg_dump + openssl
FROM postgres:16-alpine AS backup
RUN apk add --no-cache openssl
COPY scripts/backup.sh /backup.sh
ENTRYPOINT ["/bin/sh", "-c", "while true; do sh /backup.sh db 5432 /backups || echo BACKUP FAILED; sleep 86400; done"]
