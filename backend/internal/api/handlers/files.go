// Package handlers 提供文件管理 HTTP 接口。
package handlers

import (
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
	"github.com/esp32-web-ide/backend/internal/services"
)

// FilesHandler 处理文件管理相关请求。
type FilesHandler struct {
	db      *db.Database
	storage services.StorageBackend
	logger  *zap.Logger
}

// NewFilesHandler 创建 FilesHandler 实例。
func NewFilesHandler(database *db.Database, storage services.StorageBackend, logger *zap.Logger) *FilesHandler {
	return &FilesHandler{db: database, storage: storage, logger: logger}
}

// UpsertFile godoc
// @Summary  上传或更新文件
// @Tags     files
// @Accept   multipart/form-data
// @Produce  json
// @Param    id    path      string  true  "项目 UUID"
// @Param    file  formData  file    true  "文件内容"
// @Param    path  formData  string  true  "文件相对路径"
// @Success  200   {object}  models.ProjectFile
// @Router   /api/v1/projects/{id}/files [put]
func (h *FilesHandler) UpsertFile(c *gin.Context) {
	projectID, err := parseProjectID(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 验证项目存在
	if err := h.ensureProjectExists(projectID); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}

	filePath := c.PostForm("path")
	if filePath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 path 参数"})
		return
	}
	// 清理路径，防止路径穿越
	filePath = strings.TrimPrefix(filePath, "/")

	// 读取文件内容（支持 multipart 或直接读 body）
	var content []byte
	uploadedFile, _, formErr := c.Request.FormFile("file")
	if formErr == nil {
		defer uploadedFile.Close()
		content, err = io.ReadAll(uploadedFile)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "读取文件失败"})
			return
		}
	} else {
		// 尝试直接读取请求体
		content, err = io.ReadAll(c.Request.Body)
		if err != nil || len(content) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "文件内容为空"})
			return
		}
	}

	// 查找已有记录（upsert 语义）
	var pf models.ProjectFile
	result := h.db.DB.Where("project_id = ? AND path = ?", projectID, filePath).First(&pf)
	now := time.Now()

	if result.Error != nil {
		// 新建
		pf = models.ProjectFile{
			ProjectID: projectID,
			Path:      filePath,
			Content:   string(content),
			SizeBytes: int64(len(content)),
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := h.db.DB.Create(&pf).Error; err != nil {
			h.logger.Error("创建文件记录失败", zap.Error(err))
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败"})
			return
		}
	} else {
		// 更新
		pf.Content = string(content)
		pf.SizeBytes = int64(len(content))
		pf.UpdatedAt = now
		if err := h.db.DB.Save(&pf).Error; err != nil {
			h.logger.Error("更新文件记录失败", zap.Error(err))
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败"})
			return
		}
	}

	c.JSON(http.StatusOK, pf)
}

// ListFiles godoc
// @Summary  获取项目文件列表
// @Tags     files
// @Produce  json
// @Param    id  path      string  true  "项目 UUID"
// @Success  200 {array}   models.ProjectFile
// @Router   /api/v1/projects/{id}/files [get]
func (h *FilesHandler) ListFiles(c *gin.Context) {
	projectID, err := parseProjectID(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var files []models.ProjectFile
	if err := h.db.DB.Where("project_id = ?", projectID).
		Select("id, project_id, path, size_bytes, created_at, updated_at"). // 不返回大字段 content
		Order("path").
		Find(&files).Error; err != nil {
		h.logger.Error("查询文件列表失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询失败"})
		return
	}

	c.JSON(http.StatusOK, files)
}

// GetFileContent godoc
// @Summary  获取文件内容
// @Tags     files
// @Produce  text/plain
// @Param    id    path  string  true  "项目 UUID"
// @Param    path  path  string  true  "文件路径"
// @Success  200   {string}  string
// @Router   /api/v1/projects/{id}/files/{path} [get]
func (h *FilesHandler) GetFileContent(c *gin.Context) {
	projectID, err := parseProjectID(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	filePath := strings.TrimPrefix(c.Param("path"), "/")

	var pf models.ProjectFile
	if err := h.db.DB.Where("project_id = ? AND path = ?", projectID, filePath).First(&pf).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在"})
		return
	}

	c.String(http.StatusOK, pf.Content)
}

// DeleteFile godoc
// @Summary  删除文件
// @Tags     files
// @Param    id    path  string  true  "项目 UUID"
// @Param    path  path  string  true  "文件路径"
// @Success  204
// @Router   /api/v1/projects/{id}/files/{path} [delete]
func (h *FilesHandler) DeleteFile(c *gin.Context) {
	projectID, err := parseProjectID(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	filePath := strings.TrimPrefix(c.Param("path"), "/")

	result := h.db.DB.Delete(&models.ProjectFile{}, "project_id = ? AND path = ?", projectID, filePath)
	if result.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在"})
		return
	}

	c.Status(http.StatusNoContent)
}

// RenameFileRequest 定义重命名请求体。
type RenameFileRequest struct {
	OldPath string `json:"old_path" binding:"required"`
	NewPath string `json:"new_path" binding:"required"`
}

// RenameFile 重命名项目文件
func (h *FilesHandler) RenameFile(c *gin.Context) {
	projectID, err := parseProjectID(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var req RenameFileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求参数格式错误，需提供 old_path 与 new_path"})
		return
	}

	oldPath := strings.TrimPrefix(strings.TrimSpace(req.OldPath), "/")
	newPath := strings.TrimPrefix(strings.TrimSpace(req.NewPath), "/")

	if oldPath == "" || newPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "文件名不能为空"})
		return
	}
	if oldPath == newPath {
		c.JSON(http.StatusOK, gin.H{"message": "文件名无变更"})
		return
	}

	// 检查目标文件是否已存在
	var count int64
	h.db.DB.Model(&models.ProjectFile{}).Where("project_id = ? AND path = ?", projectID, newPath).Count(&count)
	if count > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "目标文件名已存在，请换一个名称"})
		return
	}

	var pf models.ProjectFile
	if err := h.db.DB.Where("project_id = ? AND path = ?", projectID, oldPath).First(&pf).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "原文件不存在"})
		return
	}

	pf.Path = newPath
	pf.UpdatedAt = time.Now()
	if err := h.db.DB.Save(&pf).Error; err != nil {
		h.logger.Error("重命名文件失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "保存重命名失败"})
		return
	}

	c.JSON(http.StatusOK, pf)
}

// --- 辅助函数 ---

func parseProjectID(c *gin.Context) (uuid.UUID, error) {
	return uuid.Parse(c.Param("id"))
}

func (h *FilesHandler) ensureProjectExists(projectID uuid.UUID) error {
	return h.db.DB.Select("id").First(&models.Project{}, "id = ?", projectID).Error
}
