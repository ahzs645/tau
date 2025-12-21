# syntax = docker/dockerfile:1

# Reference:
# - https://pnpm.io/docker
# - https://depot.dev/docs/container-builds/how-to-guides/optimal-dockerfiles/node-pnpm-dockerfile
# Adapted for monorepo with reference to:
# - https://pnpm.io/cli/deploy
#
# Build modes:
# - Default (INJECT_SOURCEMAPS=false): Standard build for OSS contributors
# - CI/CD (INJECT_SOURCEMAPS=true): Build + inject/upload source maps to PostHog

ARG NODE_VERSION=24.3.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="React Router"
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

FROM base AS build

# Build arg for optional source map injection (default: false for OSS contributors)
ARG INJECT_SOURCEMAPS=false

RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm fetch --frozen-lockfile
COPY package.json ./
COPY . .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm nx build ui

# Conditionally inject and upload source maps (CI/CD only)
# Uses Docker build secrets for PostHog credentials
# Runs the Nx sourcemaps target defined in apps/ui/project.json (uses npx internally)
RUN --mount=type=secret,id=POSTHOG_CLI_TOKEN \
    --mount=type=secret,id=POSTHOG_CLI_ENV_ID \
    if [ "$INJECT_SOURCEMAPS" = "true" ]; then \
      echo "Injecting and uploading source maps to PostHog..." && \
      export POSTHOG_CLI_TOKEN=$(cat /run/secrets/POSTHOG_CLI_TOKEN) && \
      export POSTHOG_CLI_ENV_ID=$(cat /run/secrets/POSTHOG_CLI_ENV_ID) && \
      pnpm nx run ui:sourcemaps; \
    else \
      echo "Skipping source map injection (INJECT_SOURCEMAPS=$INJECT_SOURCEMAPS)"; \
    fi

FROM build AS pruned

RUN pnpm --filter=@taucad/ui --prod deploy pruned --legacy

FROM base

WORKDIR /app
COPY --from=pruned /app/pruned /app
ENV NODE_ENV="production"
EXPOSE 3000
CMD [ "./node_modules/.bin/react-router-serve", "build/server/index.js" ]
