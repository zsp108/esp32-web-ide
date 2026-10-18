#!/bin/bash
set -e

REMOTE_HOST="172.30.180.112"
REMOTE_USER="spz"
REMOTE_TARGET="/data/esp32-web-ide"
ARCHIVE="/tmp/esp32-web-ide-deploy.tar.gz"

echo "=== 1. 打包项目代码（排除缓存和依赖） ==="
tar --exclude='.gomodcache' \
    --exclude='node_modules' \
    --exclude='.git' \
    -czf "$ARCHIVE" \
    -C "$(dirname "$0")/.." esp32-web-ide

echo "压缩包大小: $(ls -lh "$ARCHIVE" | awk '{print $5}')"

echo "=== 2. 上传至 $REMOTE_USER@$REMOTE_HOST ==="
scp "$ARCHIVE" "$REMOTE_USER@$REMOTE_HOST:/tmp/esp32-web-ide-deploy.tar.gz"

echo "=== 3. 部署到 100G 盘挂载点 /data/esp32-web-ide 并启动 ==="
ssh "$REMOTE_USER@$REMOTE_HOST" bash -s << 'EOF'
set -e
mkdir -p /data/esp32-web-ide
tar -xzf /tmp/esp32-web-ide-deploy.tar.gz -C /data/

# 建立用户主目录软链接，方便日常 cd ~/esp32-web-ide
ln -sfn /data/esp32-web-ide ~/esp32-web-ide

cd /data/esp32-web-ide

if [ ! -f .env ]; then
    echo "创建 .env 配置文件..."
    cp .env.example .env
fi

echo "启动 Docker 容器集群..."
docker compose up -d --build

echo "容器运行状态:"
docker compose ps
EOF

echo "=== 部署完成! ==="
