FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY agent.js server.js ./
COPY plugins/ ./plugins/

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "server.js"]
