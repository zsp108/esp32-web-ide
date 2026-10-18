// Package services 提供编译业务逻辑。
package services

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
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

	// 更新为 running 状态
	s.db.DB.Model(&build).Update("status", models.BuildStatusRunning)
	s.publishLog(buildID, "[INFO] 编译任务开始")

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

	for _, f := range files {
		fullPath := filepath.Join(srcDir, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
			return s.failBuild(&build, buildID, err)
		}
		if err := os.WriteFile(fullPath, []byte(f.Content), 0644); err != nil {
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
	s.publishLog(buildID, fmt.Sprintf("[INFO] 使用镜像: %s", image))

	// 收集编译日志
	var logBuf strings.Builder
	opts := BuildOptions{
		Image:          image,
		Cmd:            cmd,
		Env:            env,
		TimeoutSec:     s.cfg.BuildTimeoutSeconds,
		NetworkEnabled: build.Framework == "espidf",
		Binds: []string{
			srcDir + ":/src:rw",
			outputDir + ":/output:rw",
			srcDir + ":/workspace:rw",
		},
		LogCallback: func(line string) {
			logBuf.WriteString(line + "\n")
			s.publishLog(buildID, line)
		},
	}

	buildErr := s.docker.RunBuild(ctx, opts)

	durationMs := time.Since(start).Milliseconds()
	fullLog := logBuf.String()

	if buildErr != nil {
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
		return buildErr
	}

	// 4. 上传编译产物：优先查找 merged-firmware.bin，回退到 firmware.bin
	binPath := resolveBinPath(srcDir, outputDir, build.Framework)
	binName := filepath.Base(binPath)
	binKey := fmt.Sprintf("builds/%s/%s", buildID, binName)
	binSize, uploadErr := s.uploadBin(ctx, binPath, binKey)
	if uploadErr != nil {
		s.logger.Warn("上传 bin 失败，编译仍标记为成功", zap.Error(uploadErr))
	}

	// 5. 更新编译记录为成功
	s.db.DB.Model(&build).Updates(map[string]interface{}{
		"status":          models.BuildStatusSuccess,
		"bin_storage_key": binKey,
		"bin_size_bytes":  binSize,
		"build_log":       fullLog,
		"duration_ms":     durationMs,
	})

	s.publishLog(buildID, fmt.Sprintf("[SUCCESS] 编译完成，耗时 %dms", durationMs))
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

// resolveBinPath 查找编译产物路径，优先查找 merged-firmware.bin，回退到 firmware.bin。
func resolveBinPath(srcDir, outputDir, framework string) string {
	mergedCandidates := []string{
		filepath.Join(outputDir, "merged-firmware.bin"),
		filepath.Join(srcDir, "output", "merged-firmware.bin"),
		filepath.Join(srcDir, "build", "merged-firmware.bin"),
	}
	for _, p := range mergedCandidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}

	var mergedFound string
	_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && info.Name() == "merged-firmware.bin" {
			mergedFound = path
			return filepath.SkipAll
		}
		return nil
	})
	if mergedFound != "" {
		return mergedFound
	}

	firmwareCandidates := []string{
		filepath.Join(outputDir, "firmware.bin"),
		filepath.Join(srcDir, "output", "firmware.bin"),
		filepath.Join(srcDir, "build", "firmware.bin"),
	}
	for _, p := range firmwareCandidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}

	var firmwareFound string
	_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && info.Name() == "firmware.bin" {
			firmwareFound = path
			return filepath.SkipAll
		}
		return nil
	})
	if firmwareFound != "" {
		return firmwareFound
	}

	if entries, err := os.ReadDir(outputDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() && strings.HasSuffix(e.Name(), ".bin") {
				return filepath.Join(outputDir, e.Name())
			}
		}
	}

	var anyBin string
	_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && strings.HasSuffix(info.Name(), ".bin") {
			anyBin = path
			return filepath.SkipAll
		}
		return nil
	})
	if anyBin != "" {
		return anyBin
	}

	if framework == "espidf" {
		return filepath.Join(outputDir, "merged-firmware.bin")
	}
	return filepath.Join(outputDir, "firmware.bin")
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

// failBuild 将编译记录更新为失败状态，并返回原始错误。
func (s *BuildService) failBuild(build *models.BuildRecord, buildID string, err error) error {
	s.db.DB.Model(build).Updates(map[string]interface{}{
		"status":    models.BuildStatusFailed,
		"error_msg": err.Error(),
	})
	s.publishLog(buildID, "[ERROR] "+err.Error())
	return err
}

// publishLog 通过 Redis Pub/Sub 发布编译日志行。
func (s *BuildService) publishLog(buildID, line string) {
	channel := "build:" + buildID + ":log"
	if err := s.redis.Publish(context.Background(), channel, line).Err(); err != nil {
		s.logger.Warn("发布日志失败", zap.String("channel", channel), zap.Error(err))
	}
}
