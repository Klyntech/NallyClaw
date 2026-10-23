FROM oven/bun:1.4.2

WORKDIR /app

# Native dependencies used by the existing CLI and its workspace packages.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ pkg-config libssl-dev \
  && rm -rf /var/lib/apt/lists/*

COPY . .

RUN bun install --frozen-lockfile
# The source-mode server serves the built web UI from packages/app/dist.
RUN bun run --cwd packages/app build

ENV NODE_ENV=production
EXPOSE 10000

CMD ["sh", "-c", "bun run --cwd packages/cli src/index.ts serve --hostname 0.0.0.0 --port ${PORT:-10000}"]
