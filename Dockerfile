FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM mcr.microsoft.com/playwright:v1.62.0-noble
ARG BUILD_VERSION="dev"
ARG BUILD_ARCH="amd64"
LABEL io.hass.version="${BUILD_VERSION}" \
      io.hass.type="app" \
      io.hass.arch="${BUILD_ARCH}" \
      org.opencontainers.image.title="Home Assistant Screenshot" \
      org.opencontainers.image.description="Render Home Assistant dashboards as stable images"
ENV NODE_ENV=production \
    RUNTIME_MODE=standalone \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=dependencies --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser package.json ./
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser public ./public
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
EXPOSE 3000 8099
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/livez').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
