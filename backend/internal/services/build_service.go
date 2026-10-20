// Package services 提供编译业务逻辑。
package services

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
)

// BuildService 封装完整的编译业务流程。
type BuildService struct {
	cfg     *config.Config
	db      *db.Database
	storage StorageBackend
	docker  *DockerService
	redis   *redis.Client
	logger  *zap.Logger
}

// NewBuildService 创建 BuildService 实例。
func NewBuildService(cfg *config.Config, database *db.Database, storage StorageBackend, logger *zap.Logger) (*BuildService, error) {
	dockerSvc, err := NewDockerService(logger)
	if err != nil {
		return nil, err
	}

	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		opt = &redis.Options{Addr: "localhost:6379"}
	}
	rdb := redis.NewClient(opt)

	return &BuildService{
		cfg:     cfg,
		db:      database,
		storage: storage,
		docker:  dockerSvc,
		redis:   rdb,
		logger:  logger,
	}, nil
}

// Run 执行完整编译流程：
//  1. 将构建状态更新为 running
//  2. 从数据库加载源文件，写入临时目录
//  3. 调用 Docker 编译
//  4. 上传 bin 到存储后端
//  5. 更新 BuildRecord（success/failed/timeout）
func (s *BuildService) Run(ctx context.Context, buildID, projectID string) error {
	bID, _ := uuid.Parse(buildID)
	pID, _ := uuid.Parse(projectID)

	start := time.Now()

	// 1. 加载编译记录
	var build models.BuildRecord
	if err := s.db.DB.First(&build, "id = ?", bID).Error; err != nil {
		return fmt.Errorf("查找编译记录失败: %w", err)
	}

	timeoutSec := s.cfg.BuildTimeoutSeconds
	if build.TimeoutSeconds > 0 {
		timeoutSec = build.TimeoutSeconds
	} else if timeoutSec <= 0 {
		timeoutSec = 1200
	}

	// 更新为 running 状态
	s.db.DB.Model(&build).Update("status", models.BuildStatusRunning)
	s.publishProgress(buildID, 10, "正在准备项目源码...")
	s.publishLog(buildID, fmt.Sprintf("[INFO] 编译任务开始（后台运行中，超时上限: %d 秒 / %.1f 分钟）", timeoutSec, float64(timeoutSec)/60.0))

	// 2. 准备临时源码目录
	srcDir, err := os.MkdirTemp("", "esp32-build-*")
	if err != nil {
		return s.failBuild(&build, buildID, fmt.Errorf("创建临时目录失败: %w", err))
	}
	defer os.RemoveAll(srcDir)

	// 从数据库加载项目文件
	var files []models.ProjectFile
	if err := s.db.DB.Where("project_id = ?", pID).Find(&files).Error; err != nil {
		return s.failBuild(&build, buildID, fmt.Errorf("加载项目文件失败: %w", err))
	}
	if len(files) == 0 {
		return s.failBuild(&build, buildID, fmt.Errorf("项目没有源文件"))
	}

	// Arduino 项目：若主 .ino 位于根目录，写入同名子目录以符合 Arduino CLI 规范
	arduinoSubdir := ""
	if build.Framework != "espidf" {
		for _, f := range files {
			if strings.HasSuffix(f.Path, ".ino") && !strings.Contains(f.Path, "/") && !strings.Contains(f.Path, "\\") {
				arduinoSubdir = strings.TrimSuffix(f.Path, ".ino")
				break
			}
		}
	}

	for _, f := range files {
		targetRel := f.Path
		if arduinoSubdir != "" && !strings.HasPrefix(targetRel, arduinoSubdir+"/") {
			targetRel = filepath.Join(arduinoSubdir, targetRel)
		}
		fullPath := filepath.Join(srcDir, filepath.FromSlash(targetRel))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			return s.failBuild(&build, buildID, err)
		}
		var data []byte
		if strings.HasPrefix(f.Content, "base64:") {
			var err error
			data, err = base64.StdEncoding.DecodeString(strings.TrimPrefix(f.Content, "base64:"))
			if err != nil {
				return s.failBuild(&build, buildID, fmt.Errorf("解码文件 %s 失败: %w", f.Path, err))
			}
		} else {
			data = []byte(f.Content)
		}
		if err := os.WriteFile(fullPath, data, 0644); err != nil {
			return s.failBuild(&build, buildID, err)
		}
	}
	s.publishLog(buildID, fmt.Sprintf("[INFO] 已准备 %d 个源文件", len(files)))

	// 3. 创建输出目录并选择 Docker 镜像和编译配置
	outputDir := filepath.Join(srcDir, "output")
	if err := os.MkdirAll(outputDir, 0755); err != nil {
		return s.failBuild(&build, buildID, fmt.Errorf("创建输出目录失败: %w", err))
	}

	image, cmd, env := s.resolveImageAndCmd(&build, srcDir)
	s.publishProgress(buildID, 20, "启动沙箱容器编译...")
	s.publishLog(buildID, fmt.Sprintf("[INFO] 使用镜像: %s", image))

	var entrypoint []string
	customCmd := strings.TrimSpace(build.CustomCommand)
	if customCmd != "" {
		customScriptPath := filepath.Join(srcDir, "custom_compile.sh")
		scriptContent := fmt.Sprintf(`#!/bin/bash
set -e

find /src -name "._*" -delete 2>/dev/null || true

# 自动挂载预置离线组件
if [ ! -d "/src/third_party/lvgl" ] && [ -d "/opt/third_party/lvgl" ]; then
    mkdir -p /src/third_party
    cp -r /opt/third_party/lvgl /src/third_party/lvgl 2>/dev/null || ln -s /opt/third_party/lvgl /src/third_party/lvgl
fi

if [ -d "/src/platforms/esp32" ] && [ ! -d "/src/platforms/esp32/managed_components" ] && [ -d "/opt/managed_components" ]; then
    cp -r /opt/managed_components /src/platforms/esp32/managed_components 2>/dev/null || ln -s /opt/managed_components /src/platforms/esp32/managed_components
fi

export IDF_PATH=/opt/esp-idf
export IDF_TOOLS_PATH=/root/.espressif
if [ -f /opt/esp-idf/export.sh ]; then
    . /opt/esp-idf/export.sh >/dev/null 2>&1 || true
fi

SRC_DIR="${PROJECT_DIR:-/src}"
cd "$SRC_DIR"
if [ "$SRC_DIR" = "/src" ]; then
    echo "[Custom Command] 当前执行路径: 项目根目录 ($PWD)"
else
    echo "[Custom Command] 当前执行路径: 项目主工程目录 ($PWD，可通过 cd /src 返回根目录)"
fi
echo "[Custom Command] 执行自定义编译命令:"
echo "--------------------------------------------------"
echo "$ %s"
echo "--------------------------------------------------"

%s

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
    echo "[Custom Command] 命令执行失败，退出码: $EXIT_CODE"
    exit $EXIT_CODE
fi

echo "[Custom Command] 命令执行成功，正在收集编译产物..."
OUT_DIR="${OUTPUT_DIR:-/output}"
mkdir -p "$OUT_DIR"

# 查找所有生成的 bin 文件 (包括 $SRC_DIR, /src, 以及 arduino-cli 默认输出的 /tmp) 并复制到 /output
find "$SRC_DIR" /src /tmp -maxdepth 6 -type f -name "*.bin" ! -name "custom_compile.sh" -exec cp -f {} "$OUT_DIR/" \; 2>/dev/null || true

# 若包含 flash_project_args，尝试合成单个 merged-firmware.bin
if [ -f "$SRC_DIR/build/flash_project_args" ]; then
    echo "[Custom Command] 检测到 flash_project_args，正在生成合并固件..."
    cd "$SRC_DIR/build"
    TARGET="${IDF_TARGET:-esp32s3}"
    FLASH_SIZE="${FLASH_SIZE:-4MB}"
    esptool.py --chip "$TARGET" merge_bin \
        -o "$OUT_DIR/merged-firmware.bin" \
        --flash_mode dio \
        --flash_freq 80m \
        --flash_size "$FLASH_SIZE" \
        @flash_project_args 2>&1 || true
fi

echo "[Custom Command] 产物归档完毕，/output 目录列表:"
ls -lh "$OUT_DIR/" 2>/dev/null || true

BIN_COUNT=$(find "$OUT_DIR" -maxdepth 2 -type f -name "*.bin" 2>/dev/null | wc -l)
if [ "$BIN_COUNT" -eq 0 ]; then
    echo "[ERROR] [Custom Command] 编译命令虽已执行，但未能在项目或输出目录中检测到任何生成的 .bin 固件！"
    echo "💡 提示：若使用 arduino-cli，请在命令中添加 --output-dir /output 或确保编译生成了固件"
    exit 1
fi
`, customCmd, customCmd)

		if err := os.WriteFile(customScriptPath, []byte(scriptContent), 0755); err != nil {
			return s.failBuild(&build, buildID, fmt.Errorf("创建自定义编译脚本失败: %w", err))
		}
		entrypoint = []string{"/bin/bash", "/src/custom_compile.sh"}
		cmd = nil
		s.publishLog(buildID, fmt.Sprintf("[INFO] 启用自定义编译命令模式: %s", customCmd))
	}

	// 收集编译日志
	var logBuf strings.Builder
	lastPercent := 25
	libCacheDir := "/tmp/arduino-libraries"
	_ = os.MkdirAll(libCacheDir, 0777)

	opts := BuildOptions{
		Image:          image,
		Entrypoint:     entrypoint,
		Cmd:            cmd,
		Env:            env,
		TimeoutSec:     timeoutSec,
		NetworkEnabled: true,
		Binds: []string{
			srcDir + ":/src:rw",
			outputDir + ":/output:rw",
			srcDir + ":/workspace:rw",
			libCacheDir + ":/root/Arduino/libraries:rw",
		},
		LogCallback: func(line string) {
			logBuf.WriteString(line + "\n")
			s.publishLog(buildID, line)

			lower := strings.ToLower(line)
			if strings.Contains(line, "[Custom Command]") {
				if lastPercent < 40 {
					lastPercent = 40
					s.publishProgress(buildID, 40, "正在执行自定义编译命令...")
				}
			} else if strings.Contains(line, "[LIBRARY_DOWNLOAD]") || strings.Contains(line, "Downloading") || strings.Contains(line, "Installing") {
				stageText := line
				if idx := strings.Index(line, "[LIBRARY_DOWNLOAD]"); idx != -1 {
					stageText = strings.TrimSpace(line[idx+len("[LIBRARY_DOWNLOAD]"):])
				} else if idx := strings.Index(line, "Downloading"); idx != -1 {
					stageText = "下载依赖: " + strings.TrimSpace(line[idx+len("Downloading"):])
				} else if idx := strings.Index(line, "Installing"); idx != -1 {
					stageText = "安装依赖: " + strings.TrimSpace(line[idx+len("Installing"):])
				}
				s.publishProgress(buildID, 25, stageText)
			} else if strings.Contains(lower, "compiling sketch") || strings.Contains(lower, "compiling project") {
				if lastPercent < 35 {
					lastPercent = 35
					s.publishProgress(buildID, 35, "编译项目源码...")
				}
			} else if strings.Contains(lower, "compiling libraries") || strings.Contains(lower, "compiling library") {
				if lastPercent < 55 {
					lastPercent = 55
					s.publishProgress(buildID, 55, "编译依赖库...")
				}
			} else if strings.Contains(lower, "compiling core") {
				if lastPercent < 75 {
					lastPercent = 75
					s.publishProgress(buildID, 75, "编译核心框架...")
				}
			} else if strings.Contains(lower, "linking") || strings.Contains(lower, "building target") {
				if lastPercent < 88 {
					lastPercent = 88
					s.publishProgress(buildID, 88, "链接生成固件...")
				}
			} else if strings.Contains(lower, "generating") || strings.Contains(lower, "creating esp32 image") {
				if lastPercent < 92 {
					lastPercent = 92
					s.publishProgress(buildID, 92, "打包二进制固件...")
				}
			}
		},
	}

	// 创建可取消的上下文，并监听 Redis 中止信号
	runCtx, runCancel := context.WithCancel(ctx)
	defer runCancel()

	cancelSub := s.redis.Subscribe(ctx, "build:"+buildID+":cancel")
	defer cancelSub.Close()

	go func() {
		ch := cancelSub.Channel()
		select {
		case <-ch:
			s.logger.Info("收到编译任务中止信号", zap.String("build_id", buildID))
			runCancel()
		case <-runCtx.Done():
		}
	}()

	buildErr := s.docker.RunBuild(runCtx, opts)

	durationMs := time.Since(start).Milliseconds()
	fullLog := logBuf.String()

	if buildErr != nil {
		// 检查是否被用户主动中止
		if errors.Is(runCtx.Err(), context.Canceled) || s.isCancelled(buildID) {
			s.logger.Info("编译任务已由用户手动中止", zap.String("build_id", buildID))
			s.db.DB.Model(&build).Updates(map[string]interface{}{
				"status":      models.BuildStatusCancelled,
				"build_log":   fullLog,
				"duration_ms": durationMs,
				"error_msg":   "用户已手动中止编译任务",
			})
			s.publishLog(buildID, "[WARN] 编译任务已由用户手动中止")
			s.publishDone(buildID, "cancelled", "", "用户已手动中止编译任务")
			return nil
		}

		// 区分超时和编译失败
		status := models.BuildStatusFailed
		if strings.Contains(buildErr.Error(), "超时") {
			status = models.BuildStatusTimeout
		}
		s.db.DB.Model(&build).Updates(map[string]interface{}{
			"status":      status,
			"build_log":   fullLog,
			"duration_ms": durationMs,
			"error_msg":   buildErr.Error(),
		})
		s.publishLog(buildID, "[ERROR] "+buildErr.Error())
		s.publishDone(buildID, "failed", "", buildErr.Error())
		return buildErr
	}

	s.publishProgress(buildID, 95, "正在保存固件产物...")

	// 4. 上传编译产物：智能解析多段固件或单镜像固件
	segments, primaryKey, primarySize, processErr := s.processBuildArtifacts(ctx, buildID, srcDir, outputDir, build.BoardFQBN, build.Framework)
	if processErr != nil || len(segments) == 0 {
		errText := "未在项目输出目录中找到有效的 .bin 固件产物，编译失败"
		if processErr != nil {
			errText = processErr.Error()
		}
		s.logger.Error(errText, zap.String("build_id", buildID))
		s.db.DB.Model(&build).Updates(map[string]interface{}{
			"status":      models.BuildStatusFailed,
			"build_log":   fullLog + "\n[ERROR] " + errText,
			"duration_ms": durationMs,
			"error_msg":   errText,
		})
		s.publishLog(buildID, "[ERROR] "+errText)
		s.publishDone(buildID, "failed", "", errText)
		return errors.New(errText)
	}

	segmentsJSON, _ := json.Marshal(segments)

	// 5. 更新编译记录为成功
	s.db.DB.Model(&build).Updates(map[string]interface{}{
		"status":          models.BuildStatusSuccess,
		"bin_storage_key": primaryKey,
		"bin_size_bytes":  primarySize,
		"flash_segments":  string(segmentsJSON),
		"build_log":       fullLog,
		"duration_ms":     durationMs,
	})

	if len(segments) > 1 {
		s.publishLog(buildID, fmt.Sprintf("[INFO] 固件架构: 多段式烧录布局 (%d 个分段)", len(segments)))
		for _, seg := range segments {
			s.publishLog(buildID, fmt.Sprintf("  ├─ [0x%X] %s (%d KB)", seg.Offset, seg.Name, seg.Size/1024))
		}
	} else {
		s.publishLog(buildID, fmt.Sprintf("[INFO] 固件架构: 单镜像固件 [0x%X] %s (%d KB)", segments[0].Offset, segments[0].Name, segments[0].Size/1024))
	}

	s.publishLog(buildID, fmt.Sprintf("[SUCCESS] 编译完成，耗时 %dms", durationMs))
	s.publishProgress(buildID, 100, "编译成功")
	s.publishDone(buildID, "success", fmt.Sprintf("/api/v1/builds/%s/download", buildID), "")
	return nil
}

// resolveImageAndCmd 根据 framework 返回对应的 Docker 镜像、命令与环境变量。
func (s *BuildService) resolveImageAndCmd(build *models.BuildRecord, srcDir string) (string, []string, []string) {
	target, flashSize := resolveBoardParams(build.BoardFQBN)

	var env []string
	env = append(env, "OUTPUT_DIR=/output")

	if subdir := detectProjectSubdir(srcDir, build.Framework); subdir != "" {
		containerDir := "/src/" + filepath.ToSlash(subdir)
		env = append(env, "PROJECT_DIR="+containerDir)
		env = append(env, "ProjectDir="+containerDir)
	}

	env = append(env, "FLASH_SIZE="+flashSize)

	switch build.Framework {
	case "espidf":
		env = append(env, "IDF_TARGET="+target)
		return s.cfg.IDFBuilderImage, nil, env
	default: // arduino
		env = append(env, "BOARD_FQBN="+build.BoardFQBN)
		return s.cfg.ArduinoBuilderImage, nil, env
	}
}

// detectProjectSubdir 检测项目源码是否位于子目录（如 platforms/esp32）。
func detectProjectSubdir(srcDir, framework string) string {
	if fi, err := os.Stat(filepath.Join(srcDir, "platforms", "esp32")); err == nil && fi.IsDir() {
		return "platforms/esp32"
	}

	if framework == "espidf" {
		if _, err := os.Stat(filepath.Join(srcDir, "CMakeLists.txt")); err == nil {
			return ""
		}
		var found string
		_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
			if err != nil || found != "" {
				return nil
			}
			if !info.IsDir() && info.Name() == "CMakeLists.txt" {
				dir := filepath.Dir(path)
				rel, relErr := filepath.Rel(srcDir, dir)
				if relErr == nil && rel != "." && !strings.HasPrefix(rel, "build") && !strings.HasPrefix(rel, ".") {
					found = rel
					return filepath.SkipAll
				}
			}
			return nil
		})
		return found
	}

	if framework != "espidf" {
		var found string
		_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
			if err != nil || found != "" {
				return nil
			}
			if !info.IsDir() && strings.HasSuffix(info.Name(), ".ino") {
				dir := filepath.Dir(path)
				rel, relErr := filepath.Rel(srcDir, dir)
				if relErr == nil && rel != "." && !strings.HasPrefix(rel, ".") {
					found = rel
					return filepath.SkipAll
				}
			}
			return nil
		})
		if found != "" {
			return found
		}
	}

	return ""
}

// resolveBoardParams 根据 BoardFQBN 解析目标芯片和 Flash 大小。
func resolveBoardParams(boardFQBN string) (idfTarget, flashSize string) {
	switch boardFQBN {
	case "waveshare:esp32s3:touch_amoled_175c":
		return "esp32s3", "32MB"
	case "esp32:esp32:esp32s3_n16r8", "esp32:esp32:waveshare_esp32_s3_touch_lcd":
		return "esp32s3", "16MB"
	case "esp32:esp32:esp32s3", "esp32:esp32:waveshare_esp32_s3_zero":
		return "esp32s3", "8MB"
	case "esp32:esp32:esp32s2":
		return "esp32s2", "4MB"
	case "esp32:esp32:esp32c3", "esp32:esp32:waveshare_esp32_c3_zero":
		return "esp32c3", "4MB"
	case "esp32:esp32:esp32":
		return "esp32", "4MB"
	case "esp8266:esp8266:nodemcuv2":
		return "", "4MB"
	default:
		lower := strings.ToLower(boardFQBN)
		if strings.Contains(lower, "esp32s3") {
			if strings.Contains(lower, "16m") {
				return "esp32s3", "16MB"
			}
			return "esp32s3", "8MB"
		} else if strings.Contains(lower, "esp32s2") {
			return "esp32s2", "4MB"
		} else if strings.Contains(lower, "esp32c3") {
			return "esp32c3", "4MB"
		} else if strings.Contains(lower, "esp32") {
			return "esp32", "4MB"
		}
		return "esp32s3", "4MB"
	}
}

// rawSegment 内部临时结构
type rawSegment struct {
	offset   int64
	filename string
	absPath  string
	size     int64
}

// resolveBootloaderOffset 根据板型 FQBN 确定引导程序在 Flash 中的基地址。
func resolveBootloaderOffset(boardFQBN string) int64 {
	lower := strings.ToLower(boardFQBN)
	// 经典初代 ESP32 (非 s2/s3/c2/c3/c5/c6/h2/p4) 的 bootloader 偏移是 0x1000
	if strings.Contains(lower, "esp32:") {
		if strings.Contains(lower, "esp32s2") || strings.Contains(lower, "esp32s3") ||
			strings.Contains(lower, "esp32c2") || strings.Contains(lower, "esp32c3") ||
			strings.Contains(lower, "esp32c5") || strings.Contains(lower, "esp32c6") ||
			strings.Contains(lower, "esp32c61") || strings.Contains(lower, "esp32h2") ||
			strings.Contains(lower, "esp32p4") {
			return 0x0
		}
		return 0x1000
	}
	return 0x0
}

// processBuildArtifacts 智能分析产物目录中的 bin 文件，支持多段式布局和单镜像布局。
func (s *BuildService) processBuildArtifacts(ctx context.Context, buildID, srcDir, outputDir, boardFQBN, framework string) ([]models.FlashSegment, string, int64, error) {
	// 1. 查找全部生成的 .bin 文件，优先扫描 outputDir
	type binFile struct {
		name string
		path string
		size int64
	}

	var bins []binFile
	collectBins := func(dir string) {
		_ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return nil
			}
			// 忽略临时脚本与非 bin 文件
			if strings.HasSuffix(fi.Name(), ".bin") && fi.Name() != "custom_compile.sh" && fi.Size() > 0 {
				bins = append(bins, binFile{
					name: fi.Name(),
					path: p,
					size: fi.Size(),
				})
			}
			return nil
		})
	}

	collectBins(outputDir)
	// 若 outputDir 未能找到任何 bin，回退扫描 srcDir（但排除隐藏目录和 node_modules）
	if len(bins) == 0 {
		collectBins(srcDir)
	}

	if len(bins) == 0 {
		return nil, "", 0, fmt.Errorf("未在项目或输出目录中检测到任何生成的 .bin 固件")
	}

	var rawSegs []rawSegment

	// 2. 检查是否有 ESP-IDF 或 PlatformIO 的 flash_project_args
	var flashArgsPath string
	for _, p := range []string{
		filepath.Join(outputDir, "flash_project_args"),
		filepath.Join(srcDir, "build", "flash_project_args"),
		filepath.Join(srcDir, "flash_project_args"),
	} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			flashArgsPath = p
			break
		}
	}

	if flashArgsPath != "" {
		if f, err := os.Open(flashArgsPath); err == nil {
			defer f.Close()
			scanner := bufio.NewScanner(f)
			baseDir := filepath.Dir(flashArgsPath)
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if strings.HasPrefix(line, "0x") {
					parts := strings.Fields(line)
					if len(parts) >= 2 {
						offset, parseErr := strconv.ParseInt(parts[0], 0, 64)
						relPath := parts[1]
						if parseErr == nil {
							absP := filepath.Join(baseDir, relPath)
							if fi, sErr := os.Stat(absP); sErr == nil && !fi.IsDir() && fi.Size() > 0 {
								rawSegs = append(rawSegs, rawSegment{
									offset:   offset,
									filename: fi.Name(),
									absPath:  absP,
									size:     fi.Size(),
								})
							}
						}
					}
				}
			}
		}
	}

	// 3. 若未通过 flash_project_args 解析出分段，根据文件名模式智能识别
	if len(rawSegs) == 0 {
		var bootloaderFile *binFile
		var partitionFile *binFile
		var bootApp0File *binFile
		var mergedFile *binFile
		var appFiles []binFile

		for i := range bins {
			b := &bins[i]
			lower := strings.ToLower(b.name)
			if strings.Contains(lower, "merged") {
				mergedFile = b
			} else if strings.Contains(lower, "bootloader") {
				bootloaderFile = b
			} else if strings.Contains(lower, "partition") {
				partitionFile = b
			} else if strings.Contains(lower, "boot_app0") || strings.Contains(lower, "bootapp0") {
				bootApp0File = b
			} else {
				appFiles = append(appFiles, *b)
			}
		}

		// 如果同时具备 bootloader、partitions 以及 app，构建标准多段布局
		if bootloaderFile != nil && partitionFile != nil && len(appFiles) > 0 {
			rawSegs = append(rawSegs, rawSegment{
				offset:   resolveBootloaderOffset(boardFQBN),
				filename: bootloaderFile.name,
				absPath:  bootloaderFile.path,
				size:     bootloaderFile.size,
			})
			rawSegs = append(rawSegs, rawSegment{
				offset:   0x8000,
				filename: partitionFile.name,
				absPath:  partitionFile.path,
				size:     partitionFile.size,
			})
			if bootApp0File != nil {
				rawSegs = append(rawSegs, rawSegment{
					offset:   0xe000,
					filename: bootApp0File.name,
					absPath:  bootApp0File.path,
					size:     bootApp0File.size,
				})
			}
			// 主应用段
			mainApp := appFiles[0]
			rawSegs = append(rawSegs, rawSegment{
				offset:   0x10000,
				filename: mainApp.name,
				absPath:  mainApp.path,
				size:     mainApp.size,
			})
		} else if mergedFile != nil {
			// 单镜像已合包固件
			rawSegs = append(rawSegs, rawSegment{
				offset:   0x0,
				filename: mergedFile.name,
				absPath:  mergedFile.path,
				size:     mergedFile.size,
			})
		} else if len(bins) == 1 {
			// 仅有单一 bin 文件，作为单镜像
			rawSegs = append(rawSegs, rawSegment{
				offset:   0x0,
				filename: bins[0].name,
				absPath:  bins[0].path,
				size:     bins[0].size,
			})
		} else if len(appFiles) > 0 {
			// 兜底：若只有普通 app bin，单镜像写入
			rawSegs = append(rawSegs, rawSegment{
				offset:   0x0,
				filename: appFiles[0].name,
				absPath:  appFiles[0].path,
				size:     appFiles[0].size,
			})
		}
	}

	if len(rawSegs) == 0 {
		return nil, "", 0, fmt.Errorf("未能成功解析出有效的烧录分段")
	}

	// 4. 上传所有分段产物至存储后端
	var segments []models.FlashSegment
	var primaryKey string
	var totalSize int64

	for _, seg := range rawSegs {
		storageKey := fmt.Sprintf("builds/%s/%s", buildID, seg.filename)
		uploadedSize, err := s.uploadBin(ctx, seg.absPath, storageKey)
		if err != nil {
			return nil, "", 0, fmt.Errorf("存储分段 %s 失败: %w", seg.filename, err)
		}
		totalSize += uploadedSize
		segURL := fmt.Sprintf("/api/v1/builds/%s/artifacts/%s", buildID, seg.filename)
		segments = append(segments, models.FlashSegment{
			Offset: seg.offset,
			Name:   seg.filename,
			Size:   uploadedSize,
			URL:    segURL,
		})

		// 选择作为主固件的存储 Key（用于 /download 兼容）：优先选择偏移 0x10000 的 app 或 0x0 的 merged
		if primaryKey == "" || seg.offset == 0x10000 || (seg.offset == 0 && strings.Contains(seg.filename, "merged")) {
			primaryKey = storageKey
		}
	}

	if primaryKey == "" && len(segments) > 0 {
		primaryKey = fmt.Sprintf("builds/%s/%s", buildID, segments[0].Name)
	}

	return segments, primaryKey, totalSize, nil
}

// uploadBin 将编译产物上传到存储后端，返回文件大小（字节）。
func (s *BuildService) uploadBin(ctx context.Context, localPath, storageKey string) (int64, error) {
	data, err := os.ReadFile(localPath)
	if err != nil {
		return 0, fmt.Errorf("读取 bin 文件失败: %w", err)
	}
	size := int64(len(data))
	if err := s.storage.Put(ctx, storageKey, bytes.NewReader(data), size, "application/octet-stream"); err != nil {
		return 0, err
	}
	return size, nil
}

// WSMessage 定义 WebSocket 与 Redis 中存储的统一消息结构。
type WSMessage struct {
	Type    string `json:"type"`              // "log" | "progress" | "done"
	Level   string `json:"level,omitempty"`   // "info" | "error" | "warning"
	Text    string `json:"text,omitempty"`
	Percent int    `json:"percent,omitempty"`
	Stage   string `json:"stage,omitempty"`
	Status  string `json:"status,omitempty"`
	BinURL  string `json:"bin_url,omitempty"`
	Error   string `json:"error,omitempty"`
}

// publishMessage 统一负责消息推送：
//  1. 追加到 Redis 列表 (build:{id}:logs)，保留24小时，供掉线重连/新连接客户端完整回放历史日志
//  2. 记录当前最新进度 (build:{id}:progress) 和阶段 (build:{id}:stage)
//  3. 发布到 Redis Pub/Sub channel (build:{id}:log) 进行实时广播
func (s *BuildService) publishMessage(buildID string, msg WSMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	ctx := context.Background()
	jsonStr := string(data)

	// 1. 保留日志与事件至 Redis 列表（保留24小时），供离线/新加入的 WS 客户端与轮询即时回放
	listKey := "build:" + buildID + ":logs"
	s.redis.RPush(ctx, listKey, jsonStr)
	s.redis.Expire(ctx, listKey, 24*time.Hour)

	// 2. 缓存进度和阶段
	if msg.Percent > 0 {
		s.redis.Set(ctx, "build:"+buildID+":progress", msg.Percent, 24*time.Hour)
	}
	if msg.Stage != "" {
		s.redis.Set(ctx, "build:"+buildID+":stage", msg.Stage, 24*time.Hour)
	}

	// 3. 发布到 Redis Pub/Sub 广播实时推送
	channel := "build:" + buildID + ":log"
	if err := s.redis.Publish(ctx, channel, jsonStr).Err(); err != nil {
		s.logger.Warn("发布消息失败", zap.String("channel", channel), zap.Error(err))
	}
}

// publishLog 封装日志行推送。
func (s *BuildService) publishLog(buildID, line string) {
	level := "info"
	lower := strings.ToLower(line)
	if strings.Contains(line, "[ERROR]") || strings.Contains(lower, "error:") || strings.Contains(lower, "fatal error") {
		level = "error"
	} else if strings.Contains(line, "[WARN") || strings.Contains(lower, "warning:") {
		level = "warning"
	}
	s.publishMessage(buildID, WSMessage{
		Type:  "log",
		Level: level,
		Text:  line,
	})
}

// publishProgress 封装编译阶段进度推送。
func (s *BuildService) publishProgress(buildID string, percent int, stage string) {
	s.publishMessage(buildID, WSMessage{
		Type:    "progress",
		Percent: percent,
		Stage:   stage,
		Text:    stage,
	})
}

// publishDone 封装编译完成/失败事件推送。
func (s *BuildService) publishDone(buildID string, status string, binURL, errMsg string) {
	s.publishMessage(buildID, WSMessage{
		Type:    "done",
		Status:  status,
		BinURL:  binURL,
		Error:   errMsg,
		Percent: 100,
	})
}

// isCancelled 检查该编译任务是否已被标记为取消。
func (s *BuildService) isCancelled(buildID string) bool {
	res, err := s.redis.Get(context.Background(), "build:"+buildID+":cancelled").Result()
	return err == nil && res == "1"
}

// failBuild 将编译记录更新为失败状态，并返回原始错误。
func (s *BuildService) failBuild(build *models.BuildRecord, buildID string, err error) error {
	s.db.DB.Model(build).Updates(map[string]interface{}{
		"status":    models.BuildStatusFailed,
		"error_msg": err.Error(),
	})
	s.publishLog(buildID, "[ERROR] "+err.Error())
	s.publishDone(buildID, "failed", "", err.Error())
	return err
}
