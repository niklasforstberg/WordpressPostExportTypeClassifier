FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY public ./public

ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
