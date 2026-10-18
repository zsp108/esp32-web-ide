// Package handlers 提供编译任务相关的 HTTP 接口。
package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
	"github.com/esp32-web-ide/backend/internal/services"
	"github.com/esp32-web-ide/backend/internal/worker"
)

// BuildsHandler 处理编译任务相关请求。
type BuildsHandler struct {
	cfg         *config.Config
	db          *db.Database
	storage     services.StorageBackend
	asynqClient *asynq.Client
	redisClient *redis.Client
	logger      *zap.Logger
}

// NewBuildsHandler 创建 BuildsHandler 实例。
func NewBuildsHandler(cfg *config.Config, database *db.Database, storage services.StorageBackend, logger *zap.Logger) *BuildsHandler {
	client := asynq.NewClient(asynq.RedisClientOpt{Addr: redisAddrFromURL(cfg.RedisURL)})
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		opt = &redis.Options{Addr: redisAddrFromURL(cfg.RedisURL)}
	}
	rdb := redis.NewClient(opt)

	return &BuildsHandler{
		cfg:         cfg,
		db:          database,
		storage:     storage,
		asynqClient: client,
		redisClient: rdb,
		logger:      logger,
	}
}

// createBuildRequest 创建编译任务的请求体。
type createBuildRequest struct {
	ProjectID string `json:"project_id" binding:"required,uuid"`
	Framework string `json:"framework"`
	Board     string `json:"board"`
	BoardFQBN string `json:"board_fqbn"`
}

// Create godoc
// @Summary  创建编译任务
// @Tags     builds
// @Accept   json
// @Produce  json
// @Param    body  body      createBuildRequest  true  "编译请求"
// @Success  202   {object}  models.BuildRecord
// @Router   /api/v1/builds [post]
func (h *BuildsHandler) Create(c *gin.Context) {
	var req createBuildRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	projectID, _ := uuid.Parse(req.ProjectID)

	// 查询项目信息
	var project models.Project
	if err := h.db.DB.First(&project, "id = ?", projectID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}

	framework := project.Framework
	if req.Framework != "" {
		framework = req.Framework
	}
	boardFQBN := project.BoardFQBN
	if req.BoardFQBN != "" {
		boardFQBN = req.BoardFQBN
	} else if req.Board != "" {
		boardFQBN = req.Board
	}

	// 若用户切换了板型，同步更新项目默认板型配置
	if boardFQBN != project.BoardFQBN {
		h.db.DB.Model(&project).Update("board_fqbn", boardFQBN)
	}

	// 创建编译记录
	build := models.BuildRecord{
		ID:        uuid.New(),
		ProjectID: projectID,
		Status:    models.BuildStatusPending,
		Framework: framework,
		BoardFQBN: boardFQBN,
		CreatedAt: time.Now(),
	}
	if err := h.db.DB.Create(&build).Error; err != nil {
		h.logger.Error("创建编译记录失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建编译任务失败"})
		return
	}

	// 将任务入队
	payload, _ := json.Marshal(worker.CompilePayload{
		BuildID:   build.ID.String(),
		ProjectID: projectID.String(),
		Framework: framework,
		BoardFQBN: boardFQBN,
	})
	task := asynq.NewTask(worker.TaskCompile, payload)
	_, err := h.asynqClient.Enqueue(task, asynq.MaxRetry(0))
	if err != nil {
		h.logger.Error("任务入队失败", zap.Error(err))
		// 回滚：将状态设为 failed
		h.db.DB.Model(&build).Update("status", models.BuildStatusFailed)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "提交编译任务失败"})
		return
	}

	c.JSON(http.StatusAccepted, build)
}

// Get godoc
// @Summary  获取编译任务状态
// @Tags     builds
// @Produce  json
// @Param    id  path      string  true  "BuildRecord UUID"
// @Success  200 {object}  models.BuildRecord
// @Router   /api/v1/builds/{id} [get]
func (h *BuildsHandler) Get(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 Build ID"})
		return
	}

	var build models.BuildRecord
	if err := h.db.DB.First(&build, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "编译记录不存在"})
		return
	}

	timeout := time.Duration(h.cfg.BuildTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	if (build.Status == models.BuildStatusRunning || build.Status == models.BuildStatusPending) && time.Since(build.CreatedAt) > timeout+30*time.Second {
		build.Status = models.BuildStatusFailed
		build.ErrorMsg = "编译超时或服务异常中断"
		h.db.DB.Model(&build).Updates(map[string]interface{}{
			"status":    models.BuildStatusFailed,
			"error_msg": "编译超时或服务异常中断",
		})
	}

	progress := 0
	stage := ""
	if build.Status == models.BuildStatusRunning {
		p, _ := h.redisClient.Get(c.Request.Context(), "build:"+id.String()+":progress").Int()
		s, _ := h.redisClient.Get(c.Request.Context(), "build:"+id.String()+":stage").Result()
		progress = p
		stage = s
		if progress == 0 {
			progress = 10
			stage = "正在后台编译中..."
		}
	} else if build.Status == models.BuildStatusSuccess {
		progress = 100
		stage = "编译成功"
	} else if build.Status == models.BuildStatusFailed || build.Status == models.BuildStatusTimeout {
		stage = build.ErrorMsg
	}

	c.JSON(http.StatusOK, gin.H{
		"id":              build.ID,
		"project_id":      build.ProjectID,
		"status":          build.Status,
		"framework":       build.Framework,
		"board_fqbn":      build.BoardFQBN,
		"bin_storage_key": build.BinStorageKey,
		"bin_size_bytes":  build.BinSizeBytes,
		"flash_pct":       build.FlashPct,
		"ram_pct":         build.RAMPct,
		"build_log":       build.BuildLog,
		"duration_ms":     build.DurationMs,
		"error_msg":       build.ErrorMsg,
		"created_at":      build.CreatedAt,
		"progress":        progress,
		"stage":           stage,
	})
}

// Download godoc
// @Summary  下载编译产物（bin 文件）
// @Tags     builds
// @Param    id  path  string  true  "BuildRecord UUID"
// @Success  302
// @Router   /api/v1/builds/{id}/download [get]
func (h *BuildsHandler) Download(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 Build ID"})
		return
	}

	var build models.BuildRecord
	if err := h.db.DB.First(&build, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "编译记录不存在"})
		return
	}

	if build.Status != models.BuildStatusSuccess {
		c.JSON(http.StatusBadRequest, gin.H{"error": "编译尚未完成或未成功"})
		return
	}

	// 生成预签名 URL（有效期 15 分钟）
	presignURL, err := h.storage.PresignedURL(context.Background(), build.BinStorageKey, 15*time.Minute)
	if err != nil {
		h.logger.Error("生成预签名 URL 失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "无法生成下载链接"})
		return
	}

	// 本地存储模式（返回 file:// 协议）直接作为附件下发文件
	if strings.HasPrefix(presignURL, "file://") {
		filePath := strings.TrimPrefix(presignURL, "file://")
		filename := filepath.Base(filePath)
		if filename == "." || filename == "/" || filename == "" {
			filename = "firmware.bin"
		}
		c.FileAttachment(filePath, filename)
		return
	}

	c.Redirect(http.StatusFound, presignURL)
}

// Cancel godoc
// @Summary  取消编译任务
// @Tags     builds
// @Param    id  path  string  true  "BuildRecord UUID"
// @Success  204
// @Router   /api/v1/builds/{id} [delete]
func (h *BuildsHandler) Cancel(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的 Build ID"})
		return
	}

	var build models.BuildRecord
	if err := h.db.DB.First(&build, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "编译记录不存在"})
		return
	}

	// pending 或 running 状态的任务可以中止
	if build.Status != models.BuildStatusPending && build.Status != models.BuildStatusRunning {
		c.JSON(http.StatusBadRequest, gin.H{"error": "当前任务状态不是排队中或编译中，无法中止"})
		return
	}

	if err := h.db.DB.Model(&build).Updates(map[string]interface{}{
		"status":    models.BuildStatusCancelled,
		"error_msg": "用户已手动中止编译任务",
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "中止失败"})
		return
	}

	// 告知 Worker 立即停止 Docker 编译容器
	h.redisClient.Set(c.Request.Context(), "build:"+id.String()+":cancelled", "1", 10*time.Minute)
	h.redisClient.Publish(c.Request.Context(), "build:"+id.String()+":cancel", "cancel")

	// 广播 WebSocket 结束消息
	cancelMsg, _ := json.Marshal(map[string]interface{}{
		"type":   "done",
		"status": "cancelled",
		"stage":  "用户已手动中止编译任务",
		"error":  "用户已手动中止编译任务",
	})
	h.redisClient.Publish(c.Request.Context(), "build:"+id.String()+":log", cancelMsg)
	h.redisClient.RPush(c.Request.Context(), "build:"+id.String()+":logs", cancelMsg)

	c.JSON(http.StatusOK, gin.H{"message": "编译任务已成功中止"})
}

// ListByProject godoc
// @Summary  获取项目编译历史
// @Tags     builds
// @Produce  json
// @Param    id  path      string  true  "项目 UUID"
// @Success  200 {array}   models.BuildRecord
// @Router   /api/v1/projects/{id}/builds [get]
func (h *BuildsHandler) ListByProject(c *gin.Context) {
	projectID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的项目 ID"})
		return
	}

	var builds []models.BuildRecord
	if err := h.db.DB.Where("project_id = ?", projectID).
		Order("created_at DESC").
		Find(&builds).Error; err != nil {
		h.logger.Error("查询编译历史失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询失败"})
		return
	}

	timeout := time.Duration(h.cfg.BuildTimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}

	type BuildItem struct {
		models.BuildRecord
		Progress int    `json:"progress"`
		Stage    string `json:"stage"`
	}

	result := make([]BuildItem, len(builds))
	for i, b := range builds {
		if (b.Status == models.BuildStatusRunning || b.Status == models.BuildStatusPending) && time.Since(b.CreatedAt) > timeout+30*time.Second {
			b.Status = models.BuildStatusFailed
			b.ErrorMsg = "编译超时或服务异常中断"
			h.db.DB.Model(&models.BuildRecord{}).Where("id = ?", b.ID).Updates(map[string]interface{}{
				"status":    models.BuildStatusFailed,
				"error_msg": "编译超时或服务异常中断",
			})
		}

		progress := 0
		stage := ""
		if b.Status == models.BuildStatusRunning {
			p, _ := h.redisClient.Get(c.Request.Context(), "build:"+b.ID.String()+":progress").Int()
			s, _ := h.redisClient.Get(c.Request.Context(), "build:"+b.ID.String()+":stage").Result()
			progress = p
			stage = s
			if progress == 0 {
				progress = 10
				stage = "正在后台编译中..."
			}
		} else if b.Status == models.BuildStatusSuccess {
			progress = 100
			stage = "编译成功"
		} else if b.Status == models.BuildStatusFailed || b.Status == models.BuildStatusTimeout {
			stage = b.ErrorMsg
		}

		result[i] = BuildItem{
			BuildRecord: b,
			Progress:    progress,
			Stage:       stage,
		}
	}

	c.JSON(http.StatusOK, result)
}

// redisAddrFromURL 从 redis:// URL 提取 host:port。
// 例如 "redis://localhost:6379/0" → "localhost:6379"
func redisAddrFromURL(redisURL string) string {
	// 简单解析，生产中可用 url.Parse
	s := redisURL
	s = stripPrefix(s, "redis://")
	s = stripPrefix(s, "rediss://")
	// 去掉 /db 部分
	if idx := lastIndex(s, "/"); idx >= 0 {
		s = s[:idx]
	}
	return s
}

func stripPrefix(s, prefix string) string {
	if len(s) >= len(prefix) && s[:len(prefix)] == prefix {
		return s[len(prefix):]
	}
	return s
}

func lastIndex(s, substr string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == substr[0] {
			return i
		}
	}
	return -1
}
