// Package models 定义 BuildRecord 数据模型。
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// BuildStatus 枚举编译任务的所有可能状态。
type BuildStatus string

const (
	BuildStatusPending   BuildStatus = "pending"
	BuildStatusRunning   BuildStatus = "running"
	BuildStatusSuccess   BuildStatus = "success"
	BuildStatusFailed    BuildStatus = "failed"
	BuildStatusTimeout   BuildStatus = "timeout"
	BuildStatusCancelled BuildStatus = "cancelled"
)

// FlashSegment 描述单段固件烧录参数
type FlashSegment struct {
	Offset int64  `json:"offset"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	URL    string `json:"url"`
}

// BuildRecord 记录单次编译任务的完整信息。
type BuildRecord struct {
	ID            uuid.UUID   `gorm:"type:uuid;primaryKey" json:"id"`
	ProjectID     uuid.UUID   `gorm:"type:uuid;index;not null" json:"project_id"`
	Status        BuildStatus `gorm:"not null;default:'pending'" json:"status"`
	Framework     string      `json:"framework"` // arduino | espidf
	BoardFQBN     string      `json:"board_fqbn"`
	CustomCommand string      `json:"custom_command,omitempty"` // 自定义编译命令
	TimeoutSeconds int        `json:"timeout_seconds,omitempty"`// 该任务的编译超时秒数
	BinStorageKey string      `json:"bin_storage_key"`          // 存储后端中的对象键
	BinSizeBytes  int64       `json:"bin_size_bytes"`
	FlashSegments string      `gorm:"type:text" json:"flash_segments,omitempty"` // JSON 格式存储的分段烧录清单
	FlashPct      float64     `json:"flash_pct"`                                 // Flash 使用百分比
	RAMPct        float64     `json:"ram_pct"`                                   // RAM 使用百分比
	BuildLog      string      `gorm:"type:text" json:"build_log"`
	DurationMs    int64       `json:"duration_ms"`
	ErrorMsg      string      `json:"error_msg,omitempty"`
	CreatedAt     time.Time   `json:"created_at"`
}

// BeforeCreate 在插入前自动生成 UUID。
func (b *BuildRecord) BeforeCreate(tx *gorm.DB) error {
	if b.ID == uuid.Nil {
		b.ID = uuid.New()
	}
	return nil
}
