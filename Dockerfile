FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci && npm cache clean --force

COPY . .

RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "const ps = process.env.PORT || ''; const m = /^\d+$/.test(ps); const p = m ? parseInt(ps, 10) : NaN; const port = (m && p >= 1 && p <= 65535) ? p : 3000; require('http').get('http://localhost:' + port + '/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]