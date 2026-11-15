FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
RUN npm ci --omit=dev

COPY api/src ./api/src
WORKDIR /app/api
ENV PORT=8787
EXPOSE 8787

CMD ["node", "src/server.js"]
