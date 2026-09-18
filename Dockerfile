FROM node:24-alpine

# 装时区数据，让容器内日志时间是北京时间
# （业务逻辑本来就用 moment-timezone 强制 Shanghai，不影响功能，只是日志好看）
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone
ENV TZ=Asia/Shanghai

WORKDIR /app

# 先拷依赖清单，利用 docker layer cache：lockfile 没变就跳过 npm ci
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 只拷代码本身。config.js 不进镜像，运行时挂载
COPY index.js healthcheck.js ./
COPY lib ./lib
COPY platforms ./platforms
COPY services ./services

# Threads token 要落盘续期，这个目录必须对 node 用户可写
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

# 心跳超过 15 分钟没更新就判定不健康（配合 compose 的 restart 策略）
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s --retries=2 \
    CMD ["node", "healthcheck.js"]

CMD ["node", "index.js"]
