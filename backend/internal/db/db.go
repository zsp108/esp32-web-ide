// Package db 提供 GORM PostgreSQL 数据库初始化。
package db

import (
	"fmt"

	"go.uber.org/zap"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/models"
)

// Database 封装 GORM DB 实例。
type Database struct {
	DB *gorm.DB
}

// Init 初始化数据库连接并执行自动迁移。
func Init(cfg *config.Config, logger *zap.Logger) (*Database, error) {
	gormCfg := &gorm.Config{
		// 在生产环境中可换为 Silent 级别减少日志噪音
		Logger: gormlogger.Default.LogMode(gormlogger.Warn),
	}

	db, err := gorm.Open(postgres.Open(cfg.DatabaseURL), gormCfg)
	if err != nil {
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}

	// 配置连接池
	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("获取底层 sql.DB 失败: %w", err)
	}
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(5)

	// 自动迁移：创建/更新表结构
	if err := db.AutoMigrate(
		&models.Project{},
		&models.ProjectFile{},
		&models.BuildRecord{},
	); err != nil {
		return nil, fmt.Errorf("数据库迁移失败: %w", err)
	}

	logger.Info("数据库连接并迁移成功")
	return &Database{DB: db}, nil
}
