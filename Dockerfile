FROM node:24-alpine

# Beijing time for the system clock. The app sets its time zones with moment-timezone anyway
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone
ENV TZ=Asia/Shanghai

WORKDIR /app

# Copy the lockfile first, so npm ci is cached until it changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Code only. config.js is mounted at runtime
COPY index.js healthcheck.js ./
COPY lib ./lib
COPY platforms ./platforms
COPY services ./services

# Threads tokens are written here, so the node user needs write access
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

# Unhealthy if the heartbeat is older than 15 minutes
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s --retries=2 \
    CMD ["node", "healthcheck.js"]

CMD ["node", "index.js"]
