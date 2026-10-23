// Package handlers 提供项目（Project）CRUD HTTP 接口。
package handlers

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
)

// ProjectsHandler 处理项目相关请求。
type ProjectsHandler struct {
	db     *db.Database
	logger *zap.Logger
}

// NewProjectsHandler 创建 ProjectsHandler 实例。
func NewProjectsHandler(database *db.Database, logger *zap.Logger) *ProjectsHandler {
	return &ProjectsHandler{db: database, logger: logger}
}

// createProjectRequest 创建项目的请求体。
type createProjectRequest struct {
	Name         string `json:"name" binding:"required,min=1,max=128"`
	Description  string `json:"description"`
	Framework    string `json:"framework" binding:"required"`
	BoardFQBN    string `json:"board_fqbn" binding:"required"`
	SessionToken string `json:"session_token"`
}

// Create godoc
// @Summary  创建新项目
// @Tags     projects
// @Accept   json
// @Produce  json
// @Param    body  body      createProjectRequest  true  "项目信息"
// @Success  201   {object}  models.Project
// @Router   /api/v1/projects [post]
func (h *ProjectsHandler) Create(c *gin.Context) {
	var req createProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	sessionToken := req.SessionToken
	if sessionToken == "" {
		sessionToken = c.GetHeader("X-Session-Token")
	}
	if sessionToken == "" {
		sessionToken = c.Query("session_token")
	}
	if sessionToken == "" {
		sessionToken = uuid.NewString()
	}

	project := models.Project{
		ID:           uuid.New(),
		Name:         req.Name,
		Description:  req.Description,
		Framework:    req.Framework,
		BoardFQBN:    req.BoardFQBN,
		SessionToken: sessionToken,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}

	if err := h.db.DB.Create(&project).Error; err != nil {
		h.logger.Error("创建项目失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建项目失败"})
		return
	}

	// 自动创建默认初始代码文件
	if req.Framework == "espidf" {
		cMakeContent := "cmake_minimum_required(VERSION 3.16)\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(" + req.Name + ")\n"
		mainC := `#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void) {
    printf("Hello from ESP32 Web IDE (ESP-IDF)!\n");
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
`
		_ = h.db.DB.Create(&models.ProjectFile{
			ProjectID: project.ID,
			Path:      "CMakeLists.txt",
			Content:   cMakeContent,
			SizeBytes: int64(len(cMakeContent)),
			UpdatedAt: time.Now(),
		})
		_ = h.db.DB.Create(&models.ProjectFile{
			ProjectID: project.ID,
			Path:      "main/main.c",
			Content:   mainC,
			SizeBytes: int64(len(mainC)),
			UpdatedAt: time.Now(),
		})
	} else {
		arduinoCode := `void setup() {
  Serial.begin(115200);
  Serial.println("Hello ESP32-S3 from Web IDE!");
}

void loop() {
  delay(1000);
}
`
		_ = h.db.DB.Create(&models.ProjectFile{
			ProjectID: project.ID,
			Path:      req.Name + ".ino",
			Content:   arduinoCode,
			SizeBytes: int64(len(arduinoCode)),
			UpdatedAt: time.Now(),
		})
	}

	c.JSON(http.StatusCreated, project)
}

// Get godoc
// @Summary  获取项目详情
// @Tags     projects
// @Produce  json
// @Param    id   path      string  true  "项目 UUID"
// @Success  200  {object}  models.Project
// @Router   /api/v1/projects/{id} [get]
func (h *ProjectsHandler) Get(c *gin.Context) {
	idStr := c.Param("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的项目 ID"})
		return
	}

	var project models.Project
	// 编辑器的基本配置不需要源码；保留默认行为以兼容已有 API 调用方。
	query := h.db.DB
	if c.Query("include_files") != "false" {
		query = query.Preload("Files")
	}
	if err := query.First(&project, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}

	c.JSON(http.StatusOK, project)
}

// ListBySession godoc
// @Summary  按 session_token 查询项目列表
// @Tags     projects
// @Produce  json
// @Param    session_token  query     string  true  "浏览器 session token"
// @Success  200            {array}   models.Project
// @Router   /api/v1/projects [get]
func (h *ProjectsHandler) ListBySession(c *gin.Context) {
	var projects []models.Project
	// 在自建 Web IDE 模式下，直接按创建时间倒序返回所有项目，避免因浏览器本地 session 变化导致已有项目在列表中不可见
	if err := h.db.DB.Order("created_at DESC").Find(&projects).Error; err != nil {
		h.logger.Error("查询项目列表失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询失败"})
		return
	}

	// 附带每个项目的最新编译任务信息，便于首页展示后台编译状态
	type ProjectResponse struct {
		models.Project
		LatestBuild *models.BuildRecord `json:"latest_build,omitempty"`
	}

	resp := make([]ProjectResponse, len(projects))

	for i, p := range projects {
		resp[i].Project = p
		var latest models.BuildRecord
		if err := h.db.DB.Where("project_id = ?", p.ID).Order("created_at DESC").First(&latest).Error; err == nil {
			buildTimeout := time.Duration(latest.TimeoutSeconds) * time.Second
			if buildTimeout <= 0 {
				buildTimeout = 20 * time.Minute
			}
			if (latest.Status == models.BuildStatusRunning || latest.Status == models.BuildStatusPending) && time.Since(latest.CreatedAt) > buildTimeout+30*time.Second {
				latest.Status = models.BuildStatusFailed
				latest.ErrorMsg = "编译超时或服务异常中断"
				h.db.DB.Model(&latest).Updates(map[string]interface{}{
					"status":    models.BuildStatusFailed,
					"error_msg": "编译超时或服务异常中断",
				})
			}
			resp[i].LatestBuild = &latest
		}
	}

	c.JSON(http.StatusOK, resp)
}

// Delete godoc
// @Summary  删除项目
// @Tags     projects
// @Param    id  path  string  true  "项目 UUID"
// @Success  204
// @Router   /api/v1/projects/{id} [delete]
func (h *ProjectsHandler) Delete(c *gin.Context) {
	idStr := c.Param("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的项目 ID"})
		return
	}

	err = h.db.DB.Transaction(func(tx *gorm.DB) error {
		// 1. 删除关联的编译历史记录
		if err := tx.Delete(&models.BuildRecord{}, "project_id = ?", id).Error; err != nil {
			return err
		}

		// 2. 删除关联的源码文件
		if err := tx.Delete(&models.ProjectFile{}, "project_id = ?", id).Error; err != nil {
			return err
		}

		// 3. 删除项目本体
		res := tx.Delete(&models.Project{}, "id = ?", id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}

		return nil
	})

	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
			return
		}
		h.logger.Error("删除项目失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("删除失败: %v", err)})
		return
	}

	c.Status(http.StatusNoContent)
}

// updateProjectRequest 更新项目配置的请求体
type updateProjectRequest struct {
	Name          string `json:"name"`
	Description   string `json:"description"`
	Framework     string `json:"framework"`
	BoardFQBN     string `json:"board_fqbn"`
	CustomCommand       string `json:"custom_command"`
	BuildTimeoutSeconds int    `json:"build_timeout_seconds"`
	GitURL              string `json:"git_url"`
	GitBranch     string `json:"git_branch"`
	GitSubDir     string `json:"git_sub_dir"`
}

// Update godoc
// @Summary  更新项目基本信息及关联的 Git 仓库
// @Tags     projects
// @Accept   json
// @Produce  json
// @Param    id    path      string                true  "项目 UUID"
// @Param    body  body      updateProjectRequest  true  "项目更新信息"
// @Success  200   {object}  models.Project
// @Router   /api/v1/projects/{id} [put]
func (h *ProjectsHandler) Update(c *gin.Context) {
	idStr := c.Param("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的项目 ID"})
		return
	}

	var req updateProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var project models.Project
	if err := h.db.DB.First(&project, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}

	updates := map[string]interface{}{
		"updated_at": time.Now(),
	}
	if req.Name != "" {
		updates["name"] = req.Name
	}
	if req.Description != "" {
		updates["description"] = req.Description
	}
	if req.Framework != "" {
		updates["framework"] = req.Framework
	}
	if req.BoardFQBN != "" {
		updates["board_fqbn"] = req.BoardFQBN
	}
	if req.CustomCommand != "" {
		updates["custom_command"] = req.CustomCommand
	}
	if req.BuildTimeoutSeconds > 0 {
		updates["build_timeout_seconds"] = req.BuildTimeoutSeconds
	}
	if req.GitURL != "" {
		updates["git_url"] = req.GitURL
	}
	if req.GitBranch != "" {
		updates["git_branch"] = req.GitBranch
	}
	if req.GitSubDir != "" {
		updates["git_sub_dir"] = req.GitSubDir
	}

	if err := h.db.DB.Model(&project).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "更新项目失败: " + err.Error()})
		return
	}

	_ = h.db.DB.First(&project, "id = ?", id)
	c.JSON(http.StatusOK, project)
}

// gitPullRequest Git Pull 请求体
type gitPullRequest struct {
	GitURL string `json:"git_url"`
	Branch string `json:"branch"`
	SubDir string `json:"sub_dir"`
}

// GitPull godoc
// @Summary  从关联的 Git 仓库拉取最新代码并同步更新项目源码
// @Tags     projects
// @Accept   json
// @Produce  json
// @Param    id    path      string          true  "项目 UUID"
// @Param    body  body      gitPullRequest  false "可选参数覆盖"
// @Success  200   {object}  map[string]interface{}
// @Router   /api/v1/projects/{id}/git-pull [post]
func (h *ProjectsHandler) GitPull(c *gin.Context) {
	idStr := c.Param("id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "无效的项目 ID"})
		return
	}

	var project models.Project
	if err := h.db.DB.First(&project, "id = ?", id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}

	var req gitPullRequest
	_ = c.ShouldBindJSON(&req)

	gitURL := project.GitURL
	if req.GitURL != "" {
		gitURL = req.GitURL
	}
	branch := project.GitBranch
	if req.Branch != "" {
		branch = req.Branch
	}
	subDir := project.GitSubDir
	if req.SubDir != "" {
		subDir = req.SubDir
	}

	if gitURL == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "该项目尚未关联远程 Git 仓库，请先在项目设置中配置 Git URL"})
		return
	}

	tmpDir, err := os.MkdirTemp("", "git-pull-*")
	if err != nil {
		h.logger.Error("创建临时目录失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建临时拉取目录失败"})
		return
	}
	defer os.RemoveAll(tmpDir)

	cloneDir := filepath.Join(tmpDir, "repo")
	args := []string{"clone", "--recurse-submodules", "--depth=1"}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, gitURL, cloneDir)

	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.CombinedOutput()
	if err != nil {
		outStr := strings.TrimSpace(string(output))
		if outStr == "" {
			outStr = err.Error()
		}
		h.logger.Error("git pull 失败", zap.Error(err), zap.String("output", outStr))
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "Git Pull 失败: " + outStr,
			"details": outStr,
		})
		return
	}

	projectRoot := cloneDir
	if subDir != "" {
		projectRoot = filepath.Join(cloneDir, subDir)
	}
	if fi, err := os.Stat(projectRoot); err != nil || !fi.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "指定的子目录不存在或不是文件夹"})
		return
	}

	// 提取 Commit Hash 和 Commit 信息
	commitHash := ""
	commitCmd := exec.Command("git", "-C", cloneDir, "rev-parse", "--short", "HEAD")
	if out, err := commitCmd.Output(); err == nil {
		commitHash = strings.TrimSpace(string(out))
	}

	commitMsg := ""
	msgCmd := exec.Command("git", "-C", cloneDir, "log", "-1", "--pretty=%s")
	if out, err := msgCmd.Output(); err == nil {
		commitMsg = strings.TrimSpace(string(out))
	}

	if branch == "" {
		branchCmd := exec.Command("git", "-C", cloneDir, "rev-parse", "--abbrev-ref", "HEAD")
		if out, err := branchCmd.Output(); err == nil {
			branch = strings.TrimSpace(string(out))
		}
	}

	// 读取当前项目在数据库中的现有文件
	var existingFiles []models.ProjectFile
	h.db.DB.Find(&existingFiles, "project_id = ?", project.ID)
	existingMap := make(map[string]models.ProjectFile)
	for _, f := range existingFiles {
		existingMap[f.Path] = f
	}

	newFilesMap := make(map[string]bool)
	var updatedCount, createdCount int
	now := time.Now()

	// 遍历 Git 仓库文件同步至数据库
	_ = filepath.Walk(projectRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			base := filepath.Base(path)
			if strings.HasPrefix(base, ".") || base == "build" || base == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if info.Size() > 50*1024*1024 || strings.HasPrefix(filepath.Base(path), ".") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		relPath, _ := filepath.Rel(projectRoot, path)
		cleanPath := filepath.ToSlash(relPath)
		newFilesMap[cleanPath] = true

		content := ""
		if isBinaryData(data) {
			content = "base64:" + base64.StdEncoding.EncodeToString(data)
		} else {
			content = string(data)
		}

		if existing, exists := existingMap[cleanPath]; exists {
			if existing.Content != content || existing.SizeBytes != info.Size() {
				h.db.DB.Model(&existing).Updates(map[string]interface{}{
					"content":    content,
					"size_bytes": info.Size(),
					"updated_at": now,
				})
				updatedCount++
			}
		} else {
			pf := models.ProjectFile{
				ProjectID: project.ID,
				Path:      cleanPath,
				Content:   content,
				SizeBytes: info.Size(),
				CreatedAt: now,
				UpdatedAt: now,
			}
			h.db.DB.Create(&pf)
			createdCount++
		}
		return nil
	})

	// 清理远程已被删除的旧文件
	var deletedCount int
	for oldPath, oldFile := range existingMap {
		if !newFilesMap[oldPath] {
			h.db.DB.Delete(&oldFile)
			deletedCount++
		}
	}

	// 更新项目信息
	h.db.DB.Model(&project).Updates(map[string]interface{}{
		"git_url":         gitURL,
		"git_branch":      branch,
		"git_sub_dir":     subDir,
		"git_commit_hash": commitHash,
		"updated_at":      now,
	})

	c.JSON(http.StatusOK, gin.H{
		"message":       fmt.Sprintf("Git 同步成功 (更新 %d, 新增 %d, 移除 %d 个文件)", updatedCount, createdCount, deletedCount),
		"commit_hash":   commitHash,
		"commit_msg":    commitMsg,
		"branch":        branch,
		"git_url":       gitURL,
		"updated_files": updatedCount,
		"created_files": createdCount,
		"deleted_files": deletedCount,
		"total_files":   len(newFilesMap),
	})
}
