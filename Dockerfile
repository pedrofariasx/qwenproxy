FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# Install dumb-init to handle process signals correctly
RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy the rest of the application
COPY . .

# Set permissions and switch to non-root user
RUN mkdir -p /app/data /app/qwen_profiles && chown -R pwuser:pwuser /app
USER pwuser

VOLUME ["/app/data", "/app/qwen_profiles"]

EXPOSE 3000
ENV NODE_ENV=production \
    PORT=3000 \
    QWENPROXY_DATA_DIR=/app/data \
    USER_DATA_DIR=/app/qwen_profiles/global \
    QWENPROXY_PROFILES_DIR=/app/qwen_profiles

# Use dumb-init to avoid zombie processes from Playwright
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["npx", "tsx", "src/index.ts"]
