FROM node:24-alpine
WORKDIR /app
RUN mkdir -p /data && chown node:node /data /app
COPY --chown=node:node package.json ./
COPY --chown=node:node common ./common
COPY --chown=node:node services ./services
COPY --chown=node:node frontend ./frontend
USER node
ENV HOST=0.0.0.0 PORT=8083
EXPOSE 8083
CMD ["node", "services/gateway/main.mjs"]
