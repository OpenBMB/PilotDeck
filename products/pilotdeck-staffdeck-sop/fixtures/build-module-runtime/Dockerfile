FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs ./server.mjs
ENV MODULE_PORT=9000
EXPOSE 9000
CMD ["node", "server.mjs"]
