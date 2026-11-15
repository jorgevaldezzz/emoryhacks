FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json ./api/package.json
COPY typesense/package.json ./typesense/package.json
RUN npm ci --omit=dev

COPY api/src ./api/src
COPY typesense/src ./typesense/src
COPY api/data/.gitkeep ./api/data/
COPY api/uploads/.gitkeep ./api/uploads/
WORKDIR /app/api

ENV PORT=8787
ENV DATA_DIR=/data
ENV UPLOAD_DIR=/uploads

VOLUME ["/data", "/uploads"]
EXPOSE 8787

CMD ["node", "src/server.js"]
