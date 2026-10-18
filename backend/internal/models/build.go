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

// BuildRecord 记录单次编译任务的完整信息。
type BuildRecord struct {
	ID            uuid.UUID   `gorm:"type:uuid;primaryKey" json:"id"`
	ProjectID     uuid.UUID   `gorm:"type:uuid;index;not null" json:"project_id"`
	Status        BuildStatus `gorm:"not null;default:'pending'" json:"status"`
	Framework     string      `json:"framework"` // arduino | espidf
	BoardFQBN     string      `json:"board_fqbn"`
	BinStorageKey string      `json:"bin_storage_key"` // 存储后端中的对象键
	BinSizeBytes  int64       `json:"bin_size_bytes"`
	FlashPct      float64     `json:"flash_pct"` // Flash 使用百分比
	RAMPct        float64     `json:"ram_pct"`   // RAM 使用百分比
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
