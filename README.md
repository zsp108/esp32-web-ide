# ESP32 Web IDE

基于浏览器的 ESP32 在线开发环境，支持 Arduino 和 ESP-IDF 框架，无需本地安装任何工具链。

## ✨ 特性

- 🖥️ **Monaco 编辑器**（VS Code 同款）提供语法高亮和智能补全
- 📥 **Git 项目导入**：支持一键从 GitHub/GitLab 仓库导入工程
- 🔨 **云端编译**：Arduino / ESP-IDF 两种框架，Docker 隔离执行
- 📡 **Web Serial**：Chrome/Edge 直连 ESP32，一键刷写固件
- 🔄 **实时日志**：WebSocket 流式推送编译输出
- 📦 **无账号**：本地 UUID session，即开即用

## 🚀 快速启动（3 步）

```bash
# 1. 克隆仓库
git clone https://github.com/your-org/esp32-web-ide.git
cd esp32-web-ide

# 2. 配置环境变量
cp .env.example .env
# 按需修改 .env（默认配置开箱即用）

# 3. 启动所有服务
docker-compose up --build
```

访问 [http://localhost](http://localhost) 即可打开 IDE。

## 🛠️ 本地开发

### 前端

```bash
cd frontend
npm install
npm run dev        # 访问 http://localhost:3000
```

### 后端（Go）

```bash
cd backend
go run . -mode=server   # 启动 API 服务，监听 :8080
```

### 编译容器（可选预构建）

```bash
# 构建 Arduino 编译镜像（约 1.5 GB，首次构建较慢）
docker build -t esp32-ide/arduino-builder:latest docker/arduino-builder/

# 构建 ESP-IDF 编译镜像（约 3 GB）
docker build -t esp32-ide/idf-builder:latest docker/idf-builder/
```

## 🎯 支持的板型

| 板型 | FQBN | 框架 |
|------|------|------|
| ESP32 Dev Module | `esp32:esp32:esp32` | Arduino / IDF |
| ESP32-S3 | `esp32:esp32:esp32s3` | Arduino / IDF |
| ESP32-C3 | `esp32:esp32:esp32c3` | Arduino / IDF |
| ESP32-S2 | `esp32:esp32:esp32s2` | Arduino / IDF |
| Waveshare ESP32-S3-Zero | `esp32:esp32:waveshare_esp32_s3_zero` | Arduino / IDF |
| Waveshare ESP32-C3-Zero | `esp32:esp32:esp32c3` | Arduino / IDF |
| Waveshare ESP32-S3-Touch-LCD | `esp32:esp32:esp32s3` | Arduino / IDF |
| NodeMCU (ESP8266) | `esp8266:esp8266:nodemcuv2` | Arduino |
| Wemos D1 Mini | `esp8266:esp8266:d1_mini` | Arduino |

## 🌐 浏览器要求

Web Serial API 仅在部分浏览器中支持：

| 浏览器 | 编辑 & 编译 | 刷写固件 |
|--------|------------|---------|
| Chrome 89+ | ✅ | ✅ |
| Edge 89+ | ✅ | ✅ |
| Firefox | ✅ | ❌ |
| Safari | ✅ | ❌ |

> **注意**：固件刷写功能需要使用 Chrome 或 Edge，且必须通过 HTTPS 或 localhost 访问。

## 📁 项目结构

```
esp32-web-ide/
├── docker/
│   ├── arduino-builder/   # Arduino CLI 编译容器
│   └── idf-builder/       # ESP-IDF 编译容器
├── frontend/              # React + Vite + TypeScript
│   └── src/
│       ├── api/           # Axios API 封装
│       ├── hooks/         # useWebSerial, useWebSocket
│       └── pages/         # Home, Editor
├── backend/               # Go 后端（待实现）
├── nginx/                 # 反向代理配置
├── docker-compose.yml
└── .env.example
```

## 📄 License

MIT
