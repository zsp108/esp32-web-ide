# ---- 构建阶段 ----
FROM node:22-alpine AS builder

WORKDIR /app

# 配置国内 npm 镜像源加速
RUN npm config set registry https://registry.npmmirror.com

COPY package.json package-lock.json ./
RUN npm ci || npm install

COPY . .
RUN npm run build

# ---- 运行阶段 ----
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
