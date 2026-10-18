FROM alpine:3.19

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories && apk add --no-cache ca-certificates

COPY server-linux-amd64 /server

ENTRYPOINT ["/server"]
