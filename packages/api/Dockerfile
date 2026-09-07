# API Gateway — GraphQL + REST + FHIR
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.json tsconfig.build.json ./
COPY packages/ packages/
COPY domain-packs/ domain-packs/
COPY tests/ tests/
COPY tools/ tools/

RUN pnpm install --frozen-lockfile
RUN pnpm turbo build --filter=@openfoundry/api...

# Runtime stage
FROM node:24-alpine

# Apply OS security patches newer than the pinned base digest
# (openssl libcrypto3/libssl3 CVE-2026-45447, fixed in 3.5.7-r0).
RUN apk upgrade --no-cache libcrypto3 libssl3

ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision="${GIT_REVISION}"
ENV GIT_REVISION="${GIT_REVISION}"

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/domain-packs/ domain-packs/
COPY --from=builder /app/tests/ tests/
COPY --from=builder /app/tools/ tools/

RUN pnpm install --frozen-lockfile --prod \
    && rm -rf /root/.cache/node/corepack \
              /usr/local/lib/node_modules/npm \
              /usr/local/bin/npm /usr/local/bin/npx

USER node

EXPOSE 4000

CMD ["node", "packages/api/dist/server.js"]
