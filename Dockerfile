# The apitame container image, published as ghcr.io/albert-canfield/apitame (docs/deploy.md).
#
# It installs the npm package built from this checkout, packed by `npm pack` as `npm publish`
# packs it in the release workflow, so the image runs exactly the files npm ships, with the
# dependencies `npm install -g apitame` would install. Build and test it with:
#
#   docker build -t apitame:local .
#   IMAGE=apitame:local scripts/docker-smoke.sh
#
# Base images are pinned by digest in each FROM line, where Dependabot updates them: Node.js 22
# on Debian 13 (glibc, for the prebuilt better-sqlite3 binaries), and plain Debian 13 to run it.

# 1. Build and pack the package. The result is JavaScript, so this runs once, natively on the
#    build machine, for every target platform.
FROM --platform=$BUILDPLATFORM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS pack
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsup.config.ts README.md LICENSE THIRD_PARTY_NOTICES.md ./
COPY src ./src
RUN pnpm build \
 && mkdir /pack \
 && npm pack --pack-destination /pack \
 && mv /pack/apitame-*.tgz /pack/apitame.tgz

# 2. Install the package and its production dependencies for the target platform. No install
#    scripts run: better-sqlite3 ships prebuilt binaries, and only the one for this platform is
#    kept. The optional DuckDB driver is not installed (see docs/deploy.md to add it).
FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa AS install
COPY --from=pack /pack/apitame.tgz /tmp/apitame.tgz
RUN npm install --global --omit=dev --ignore-scripts --no-audit --no-fund /tmp/apitame.tgz \
 && cd /usr/local/lib/node_modules/apitame/node_modules/better-sqlite3 \
 && find prebuilds -type f ! -name "linux-$(node -p process.arch).node" -delete \
 && rm -rf deps src \
 && test -f "prebuilds/linux-$(node -p process.arch).node"

# 3. The runtime: Debian, the Node.js binary and apitame. No npm, npx, yarn or corepack.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
COPY --from=install /usr/local/bin/node /usr/local/bin/node
COPY --from=install /usr/local/lib/node_modules/apitame /usr/local/lib/node_modules/apitame
# A dedicated user with a fixed UID, so Kubernetes can check runAsNonRoot. /audit is the one place
# apitame may write (audit.file); a volume mounted there inherits this owner.
RUN ln -s ../lib/node_modules/apitame/dist/cli.js /usr/local/bin/apitame \
 && groupadd --gid 10001 apitame \
 && useradd --uid 10001 --gid 10001 --no-log-init --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin apitame \
 && install -d -o 10001 -g 10001 -m 0750 /audit \
 && install -d -m 0755 /config \
 && node --version && apitame --version

LABEL org.opencontainers.image.title="apitame" \
      org.opencontainers.image.description="Turn an OpenAPI spec or a SQL database into a safe, curated MCP server. Serves MCP over HTTP on port 8080." \
      org.opencontainers.image.source="https://github.com/albert-canfield/apitame" \
      org.opencontainers.image.documentation="https://github.com/albert-canfield/apitame/blob/main/docs/deploy.md" \
      org.opencontainers.image.licenses="MIT"

# Mount the folder with apitame.config.yaml (and the spec and skills it names) at /config.
ENV APITAME_CONFIG=/config/apitame.config.yaml
WORKDIR /config
USER 10001:10001
EXPOSE 8080

# Liveness only: GET /health answers {"ok":true} without authentication or details.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Inside a container apitame listens on all interfaces, so it refuses to start unless
# APITAME_HTTP_TOKEN or http.oauth is set. There is no switch to turn that off.
ENTRYPOINT ["apitame"]
CMD ["serve", "--transport", "http", "--host", "0.0.0.0", "--port", "8080"]
