# NallyClaw Telegram-first runtime for Render.
FROM oven/bun:1.4.2

WORKDIR /app

# Keep the complete Bun workspace available for package resolution.
COPY . .

# Temporary until the checked-in workspace lockfile is reconciled.
RUN bun install

ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000

# Public port only serves health + the authenticated Telegram webhook.
# The OpenCode agent API runs on loopback on a separate internal port.
CMD ["bun", "run", "packages/nally-telegram/src/server.ts"]
