// Package models 定义 Project 和 ProjectFile 数据模型。
package models

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Project 表示用户的 ESP32 项目。
// 通过 SessionToken（浏览器 localStorage UUID）关联到匿名用户。
type Project struct {
	ID           uuid.UUID     `gorm:"type:uuid;primaryKey" json:"id"`
	Name         string        `gorm:"not null" json:"name"`
	Description  string        `json:"description"`
	Framework    string        `gorm:"not null" json:"framework"` // arduino | espidf
	BoardFQBN    string        `gorm:"not null" json:"board_fqbn"`
	SessionToken string        `gorm:"index;not null" json:"session_token"` // 浏览器 localStorage UUID
	CustomCommand string       `json:"custom_command"`                      // 自定义编译命令
	BuildTimeoutSeconds int    `json:"build_timeout_seconds"`               // 自定义编译超时时间（秒，0 表示使用系统默认）
	GitURL        string       `json:"git_url"`                             // 关联的远程 Git 仓库 URL
	GitBranch     string       `json:"git_branch"`                          // 关联的 Git 分支
	GitSubDir     string       `json:"git_sub_dir"`                         // 仓库内的子目录路径
	GitCommitHash string       `json:"git_commit_hash"`                     // 当前同步的 Commit Hash
	CreatedAt     time.Time    `json:"created_at"`
	UpdatedAt    time.Time     `json:"updated_at"`
	Files        []ProjectFile `gorm:"foreignKey:ProjectID" json:"files,omitempty"`
	Builds       []BuildRecord `gorm:"foreignKey:ProjectID" json:"builds,omitempty"`
}

// BeforeCreate 在插入前自动生成 UUID。
func (p *Project) BeforeCreate(tx *gorm.DB) error {
	if p.ID == uuid.Nil {
		p.ID = uuid.New()
	}
	return nil
}

// ProjectFile 表示项目中的单个源文件。
type ProjectFile struct {
	ID        uint      `gorm:"primaryKey;autoIncrement" json:"id"`
	ProjectID uuid.UUID `gorm:"type:uuid;index;not null" json:"project_id"`
	Path      string    `gorm:"not null" json:"path"` // 相对路径，如 "src/main.cpp"
	Content   string    `gorm:"type:text" json:"content"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
