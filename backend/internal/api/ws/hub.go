// Package ws 实现 WebSocket Hub，管理编译日志的实时推送。
// Hub 通过 Redis Pub/Sub 订阅编译日志，再广播给所有订阅该 Build 的 WS 客户端。
package ws

import (
	"context"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/config"
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
	logger      *zap.Logger
}

// NewHub 创建 Hub 实例，redisURL 格式为 "redis://host:port/db"。
func NewHub(cfg *config.Config, logger *zap.Logger) *Hub {
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
