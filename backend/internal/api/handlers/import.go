// Package handlers provides the Git URL import handler.
package handlers

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
)

// ImportHandler handles Git URL project imports.
type ImportHandler struct {
	db     *db.Database
	logger *zap.Logger
}

// NewImportHandler creates a new ImportHandler.
func NewImportHandler(database *db.Database, logger *zap.Logger) *ImportHandler {
	return &ImportHandler{db: database, logger: logger}
}

// ImportFromGitRequest is the request body for importing a project from a Git URL.
type ImportFromGitRequest struct {
	GitURL    string `json:"git_url" binding:"required"`
	Branch    string `json:"branch"`              // optional, defaults to main/master
	Name      string `json:"name"`                // optional, derived from URL if empty
	Framework string `json:"framework" binding:"required"` // "arduino" | "espidf" | "idf"
	BoardFQBN string `json:"board_fqbn" binding:"required"`
	SubDir    string `json:"sub_dir"`             // optional, e.g. "platforms/esp32"
}

// ImportFromGit clones a Git repo and creates a project from it.
func (h *ImportHandler) ImportFromGit(c *gin.Context) {
	var req ImportFromGitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	sessionToken := c.GetHeader("X-Session-Token")
	if sessionToken == "" {
		sessionToken = c.Query("session_token")
	}
	if sessionToken == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "missing X-Session-Token header"})
		return
	}

	framework := req.Framework
	if framework == "idf" {
		framework = "espidf"
	}
	if framework != "arduino" && framework != "espidf" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "framework must be 'arduino' or 'espidf'"})
		return
	}

	// Clone repo to temp directory
	tmpDir, err := os.MkdirTemp("", "git-import-*")
	if err != nil {
		h.logger.Error("创建临时目录失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create temp directory"})
		return
	}
	defer os.RemoveAll(tmpDir)

	cloneDir := filepath.Join(tmpDir, "repo")

	// Build git clone command
	args := []string{"clone", "--recurse-submodules", "--depth=1"}
	if req.Branch != "" {
		args = append(args, "--branch", req.Branch)
	}
	args = append(args, req.GitURL, cloneDir)

	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.CombinedOutput()
	if err != nil {
		h.logger.Error("git clone 失败", zap.Error(err), zap.String("output", string(output)))
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "git clone failed",
			"details": string(output),
		})
		return
	}

	// Determine the project root (may be a subdirectory)
	projectRoot := cloneDir
	if req.SubDir != "" {
		projectRoot = filepath.Join(cloneDir, req.SubDir)
	}

	if fi, err := os.Stat(projectRoot); err != nil || !fi.IsDir() {
		h.logger.Error("项目根目录不存在", zap.String("project_root", projectRoot))
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "specified sub_dir does not exist or is not a directory",
		})
		return
	}

	// Derive project name from URL if not provided
	name := req.Name
	if name == "" {
		name = filepath.Base(req.GitURL)
		if ext := filepath.Ext(name); ext == ".git" {
			name = name[:len(name)-len(ext)]
		}
	}

	// Create the project record
	project := models.Project{
		ID:           uuid.New(),
		Name:         name,
		Description:  "Imported from " + req.GitURL,
		Framework:    framework,
		BoardFQBN:    req.BoardFQBN,
		SessionToken: sessionToken,
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}
	if err := h.db.DB.Create(&project).Error; err != nil {
		h.logger.Error("创建项目失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create project"})
		return
	}

	// Walk the project directory and create file records
	var fileCount int
	_ = filepath.Walk(projectRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			base := filepath.Base(path)
			// Skip hidden directories and common build/dependency directories
			if strings.HasPrefix(base, ".") || base == "build" || base == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		// Skip files larger than 1MB
		if info.Size() > 1*1024*1024 {
			return nil
		}
		// Skip hidden files
		if strings.HasPrefix(filepath.Base(path), ".") {
			return nil
		}
		// Read file content
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		relPath, _ := filepath.Rel(projectRoot, path)
		now := time.Now()
		pf := models.ProjectFile{
			ProjectID: project.ID,
			Path:      filepath.ToSlash(relPath),
			Content:   string(data),
			SizeBytes: info.Size(),
			CreatedAt: now,
			UpdatedAt: now,
		}
		if dbErr := h.db.DB.Create(&pf).Error; dbErr != nil {
			h.logger.Warn("保存文件失败", zap.String("path", relPath), zap.Error(dbErr))
			return nil
		}
		fileCount++
		return nil
	})

	c.JSON(http.StatusCreated, gin.H{
		"project_id": project.ID,
		"id":         project.ID,
		"name":       project.Name,
		"files":      fileCount,
		"message":    "Project imported successfully",
	})
}
