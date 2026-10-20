// Package config 使用 viper 从环境变量加载应用配置。
package config

import (
	"strings"

	"github.com/spf13/viper"
)

// Config 保存所有运行时配置项。
type Config struct {
	// 数据库
	DatabaseURL string

	// Redis
	RedisURL string

	// 存储后端
	StorageBackend    string // "local" 或 "minio"
	StorageLocalPath  string
	StorageMinioEndpoint  string
	StorageMinioAccessKey string
	StorageMinioSecretKey string
	StorageMinioBucket    string
	StorageMinioUseSSL    bool
	StorageMinioRegion    string

	// 编译配置
	MaxConcurrentBuilds  int
	BuildTimeoutSeconds  int
	ArduinoBuilderImage  string
	IDFBuilderImage      string

	// 服务器配置
	ServerPort         int
	WorkerConcurrency  int

	// 限流配置
	RateLimitBuildPerHour int
}

// Load 从环境变量（通过 viper）读取并返回配置。
func Load() (*Config, error) {
	v := viper.New()

	// 允许从环境变量读取，统一大写
	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))

	// 设置默认值
	v.SetDefault("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/esp32ide?sslmode=disable")
	v.SetDefault("REDIS_URL", "redis://localhost:6379/0")

	v.SetDefault("STORAGE_BACKEND", "local")
	v.SetDefault("STORAGE_LOCAL_PATH", "/tmp/esp32-ide-storage")
	v.SetDefault("STORAGE_MINIO_ENDPOINT", "localhost:9000")
	v.SetDefault("STORAGE_MINIO_ACCESS_KEY", "minioadmin")
	v.SetDefault("STORAGE_MINIO_SECRET_KEY", "minioadmin")
	v.SetDefault("STORAGE_MINIO_BUCKET", "esp32-builds")
	v.SetDefault("STORAGE_MINIO_USE_SSL", false)
	v.SetDefault("STORAGE_MINIO_REGION", "us-east-1")

	v.SetDefault("MAX_CONCURRENT_BUILDS", 3)
	v.SetDefault("BUILD_TIMEOUT_SECONDS", 1200)
	v.SetDefault("ARDUINO_BUILDER_IMAGE", "esp32-arduino-builder:latest")
	v.SetDefault("IDF_BUILDER_IMAGE", "esp32-idf-builder:latest")

	v.SetDefault("SERVER_PORT", 8080)
	v.SetDefault("WORKER_CONCURRENCY", 3)

	v.SetDefault("RATE_LIMIT_BUILD_PER_HOUR", 10)

	cfg := &Config{
		DatabaseURL: v.GetString("DATABASE_URL"),
		RedisURL:    v.GetString("REDIS_URL"),

		StorageBackend:        v.GetString("STORAGE_BACKEND"),
		StorageLocalPath:      v.GetString("STORAGE_LOCAL_PATH"),
		StorageMinioEndpoint:  v.GetString("STORAGE_MINIO_ENDPOINT"),
		StorageMinioAccessKey: v.GetString("STORAGE_MINIO_ACCESS_KEY"),
		StorageMinioSecretKey: v.GetString("STORAGE_MINIO_SECRET_KEY"),
		StorageMinioBucket:    v.GetString("STORAGE_MINIO_BUCKET"),
		StorageMinioUseSSL:    v.GetBool("STORAGE_MINIO_USE_SSL"),
		StorageMinioRegion:    v.GetString("STORAGE_MINIO_REGION"),

		MaxConcurrentBuilds: v.GetInt("MAX_CONCURRENT_BUILDS"),
		BuildTimeoutSeconds: v.GetInt("BUILD_TIMEOUT_SECONDS"),
		ArduinoBuilderImage: v.GetString("ARDUINO_BUILDER_IMAGE"),
		IDFBuilderImage:     v.GetString("IDF_BUILDER_IMAGE"),

		ServerPort:        v.GetInt("SERVER_PORT"),
		WorkerConcurrency: v.GetInt("WORKER_CONCURRENCY"),

		RateLimitBuildPerHour: v.GetInt("RATE_LIMIT_BUILD_PER_HOUR"),
	}

	return cfg, nil
}
