# ---- 构建阶段 ----
FROM golang:1.26-alpine AS builder

WORKDIR /app

# 配置国内 Go 模块代理
ENV GOPROXY=https://goproxy.cn,direct

# 缓存依赖层
COPY go.mod go.sum ./
RUN go mod download

# 复制源码并编译静态 Linux 二进制
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /server cmd/server/main.go

# ---- 运行阶段 ----
FROM alpine:3.19

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories \
    && apk add --no-cache ca-certificates git openssh-client tzdata

COPY --from=builder /server /server

ENTRYPOINT ["/server"]
