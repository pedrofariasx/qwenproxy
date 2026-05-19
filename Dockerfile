FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 3000
ENV NODE_ENV=production PORT=3000

CMD ["npx", "tsx", "src/index.ts"]