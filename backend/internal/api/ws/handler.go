// Package ws 提供 WebSocket 升级处理。
package ws

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
	// 开发阶段允许所有来源
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Handler 处理 WebSocket 升级请求。
type Handler struct {
	hub    *Hub
	logger *zap.Logger
}

// NewHandler 创建 WS Handler 实例。
func NewHandler(hub *Hub, logger *zap.Logger) *Handler {
	return &Handler{hub: hub, logger: logger}
}

// HandleBuildLog godoc
// @Summary  订阅编译日志 WebSocket 流
// @Tags     ws
// @Param    id  path  string  true  "BuildRecord UUID"
// @Router   /ws/builds/{id} [get]
func (h *Handler) HandleBuildLog(c *gin.Context) {
	buildID := c.Param("id")
	if buildID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 build ID"})
		return
	}

	// 升级为 WebSocket 连接
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		h.logger.Error("WebSocket 升级失败", zap.Error(err))
		return
	}

	client := &Client{
		BuildID: buildID,
		Conn:    conn,
		Send:    make(chan []byte, 256),
	}

	// 注册到 Hub
	h.hub.Register(client)

	// 启动写 goroutine（将 Hub 广播的消息写入 WS）
	go h.writePump(client)

	// 读 goroutine（检测客户端断开）
	h.readPump(client)
}

// writePump 从 client.Send 通道读取消息并发送给 WebSocket 客户端。
func (h *Handler) writePump(c *Client) {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				// Hub 已关闭通道
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				h.logger.Warn("WebSocket 写入失败", zap.Error(err))
				return
			}

		case <-ticker.C:
			// 定期发送 ping 保活
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// readPump 读取客户端发来的消息（主要用于检测断开），
// 断开后自动从 Hub 注销。
func (h *Handler) readPump(c *Client) {
	defer func() {
		h.hub.Unregister(c)
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(512)
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, _, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				h.logger.Warn("WebSocket 异常关闭", zap.Error(err))
			}
			break
		}
	}
}
