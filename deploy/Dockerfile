FROM node:24-alpine
WORKDIR /app
COPY server/ /app/server/
USER node
ENV PEARL_SERVER_HOST=0.0.0.0 PEARL_SERVER_PORT=8787 PEARL_ALLOW_CONTAINER_BIND=1 PEARL_DATA_DIR=/data PEARL_UPDATE_FILE=/app/server/update.json
EXPOSE 8787
CMD ["node", "server/index.mjs"]
