// Package handlers provides the Git URL and archive import handlers.
package handlers

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
)

// ImportHandler handles project imports from Git URLs or Archive files (tar/tar.gz/zip).
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
	Branch    string `json:"branch"`                      // optional, defaults to main/master
	Name      string `json:"name"`                        // optional, derived from URL if empty
	Framework string `json:"framework" binding:"required"` // "arduino" | "espidf" | "idf"
	BoardFQBN string `json:"board_fqbn" binding:"required"`
	SubDir    string `json:"sub_dir"`                     // optional, e.g. "platforms/esp32"
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
		sessionToken = "anonymous"
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
		outStr := strings.TrimSpace(string(output))
		errMsg := outStr
		if errMsg == "" {
			errMsg = err.Error()
		}
		h.logger.Error("git clone 失败", zap.Error(err), zap.String("output", outStr))
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "git clone 失败: " + errMsg,
			"details": errMsg,
		})
		return
	}

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

	var fileCount int
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
		if info.Size() > 50*1024*1024 { // 允许最大 50MB 资源文件
			return nil
		}
		if strings.HasPrefix(filepath.Base(path), ".") {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		relPath, _ := filepath.Rel(projectRoot, path)
		content := ""
		if isBinaryData(data) {
			content = "base64:" + base64.StdEncoding.EncodeToString(data)
		} else {
			content = string(data)
		}
		now := time.Now()
		pf := models.ProjectFile{
			ProjectID: project.ID,
			Path:      filepath.ToSlash(relPath),
			Content:   content,
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

// archiveEntry 存储从压缩包解压出的文件信息。
type archiveEntry struct {
	path string
	data []byte
	size int64
}

// isBinaryData 快速判断字节流是否包含二进制内容。
func isBinaryData(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	for i := 0; i < n; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return !utf8.Valid(data[:n])
}

// ImportArchive 处理 Tar / Tar.gz / Tgz / Zip 压缩包导入请求。
func (h *ImportHandler) ImportArchive(c *gin.Context) {
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请选择要上传的项目压缩包文件 (file)"})
		return
	}

	sessionToken := c.GetHeader("X-Session-Token")
	if sessionToken == "" {
		sessionToken = c.Query("session_token")
	}
	if sessionToken == "" {
		sessionToken = "anonymous"
	}

	srcFile, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "打开上传文件失败: " + err.Error()})
		return
	}
	defer srcFile.Close()

	// 保存到临时文件
	tmpArchive, err := os.CreateTemp("", "upload-archive-*")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建临时存储失败: " + err.Error()})
		return
	}
	defer func() {
		tmpArchive.Close()
		os.Remove(tmpArchive.Name())
	}()

	if _, err := io.Copy(tmpArchive, srcFile); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "写入临时存储失败: " + err.Error()})
		return
	}
	_ = tmpArchive.Sync()

	// 读取前几个字节判断文件魔数
	magic := make([]byte, 4)
	_, _ = tmpArchive.ReadAt(magic, 0)

	filenameLower := strings.ToLower(fileHeader.Filename)
	var entries []archiveEntry

	if bytes.HasPrefix(magic, []byte("PK\x03\x04")) || strings.HasSuffix(filenameLower, ".zip") {
		// ZIP 解压
		entries, err = extractZipArchive(tmpArchive.Name())
	} else if (magic[0] == 0x1f && magic[1] == 0x8b) || strings.HasSuffix(filenameLower, ".tar.gz") || strings.HasSuffix(filenameLower, ".tgz") {
		// TAR.GZ 解压
		_, _ = tmpArchive.Seek(0, io.SeekStart)
		entries, err = extractTarGzArchive(tmpArchive)
	} else {
		// 默认作为纯 TAR 解压
		_, _ = tmpArchive.Seek(0, io.SeekStart)
		entries, err = extractTarArchive(tmpArchive)
	}

	if err != nil {
		h.logger.Error("解压项目包失败", zap.Error(err), zap.String("file", fileHeader.Filename))
		c.JSON(http.StatusBadRequest, gin.H{"error": "解压文件失败，请确认是否为有效的 tar, tar.gz 或 zip 压缩包: " + err.Error()})
		return
	}

	if len(entries) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "压缩包内未包含有效文件"})
		return
	}

	// 自动剥除公共顶层目录（例如解压自 github 的 my-repo-main/）
	entries = stripArchivePrefix(entries)

	// 解析项目名称
	name := strings.TrimSpace(c.PostForm("name"))
	if name == "" {
		baseName := filepath.Base(fileHeader.Filename)
		for _, ext := range []string{".tar.gz", ".tgz", ".tar", ".zip"} {
			if strings.HasSuffix(strings.ToLower(baseName), ext) {
				baseName = baseName[:len(baseName)-len(ext)]
				break
			}
		}
		name = baseName
	}
	if name == "" {
		name = "imported-project"
	}

	// 解析框架
	framework := strings.TrimSpace(c.PostForm("framework"))
	if framework == "" || framework == "auto" {
		framework = detectFrameworkFromEntries(entries)
	} else if framework == "idf" {
		framework = "espidf"
	}

	// 解析开发板
	boardFQBN := strings.TrimSpace(c.PostForm("board_fqbn"))
	if boardFQBN == "" {
		boardFQBN = "esp32:esp32:esp32"
	}

	description := strings.TrimSpace(c.PostForm("description"))
	if description == "" {
		description = fmt.Sprintf("导入自压缩包 %s (%d 个文件)", fileHeader.Filename, len(entries))
	}

	customCmd := strings.TrimSpace(c.PostForm("custom_cmd"))

	// 创建项目
	project := models.Project{
		ID:            uuid.New(),
		Name:          name,
		Description:   description,
		Framework:     framework,
		BoardFQBN:     boardFQBN,
		CustomCommand: customCmd,
		SessionToken:  sessionToken,
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
	}

	if err := h.db.DB.Create(&project).Error; err != nil {
		h.logger.Error("创建导入项目失败", zap.Error(err))
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建项目失败: " + err.Error()})
		return
	}

	// 批量插入 ProjectFile
	now := time.Now()
	batchSize := 100
	var batch []models.ProjectFile
	var savedCount int

	for _, entry := range entries {
		content := ""
		if isBinaryData(entry.data) {
			content = "base64:" + base64.StdEncoding.EncodeToString(entry.data)
		} else {
			content = string(entry.data)
		}

		batch = append(batch, models.ProjectFile{
			ProjectID: project.ID,
			Path:      filepath.ToSlash(entry.path),
			Content:   content,
			SizeBytes: entry.size,
			CreatedAt: now,
			UpdatedAt: now,
		})

		if len(batch) >= batchSize {
			if err := h.db.DB.Create(&batch).Error; err != nil {
				h.logger.Error("批量保存项目文件失败", zap.Error(err))
			} else {
				savedCount += len(batch)
			}
			batch = batch[:0]
		}
	}

	if len(batch) > 0 {
		if err := h.db.DB.Create(&batch).Error; err != nil {
			h.logger.Error("保存最后一批文件失败", zap.Error(err))
		} else {
			savedCount += len(batch)
		}
	}

	h.logger.Info("压缩包项目导入成功",
		zap.String("project_id", project.ID.String()),
		zap.String("name", project.Name),
		zap.Int("file_count", savedCount),
		zap.String("framework", project.Framework),
	)

	c.JSON(http.StatusCreated, gin.H{
		"id":         project.ID,
		"project_id": project.ID,
		"name":       project.Name,
		"framework":  project.Framework,
		"board_fqbn": project.BoardFQBN,
		"files":      savedCount,
		"message":    "项目导入成功",
	})
}

// extractTarGzArchive 解压 tar.gz 流。
func extractTarGzArchive(r io.Reader) ([]archiveEntry, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("读取 gzip 流失败: %w", err)
	}
	defer gz.Close()
	return extractTarArchive(gz)
}

// extractTarArchive 解压标准 tar 流。
func extractTarArchive(r io.Reader) ([]archiveEntry, error) {
	tr := tar.NewReader(r)
	var entries []archiveEntry

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		clean := strings.TrimPrefix(filepath.ToSlash(hdr.Name), "./")
		clean = strings.TrimPrefix(clean, "/")
		if isIgnoredPath(clean) {
			continue
		}

		data, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		entries = append(entries, archiveEntry{
			path: clean,
			data: data,
			size: int64(len(data)),
		})
	}
	return entries, nil
}

// extractZipArchive 解压 ZIP 文件。
func extractZipArchive(zipPath string) ([]archiveEntry, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, err
	}
	defer zr.Close()

	var entries []archiveEntry
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		clean := strings.TrimPrefix(filepath.ToSlash(f.Name), "./")
		clean = strings.TrimPrefix(clean, "/")
		if isIgnoredPath(clean) {
			continue
		}

		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
		entries = append(entries, archiveEntry{
			path: clean,
			data: data,
			size: int64(len(data)),
		})
	}
	return entries, nil
}

// isIgnoredPath 判断是否为需忽略的文件路径。
func isIgnoredPath(path string) bool {
	if path == "" {
		return true
	}
	base := filepath.Base(path)
	if base == ".DS_Store" || strings.HasPrefix(base, "._") {
		return true
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if part == "__MACOSX" || part == ".git" {
			return true
		}
	}
	return false
}

// stripArchivePrefix 检测并剥除公共顶层父目录。
func stripArchivePrefix(entries []archiveEntry) []archiveEntry {
	if len(entries) == 0 {
		return entries
	}
	firstSlash := strings.Index(entries[0].path, "/")
	if firstSlash == -1 {
		return entries
	}
	candidatePrefix := entries[0].path[:firstSlash+1]

	for _, e := range entries {
		if !strings.HasPrefix(e.path, candidatePrefix) {
			return entries
		}
	}

	result := make([]archiveEntry, len(entries))
	for i, e := range entries {
		result[i] = archiveEntry{
			path: strings.TrimPrefix(e.path, candidatePrefix),
			data: e.data,
			size: e.size,
		}
	}
	return result
}

// detectFrameworkFromEntries 根据文件结构推断项目框架。
func detectFrameworkFromEntries(entries []archiveEntry) string {
	for _, e := range entries {
		p := strings.ToLower(e.path)
		if p == "cmakelists.txt" || strings.HasSuffix(p, "/cmakelists.txt") || p == "sdkconfig" || strings.HasSuffix(p, "idf_component.yml") {
			return "espidf"
		}
	}
	return "arduino"
}

