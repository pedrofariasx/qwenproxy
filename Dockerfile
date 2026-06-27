FROM mcr.microsoft.com/playwright:v1.60.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci && npm cache clean --force

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data /app/qwen_profiles /tmp/playwright \
    && chown -R pwuser:pwuser /app /tmp/playwright \
    && chmod +x /app/docker-entrypoint.sh

VOLUME ["/app/data", "/app/qwen_profiles"]

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
