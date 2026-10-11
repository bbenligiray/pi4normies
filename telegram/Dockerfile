# The bot itself (job containers use the repo's main Dockerfile).
# Node 24 runs the TypeScript sources directly.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
CMD ["node", "src/main.ts"]
