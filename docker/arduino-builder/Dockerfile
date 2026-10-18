FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive

RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list && \
    sed -i 's/security.ubuntu.com/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list && \
    apt-get update && apt-get install -y \
    curl python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 安装 Arduino CLI
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR=/usr/local/bin sh

# 配置 ESP32 国内官方极速镜像 (乐鑫官方 CDN 40MB/s)
RUN arduino-cli config init && \
    arduino-cli config add board_manager.additional_urls \
    https://jihulab.com/esp-mirror/espressif/arduino-esp32/-/raw/gh-pages/package_esp32_index_cn.json

# 预装 ESP32 核心 (包含 ESP32 / S2 / S3 / C3 / C6 等所有芯片)
RUN arduino-cli core update-index && \
    arduino-cli core install esp32:esp32@3.3.10-cn

COPY compile.sh /compile.sh
RUN chmod +x /compile.sh && arduino-cli lib update-index
WORKDIR /src
ENTRYPOINT ["/compile.sh"]
