FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
ENV PORT=8787
EXPOSE 8787

CMD ["node", "src/server.js"]
