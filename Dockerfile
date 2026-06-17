FROM mcr.microsoft.com/playwright:v1.60.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY bin/ ./bin/
COPY src/ ./src/

RUN mkdir -p /app/data /app/qwen_profiles /tmp/playwright \
    && chown -R pwuser:pwuser /app /tmp/playwright

USER pwuser

VOLUME ["/app/data", "/app/qwen_profiles"]

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
