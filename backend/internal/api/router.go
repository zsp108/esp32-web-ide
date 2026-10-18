// Package api 负责注册 Gin 路由，组织所有 HTTP 和 WebSocket 端点。
package api

import (
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/api/handlers"
	"github.com/esp32-web-ide/backend/internal/api/middleware"
	ws "github.com/esp32-web-ide/backend/internal/api/ws"
	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/services"
)

// NewRouter 创建并配置 Gin 引擎，注册所有路由。
func NewRouter(cfg *config.Config, database *db.Database, storage services.StorageBackend, logger *zap.Logger) *gin.Engine {
	// 根据环境设置 Gin 模式
	// gin.SetMode(gin.ReleaseMode) // 生产环境取消注释

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.CORS())

	// 初始化各 Handler
	boardsHandler := handlers.NewBoardsHandler(logger)
	projectsHandler := handlers.NewProjectsHandler(database, logger)
	filesHandler := handlers.NewFilesHandler(database, storage, logger)
	buildsHandler := handlers.NewBuildsHandler(cfg, database, storage, logger)
	importHandler := handlers.NewImportHandler(database, logger)

	// WebSocket Hub（负责日志广播）
	hub := ws.NewHub(cfg, database, logger)
	go hub.Run()
	wsHandler := ws.NewHandler(hub, logger)

	// 健康检查
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	// API v1 路由组
	v1 := r.Group("/api/v1")
	{
		// 板型列表
		v1.GET("/boards", boardsHandler.List)

		// Git URL 导入与压缩包导入 (tar / tar.gz / zip)
		v1.POST("/import/git", importHandler.ImportFromGit)
		v1.POST("/import/archive", importHandler.ImportArchive)
		v1.POST("/projects/import-tar", importHandler.ImportArchive)
		v1.POST("/projects/import-archive", importHandler.ImportArchive)

		// 项目 CRUD
		projects := v1.Group("/projects")
		{
			projects.POST("", projectsHandler.Create)
			projects.GET("", projectsHandler.ListBySession)
			projects.GET("/:id", projectsHandler.Get)
			projects.DELETE("/:id", projectsHandler.Delete)

			// 文件管理（挂载在项目下）
			projects.PUT("/:id/files", filesHandler.UpsertFile)
			projects.POST("/:id/files/rename", filesHandler.RenameFile)
			projects.GET("/:id/files", filesHandler.ListFiles)
			projects.GET("/:id/files/*path", filesHandler.GetFileContent)
			projects.DELETE("/:id/files/*path", filesHandler.DeleteFile)

			// 项目编译历史
			projects.GET("/:id/builds", buildsHandler.ListByProject)
		}

		// 编译任务
		builds := v1.Group("/builds")
		{
			builds.POST("", buildsHandler.Create)
			builds.GET("/:id", buildsHandler.Get)
			builds.GET("/:id/download", buildsHandler.Download)
			builds.GET("/:id/artifacts/:filename", buildsHandler.DownloadArtifact)
			builds.DELETE("/:id", buildsHandler.Cancel)
			builds.POST("/:id/cancel", buildsHandler.Cancel)
		}
	}

	// WebSocket 端点
	wsGroup := r.Group("/ws")
	{
		wsGroup.GET("/builds/:id", wsHandler.HandleBuildLog)
	}

	return r
}
