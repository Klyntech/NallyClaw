# NalClaw runtime image for Render.
FROM oven/bun:1.4.2

WORKDIR /app

# The project is a Bun workspace monorepo; workspace manifests and root config
# files are required by package resolution, so keep the repository as context.
COPY . .

RUN bun install --frozen-lockfile

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000

# Render injects PORT at runtime. Start the existing HTTP server, not the TUI.
CMD ["sh", "-c", "bun run --cwd packages/cli src/index.ts serve --hostname 0.0.0.0 --port ${PORT:-3000}"]
