FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      curl \
      openssh-client \
      postgresql-client \
      jq \
      tini \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 — the agent uses it to tail CloudWatch logs across Nelson ECS tenants
# (/ecs/prod-omena-nelson, /ecs/prod-salo-nelson, etc.). Task role grants read-only
# on /ecs/* and /aws/codebuild/* in the service stack. See .claude/knowledge/observability.yaml.
RUN ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) AWSCLI_ARCH=x86_64 ;; \
      arm64) AWSCLI_ARCH=aarch64 ;; \
      *) echo "unsupported arch $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWSCLI_ARCH}.zip" -o /tmp/awscliv2.zip \
 && unzip -q /tmp/awscliv2.zip -d /tmp \
 && /tmp/aws/install --bin-dir /usr/local/bin --install-dir /usr/local/aws-cli \
 && rm -rf /tmp/aws /tmp/awscliv2.zip \
 && aws --version

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# EFS mount point for git worktrees (provided by ECS task definition in prod)
RUN mkdir -p /work
VOLUME ["/work"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
