FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY *.ts ./
USER node
ENV PORT=4600
EXPOSE 4600
CMD ["./node_modules/.bin/tsx", "server.ts"]
