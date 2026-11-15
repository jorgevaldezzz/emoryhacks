FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY data/.gitkeep ./data/
COPY uploads/.gitkeep ./uploads/

ENV PORT=8787
ENV DATA_DIR=/data
ENV UPLOAD_DIR=/uploads

VOLUME ["/data", "/uploads"]
EXPOSE 8787

CMD ["node", "src/server.js"]
