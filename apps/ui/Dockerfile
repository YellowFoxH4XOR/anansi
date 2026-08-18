# Mutation Lab — single always-on container (Coolify or any Docker host).
# One persistent process is what makes the in-memory mutation state correct:
# it survives across requests, and a container restart resets to baseline
# ("none"), which is exactly the safe state. Run exactly one replica — two
# would disagree about which mutation is live.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY *.ts ./
ENV PORT=4600
EXPOSE 4600
CMD ["npm", "start"]
