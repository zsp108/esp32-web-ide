// Package handlers 提供项目（Project）CRUD HTTP 接口。
package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

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
	if err := h.db.DB.Preload("Files").First(&project, "id = ?", id).Error; err != nil {
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
	sessionToken := c.GetHeader("X-Session-Token")
	if sessionToken == "" {
		sessionToken = c.Query("session_token")
	}
	if sessionToken == "" {
		c.JSON(http.StatusOK, []models.Project{})
		return
	}

	var projects []models.Project
	if err := h.db.DB.Where("session_token = ?", sessionToken).
		Order("created_at DESC").
		Find(&projects).Error; err != nil {
		h.logger.Error("查询项目列表失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "查询失败"})
		return
	}

	c.JSON(http.StatusOK, projects)
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

	result := h.db.DB.Delete(&models.Project{}, "id = ?", id)
	if result.Error != nil {
		h.logger.Error("删除项目失败", zap.Error(result.Error))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "删除失败"})
		return
	}
	if result.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "项目不存在"})
		return
	}

	// 同时级联删除关联文件（GORM 未配置级联时手动删除）
	h.db.DB.Delete(&models.ProjectFile{}, "project_id = ?", id)

	c.Status(http.StatusNoContent)
}
