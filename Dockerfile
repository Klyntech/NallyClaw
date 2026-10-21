# NalClaw runtime image
# Keep the repository root as the build context: this is a Bun workspace monorepo.
FROM oven/bun:1.4.2

WORKDIR /app

# Install workspace dependencies first for better layer caching.
COPY package.json bun.lock ./
COPY packages ./packages
COPY services ./services
COPY patches ./patches
COPY script ./script
COPY .npmrc* ./

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000

# Render injects PORT at runtime. Start the existing OpenCode server command,
# not the CLI/TUI interactive mode.
CMD ["sh", "-c", "bun run --cwd packages/cli src/index.ts serve --hostname 0.0.0.0 --port ${PORT:-3000}"]
