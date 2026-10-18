// Package main 是程序入口，支持 server 和 worker 两种启动模式。
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/api"
	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
	"github.com/esp32-web-ide/backend/internal/services"
	"github.com/esp32-web-ide/backend/internal/worker"
)

func main() {
	// 解析启动模式: server | worker
	mode := flag.String("mode", "server", "启动模式: server (默认) 或 worker")
	flag.Parse()

	// 初始化 zap logger
	logger, err := zap.NewProduction()
	if err != nil {
		fmt.Fprintf(os.Stderr, "初始化 logger 失败: %v\n", err)
		os.Exit(1)
	}
	defer logger.Sync() //nolint:errcheck

	// 加载配置
	cfg, err := config.Load()
	if err != nil {
		logger.Fatal("加载配置失败", zap.Error(err))
	}

	// 初始化数据库
	database, err := db.Init(cfg, logger)
	if err != nil {
		logger.Fatal("初始化数据库失败", zap.Error(err))
	}

	// 初始化存储后端
	storage, err := services.NewStorage(cfg, logger)
	if err != nil {
		logger.Fatal("初始化存储后端失败", zap.Error(err))
	}

	// 启动时清理历史残留的僵尸任务（例如服务重启导致一直处于 running 状态的任务）
	if err := database.DB.Model(&models.BuildRecord{}).
		Where("status IN ?", []models.BuildStatus{models.BuildStatusRunning, models.BuildStatusPending}).
		Where("created_at < ?", time.Now().Add(-5*time.Minute)).
		Updates(map[string]interface{}{
			"status":    models.BuildStatusFailed,
			"error_msg": "服务重启或编译超时中断",
		}).Error; err != nil {
		logger.Warn("清理残留僵尸任务失败", zap.Error(err))
	}

	switch *mode {
	case "server":
		runServer(cfg, database, storage, logger)
	case "worker":
		runWorker(cfg, database, storage, logger)
	default:
		logger.Fatal("未知启动模式", zap.String("mode", *mode))
	}
}

// runServer 启动 HTTP + WebSocket 服务
func runServer(cfg *config.Config, database *db.Database, storage services.StorageBackend, logger *zap.Logger) {
	router := api.NewRouter(cfg, database, storage, logger)

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", cfg.ServerPort),
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// 优雅退出
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info("HTTP 服务器启动", zap.Int("port", cfg.ServerPort))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("服务器启动失败", zap.Error(err))
		}
	}()

	<-quit
	logger.Info("收到退出信号，开始优雅关闭...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("服务器强制关闭", zap.Error(err))
	}
	logger.Info("服务器已退出")
}

// runWorker 启动 asynq 异步任务处理器
func runWorker(cfg *config.Config, database *db.Database, storage services.StorageBackend, logger *zap.Logger) {
	logger.Info("启动 Worker 模式", zap.Int("concurrency", cfg.WorkerConcurrency))
	w := worker.NewWorker(cfg, database, storage, logger)
	if err := w.Run(); err != nil {
		logger.Fatal("Worker 运行失败", zap.Error(err))
	}
}
