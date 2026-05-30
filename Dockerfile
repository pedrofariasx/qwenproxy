# Stage 1: Builder -- install production dependencies
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force


# Stage 2: Runtime image
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Install dumb-init (signal handling) and curl (healthcheck)
RUN apt-get update && apt-get install -y dumb-init curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependencies and source from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY src ./src

# Create data directory and assign ownership to the non-root user
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser

# Healthcheck against the existing /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Declare volume for persistent data (SQLite database)
VOLUME ["/app/data"]

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

# Use dumb-init to avoid zombie processes from Playwright
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]