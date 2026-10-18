// Package ws 实现 WebSocket Hub，管理编译日志的实时推送。
// Hub 通过 Redis Pub/Sub 订阅编译日志，再广播给所有订阅该 Build 的 WS 客户端。
package ws

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/db"
	"github.com/esp32-web-ide/backend/internal/models"
)

// Client 表示单个 WebSocket 连接。
type Client struct {
	BuildID string
	Conn    *websocket.Conn
	Send    chan []byte
}

// Hub 管理所有 WebSocket 客户端，并从 Redis Pub/Sub 接收日志进行广播。
type Hub struct {
	mu      sync.RWMutex
	// buildID -> 客户端集合
	clients map[string]map[*Client]struct{}

	register   chan *Client
	unregister chan *Client

	redisClient *redis.Client
	db          *db.Database
	logger      *zap.Logger
}

// NewHub 创建 Hub 实例，redisURL 格式为 "redis://host:port/db"。
func NewHub(cfg *config.Config, database *db.Database, logger *zap.Logger) *Hub {
	opt, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		logger.Warn("解析 Redis URL 失败，使用默认配置", zap.Error(err))
		opt = &redis.Options{Addr: "localhost:6379"}
	}
	rdb := redis.NewClient(opt)

	return &Hub{
		clients:     make(map[string]map[*Client]struct{}),
		register:    make(chan *Client, 64),
		unregister:  make(chan *Client, 64),
		redisClient: rdb,
		db:          database,
		logger:      logger,
	}
}

// Run 启动 Hub 主循环（应在 goroutine 中调用）。
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if _, ok := h.clients[client.BuildID]; !ok {
				h.clients[client.BuildID] = make(map[*Client]struct{})
				// 首个订阅者：启动 Redis 订阅 goroutine
				go h.subscribeRedis(client.BuildID)
			}
			h.clients[client.BuildID][client] = struct{}{}
			h.mu.Unlock()
			h.logger.Info("WS 客户端注册", zap.String("build_id", client.BuildID))

			// 向新注册的客户端回放历史日志和当前任务状态
			go h.sendBacklog(client)

		case client := <-h.unregister:
			h.mu.Lock()
			if group, ok := h.clients[client.BuildID]; ok {
				delete(group, client)
				close(client.Send)
				if len(group) == 0 {
					delete(h.clients, client.BuildID)
				}
			}
			h.mu.Unlock()
			h.logger.Info("WS 客户端注销", zap.String("build_id", client.BuildID))
		}
	}
}

// Register 将客户端注册到 Hub。
func (h *Hub) Register(c *Client) {
	h.register <- c
}

// Unregister 从 Hub 注销客户端。
func (h *Hub) Unregister(c *Client) {
	h.unregister <- c
}

// Broadcast 向指定 build 的所有客户端发送消息。
func (h *Hub) Broadcast(buildID string, msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.clients[buildID] {
		select {
		case client.Send <- msg:
		default:
			// 发送缓冲已满，跳过
		}
	}
}

// subscribeRedis 订阅 Redis channel "build:{buildID}:log"，
// 收到消息后广播给所有订阅该 build 的 WS 客户端。
func (h *Hub) subscribeRedis(buildID string) {
	channel := "build:" + buildID + ":log"
	ctx := context.Background()
	pubsub := h.redisClient.Subscribe(ctx, channel)
	defer pubsub.Close()

	h.logger.Info("开始订阅 Redis channel", zap.String("channel", channel))

	for msg := range pubsub.Channel() {
		h.mu.RLock()
		_, hasClients := h.clients[buildID]
		h.mu.RUnlock()

		if !hasClients {
			// 没有客户端了，退出订阅
			return
		}

		h.Broadcast(buildID, []byte(msg.Payload))
	}

	h.logger.Info("Redis channel 订阅结束", zap.String("channel", channel))
}

// sendBacklog 当新客户端连接时，回放已有的编译历史日志和最新状态。
func (h *Hub) sendBacklog(client *Client) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	listKey := "build:" + client.BuildID + ":logs"
	logs, err := h.redisClient.LRange(ctx, listKey, 0, -1).Result()
	if err == nil && len(logs) > 0 {
		for _, logMsg := range logs {
			select {
			case client.Send <- []byte(logMsg):
			default:
			}
		}
		return
	}

	// 若 Redis 中无日志（如编译已完成且键过期或服务重启），从数据库回放完整日志与状态
	if h.db != nil {
		bUUID, err := uuid.Parse(client.BuildID)
		if err != nil {
			return
		}
		var build models.BuildRecord
		if err := h.db.DB.First(&build, "id = ?", bUUID).Error; err == nil {
			if build.BuildLog != "" {
				lines := strings.Split(build.BuildLog, "\n")
				for _, line := range lines {
					if line == "" {
						continue
					}
					msg, _ := json.Marshal(map[string]interface{}{
						"type":  "log",
						"level": "info",
						"text":  line,
					})
					select {
					case client.Send <- msg:
					default:
					}
				}
			}
			if build.Status == models.BuildStatusSuccess {
				msg, _ := json.Marshal(map[string]interface{}{
					"type":    "done",
					"status":  "success",
					"percent": 100,
					"bin_url": "/api/v1/builds/" + client.BuildID + "/download",
				})
				select {
				case client.Send <- msg:
				default:
				}
			} else if build.Status == models.BuildStatusFailed || build.Status == models.BuildStatusTimeout {
				msg, _ := json.Marshal(map[string]interface{}{
					"type":    "done",
					"status":  "failed",
					"percent": 100,
					"error":   build.ErrorMsg,
				})
				select {
				case client.Send <- msg:
				default:
				}
			}
		}
	}
}

