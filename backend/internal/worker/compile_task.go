// Package worker 定义 asynq 编译任务的 Payload 和 Handler。
package worker

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/hibiken/asynq"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/services"
)

// TaskCompile 是编译任务的类型字符串，用于 asynq 路由。
const TaskCompile = "build:compile"

// CompilePayload 是编译任务的参数负载。
type CompilePayload struct {
	BuildID   string `json:"build_id"`
	ProjectID string `json:"project_id"`
	Framework string `json:"framework"`
	BoardFQBN string `json:"board_fqbn"`
}

// CompileTaskHandler 处理编译任务。
type CompileTaskHandler struct {
	buildSvc *services.BuildService
	logger   *zap.Logger
}

// NewCompileTaskHandler 创建 CompileTaskHandler 实例。
func NewCompileTaskHandler(cfg *config.Config, database *db.Database, storage services.StorageBackend, logger *zap.Logger) (*CompileTaskHandler, error) {
	buildSvc, err := services.NewBuildService(cfg, database, storage, logger)
	if err != nil {
		return nil, fmt.Errorf("初始化 BuildService 失败: %w", err)
	}
	return &CompileTaskHandler{buildSvc: buildSvc, logger: logger}, nil
}

// HandleCompileTask 是 asynq 的 Handler 实现，负责解析 Payload 并调用 BuildService.Run。
func (h *CompileTaskHandler) HandleCompileTask(ctx context.Context, t *asynq.Task) error {
	var payload CompilePayload
	if err := json.Unmarshal(t.Payload(), &payload); err != nil {
		return fmt.Errorf("解析编译任务 Payload 失败: %w", err)
	}

	h.logger.Info("开始处理编译任务",
		zap.String("build_id", payload.BuildID),
		zap.String("project_id", payload.ProjectID),
		zap.String("framework", payload.Framework),
		zap.String("board", payload.BoardFQBN),
	)

	if err := h.buildSvc.Run(ctx, payload.BuildID, payload.ProjectID); err != nil {
		h.logger.Error("编译任务执行失败",
			zap.String("build_id", payload.BuildID),
			zap.Error(err),
		)
		// 返回 asynq.SkipRetry 防止自动重试（编译失败不应重试）
		return fmt.Errorf("%w: %v", asynq.SkipRetry, err)
	}

	h.logger.Info("编译任务完成", zap.String("build_id", payload.BuildID))
	return nil
}
