// Package middleware 提供基于 IP 的限流中间件。
// MVP 阶段为 no-op 实现，预留扩展接口。
package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/ulule/limiter/v3"
	"github.com/ulule/limiter/v3/drivers/store/memory"
	"go.uber.org/zap"
)

// RateLimiter 封装限流器实例，方便注入。
type RateLimiter struct {
	instance *limiter.Limiter
	logger   *zap.Logger
}

// NewRateLimiter 创建一个基于内存的 IP 限流器。
// period 单位为 "1h"、"1m" 等 ulule/limiter 支持的格式，limit 为对应时间内最大请求数。
func NewRateLimiter(rateExpr string, limit int64, logger *zap.Logger) (*RateLimiter, error) {
	rate, err := limiter.NewRateFromFormatted(rateExpr)
	if err != nil {
		return nil, err
	}
	store := memory.NewStore()
	inst := limiter.New(store, rate)
	return &RateLimiter{instance: inst, logger: logger}, nil
}

// Middleware 返回 Gin 限流中间件。
// 当 RateLimiter 为 nil 时退化为 no-op，方便 MVP 阶段直接传 nil 禁用。
func (rl *RateLimiter) Middleware() gin.HandlerFunc {
	if rl == nil || rl.instance == nil {
		// no-op: MVP 阶段跳过限流
		return func(c *gin.Context) { c.Next() }
	}

	return func(c *gin.Context) {
		ip := c.ClientIP()
		ctx, err := rl.instance.Get(c.Request.Context(), ip)
		if err != nil {
			rl.logger.Warn("限流检查失败，放行请求", zap.Error(err))
			c.Next()
			return
		}

		if ctx.Reached {
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":       "rate_limit_exceeded",
				"message":     "请求过于频繁，请稍后重试",
				"retry_after": ctx.Reset,
			})
			c.Abort()
			return
		}

		c.Next()
	}
}

// NoopRateLimit 返回一个直接放行的 no-op 中间件，适合测试或禁用限流时使用。
func NoopRateLimit() gin.HandlerFunc {
	return func(c *gin.Context) { c.Next() }
}
