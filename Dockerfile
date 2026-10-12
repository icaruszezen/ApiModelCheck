# 第一阶段：装全部依赖，构建前端。产物是纯静态文件，和目标平台无关，
# 所以总在构建机本身的平台上跑：构建 arm64 镜像时这一步不用走 QEMU 模拟，快得多
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 第二阶段：只带运行时依赖。服务端是 .ts，由 Node 自带的类型剥离直接运行，不用编译
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist/web ./dist/web
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
