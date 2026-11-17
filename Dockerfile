# 关系复原胶：一个 Node 服务，房间与同步都在里面
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY tools ./tools
ENV PORT=5178
EXPOSE 5178
# 房间在内存里：单实例运行
CMD ["node", "server.mjs"]
