# ESP32 Web IDE

基于浏览器的轻量级、开箱即用 ESP32 在线集成开发环境（Web IDE）。支持 **Arduino** 与 **ESP-IDF** 双框架，无需在开发者本地配置繁琐的 GCC、Python、CMake 或 Arduino CLI 工具链，只需通过现代浏览器（Chrome / Edge）即可完成**代码编写、工程管理、云端容器隔离编译、固件多段智能刷写与串口调试**全流程。

---

## ✨ 核心特性

- 🖥️ **Monaco 代码编辑器**（VS Code 核心）：支持 C/C++ 语法高亮、智能代码补全、多文件编辑、目录树管理、文件创建/重命名与删除。
- 📥 **灵活的项目工程导入**：
  - **Git 仓库克隆**：支持一键从 GitHub/GitLab/Gitee 导入工程，支持指定分支与工程子目录，自带命令行详细错误捕获与网络超时保护。
  - **压缩包一键导入**：支持上传 `.tar`、`.tar.gz`、`.zip` 格式的本地工程包自动解压导入。
- 🔄 **Git 远程仓库一键同步 (Git Pull)**：
  - 界面直观显示关联仓库地址、分支名称与当前同步的 Commit Hash。
  - 支持一键执行 `Git Pull` 增量同步远程更新，自动识别远端变更、合并文件并实时刷新编辑器。
  - 支持随时为已有项目手动绑定或修改远程 Git 仓库配置。
- 🔨 **双框架云端容器编译 (Arduino & ESP-IDF)**：
  - **Arduino 模式**：内置 Arduino CLI 及国内极速 CDN 镜像源，预置常用库（Adafruit GFX、ST7789、LVGL 等）。
  - **ESP-IDF 模式**：基于乐鑫官方 ESP-IDF 容器环境编译。
  - **灵活编译模式**：支持标准自动编译或高级自定义编译指令（Custom Command）。
  - **固件智能分段**：自动生成单文件固件或包含 Bootloader (0x0)、分区表 (0x8000)、应用程序 (0x10000) 的多段固件清单。
- 📡 **Web Serial 硬件直连与智能固件刷写**：
  - 浏览器通过 Web Serial API 免驱动直连 ESP32 开发板。
  - **硬件预检与兼容性分析**：自动识别连接设备的芯片类型（ESP32、ESP32-S3、ESP32-C3 等）、Flash 容量、PSRAM 配置，并与编译目标对比提醒。
  - **智能多段烧录**：自适应单 Bin 写入与多段 Offset 精准写入，避免白屏或分区偏移。
- 📊 **实时日志流式推送**：基于 WebSocket 流式输出编译与烧录日志，支持后台异步编译与随时中断任务。
- 📦 **免账号 Session 设计**：采用浏览器本地 UUID Session 机制，即开即用，隐私安全。

---

## 🎯 支持板型与框架

| 板型名称 | FQBN / 标识 | 支持框架 | 典型配置 |
| :--- | :--- | :--- | :--- |
| **ESP32 Dev Module** | `esp32:esp32:esp32` | Arduino / ESP-IDF | 双核 Xtensa LX6，4MB Flash |
| **ESP32-S3 DevKit** | `esp32:esp32:esp32s3` | Arduino / ESP-IDF | 双核 Xtensa LX7，支持 USB-CDC |
| **ESP32-S3 N16R8** | `esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi` | Arduino / ESP-IDF | 16MB Flash, 8MB OPI PSRAM |
| **ESP32-C3 DevKit** | `esp32:esp32:esp32c3` | Arduino / ESP-IDF | 单核 RISC-V，4MB Flash |
| **ESP32-S2 DevKit** | `esp32:esp32:esp32s2` | Arduino / ESP-IDF | 单核 Xtensa LX7，支持原生 USB |
| **Waveshare AMOLED 1.75C** | `waveshare:esp32s3:touch_amoled_175c` | Arduino / ESP-IDF | ESP32-S3 触控彩屏开发板 |
| **NodeMCU (ESP8266)** | `esp8266:esp8266:nodemcuv2` | Arduino | ESP8266 经典开发板 |
| **Wemos D1 Mini** | `esp8266:esp8266:d1_mini` | Arduino | 便携式 ESP8266 模块 |

---

## 🌐 浏览器支持

固件烧录及硬件预检依赖现代浏览器的 **Web Serial API**，且要求必须在 **HTTPS** 或 **localhost** 安全上下文下运行：

| 浏览器 | 编辑 & 编译 | Web Serial 固件烧录 & 串口监视 |
| :--- | :---: | :---: |
| **Google Chrome (89+)** | ✅ 完全支持 | ✅ 支持 |
| **Microsoft Edge (89+)** | ✅ 完全支持 | ✅ 支持 |
| **Firefox** | ✅ 支持 | ❌ (内核不支持 Web Serial) |
| **Safari** | ✅ 支持 | ❌ (内核不支持 Web Serial) |

---

## 📁 项目完整架构

```
esp32-web-ide/
├── backend/                  # Go 后端微服务
│   ├── cmd/
│   │   └── server/
│   │       └── main.go       # 程序入口（支持 -mode=server API 服务 与 -mode=worker 编译 Worker）
│   ├── internal/
│   │   ├── api/              # RESTful API 路由及 WebSocket 处理
│   │   │   ├── handlers/     # 控制器（项目、源码文件、编译、Git 导入/同步、压缩包导入）
│   │   │   └── middleware/   # CORS、全局异常捕获、限流中间件
│   │   ├── config/           # Viper 配置加载与环境变量映射
│   │   ├── db/               # PostgreSQL 数据库连接与 GORM 模型自动迁移
│   │   ├── models/           # 数据模型（Project、ProjectFile、BuildRecord）
│   │   ├── services/         # 存储管理（本地目录 / MinIO / OSS）、编译任务封装
│   │   └── worker/           # 基于 Redis Asynq 的分布式编译任务队列消费者
│   ├── Dockerfile            # 后端 Alpine 运行时镜像构建文件
│   └── go.mod / go.sum       # Go 依赖清单
├── frontend/                 # 前端单页面应用 (SPA)
│   ├── src/
│   │   ├── api/              # Axios API 封装与拦截器
│   │   ├── hooks/            # useWebSerial（固件烧录与硬件检测）、useWebSocket（日志流）
│   │   └── pages/            # Home（项目列表与导入）、Editor（Monaco 编辑器与烧录控制台）
│   ├── Dockerfile            # 前端 Nginx 静态托管容器构建文件
│   └── package.json          # 前端依赖配置
├── docker/                   # 独立沙箱编译环境 Dockerfile
│   ├── arduino-builder/      # Arduino CLI 编译沙箱（预置极速 CDN 与常用 ESP32 依赖库）
│   └── idf-builder/          # 乐鑫官方 ESP-IDF 编译沙箱
├── nginx/                    # 反向代理与网关
│   ├── nginx.conf            # SSL 配置、Docker 内部动态 DNS resolver 解析、WebSocket 代理
│   └── certs/                # HTTPS 自签名 / 正式 SSL 证书目录
├── docker-compose.yml        # Docker 生产容器编排文件
├── deploy.sh                 # 一键远程自动化打包部署脚本
└── .env.example              # 环境变量配置模板
```

---

## 🚀 部署与启动指南

### 方式一：Docker Compose 一键部署（推荐生产/自建使用）

#### 1. 克隆代码与配置环境变量
```bash
git clone https://github.com/zsp108/esp32-web-ide.git
cd esp32-web-ide
cp .env.example .env
# 按需修改 .env 中的配置（如端口、Redis、PostgreSQL 密码等，默认已可开箱即用）
```

#### 2. 构建前后端产物
由于后端基于轻量级 Alpine 镜像（容器内不需要预装庞大的 Go 编译链），前端使用轻量级 Nginx 镜像，推荐在宿主机完成构建：

```bash
# 1) 编译前端静态产物
cd frontend
npm install
npm run build
cd ..

# 2) 交叉编译 Linux AMD64 后端二进制
cd backend
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o server-linux-amd64 cmd/server/main.go
cd ..
```

#### 3. 构建编译沙箱镜像（一次性操作）
通过 Docker Compose 的 `builders` Profile 构建一次编译镜像：
```bash
# 构建 Arduino 编译沙箱
docker compose --profile builders build arduino-builder

# 构建 ESP-IDF 编译沙箱（按需构建）
docker compose --profile builders build idf-builder
```

#### 4. 启动所有服务容器
```bash
docker compose up -d
```
启动后包含以下容器集群：
- `esp32-web-ide-frontend-1`: 前端页面服务 (端口 80)
- `esp32-web-ide-backend-1`: Go API 服务 (端口 8080)
- `esp32-web-ide-worker-1` / `worker-2`: 编译任务分布式消费者
- `esp32-web-ide-postgres-1`: PostgreSQL 数据库 (端口 5432)
- `esp32-web-ide-redis-1`: Redis 任务队列与缓存 (端口 6379)
- `esp32-web-ide-nginx-1`: SSL 反向代理入口 (端口 443 / 自定义映射)

访问 `https://<你的服务器IP或域名>` 即可开始使用。

---

### 方式二：本地研发与调试

如果需要在本地开发调试前端或后端功能：

#### 1. 启动基础依赖（PostgreSQL & Redis）
```bash
docker run -d --name local-postgres -p 5432:5432 -e POSTGRES_USER=esp32ide -e POSTGRES_PASSWORD=esp32ide_pass -e POSTGRES_DB=esp32ide postgres:15-alpine
docker run -d --name local-redis -p 6379:6379 redis:7-alpine
```

#### 2. 启动 Go 后端服务
```bash
cd backend
cp ../.env.example .env

# 终端 1：启动 API 接口服务
go run ./cmd/server -mode=server

# 终端 2：启动编译任务 Worker（需本地安装并启动 Docker）
go run ./cmd/server -mode=worker
```

#### 3. 启动前端开发服务器
```bash
cd frontend
npm install
npm run dev
# 访问 http://localhost:5173
```

---

## 🛠️ 常见运维与管理

### 远程自动化更新与部署
项目提供了 `deploy.sh` 脚本，可快速将本地源码打包、上传并部署至远程 Linux 服务器：
```bash
chmod +x deploy.sh
./deploy.sh
```

### 查看实时服务与编译日志
```bash
# 查看后端 API 日志
docker logs -f esp32-web-ide-backend-1

# 查看 Worker 编译执行日志
docker logs -f esp32-web-ide-worker-1

# 查看 Nginx 访问与错误日志
docker logs -f esp32-web-ide-nginx-1
```

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 授权许可。
