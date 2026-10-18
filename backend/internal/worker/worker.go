// Package worker 初始化并启动 asynq.Server 异步任务处理器。
package worker

import (
	"context"
	"fmt"

	"github.com/hibiken/asynq"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/services"
)

// Worker 封装 asynq.Server 和任务路由。
type Worker struct {
	server  *asynq.Server
	handler *asynq.ServeMux
	logger  *zap.Logger
}

// NewWorker 创建 Worker 实例，注册所有任务 Handler。
func NewWorker(cfg *config.Config, database *db.Database, storage services.StorageBackend, logger *zap.Logger) *Worker {
	redisOpt := asynq.RedisClientOpt{
		Addr: redisAddrFromURL(cfg.RedisURL),
	}

	srv := asynq.NewServer(redisOpt, asynq.Config{
		Concurrency: cfg.WorkerConcurrency,
		// 严格模式：任务队列满时拒绝新任务
		StrictPriority: false,
		Queues: map[string]int{
			"critical": 6,
			"default":  3,
			"low":      1,
		},
		ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, task *asynq.Task, err error) {
			logger.Error("任务处理失败",
				zap.String("task_type", task.Type()),
				zap.Error(err),
			)
		}),
	})

	// 创建 compile 任务 Handler
	compileHandler, err := NewCompileTaskHandler(cfg, database, storage, logger)
	if err != nil {
		logger.Fatal("创建编译任务 Handler 失败", zap.Error(err))
	}

	mux := asynq.NewServeMux()
	mux.HandleFunc(TaskCompile, compileHandler.HandleCompileTask)

	return &Worker{
		server:  srv,
		handler: mux,
		logger:  logger,
	}
}

// Run 启动 Worker 并阻塞直到收到退出信号。
func (w *Worker) Run() error {
	w.logger.Info("Worker 开始监听任务...")
	if err := w.server.Run(w.handler); err != nil {
		return fmt.Errorf("asynq server 运行失败: %w", err)
	}
	return nil
}

// redisAddrFromURL 从 redis:// URL 提取 host:port。
func redisAddrFromURL(redisURL string) string {
	s := redisURL
	for _, prefix := range []string{"redis://", "rediss://"} {
		if len(s) >= len(prefix) && s[:len(prefix)] == prefix {
			s = s[len(prefix):]
			break
		}
	}
	// 去掉认证信息 user:pass@
	if at := lastIdx(s, "@"); at >= 0 {
		s = s[at+1:]
	}
	// 去掉 /db 路径
	if slash := lastIdx(s, "/"); slash >= 0 {
		s = s[:slash]
	}
	return s
}

func lastIdx(s, sub string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == sub[0] {
			return i
		}
	}
	return -1
}
