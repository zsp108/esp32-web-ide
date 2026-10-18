// Package services 提供存储后端抽象层。
// 支持 LocalStorage（本地文件系统）和 MinIOStorage（兼容 S3 / 阿里云 OSS）。
package services

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"go.uber.org/zap"

	"github.com/esp32-web-ide/backend/internal/config"
)

// StorageBackend 定义存储后端的通用接口。
type StorageBackend interface {
	// Put 上传对象，key 为存储键，reader 为数据来源。
	Put(ctx context.Context, key string, reader io.Reader, size int64, contentType string) error
	// Get 下载对象，返回 ReadCloser。
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	// Delete 删除对象。
	Delete(ctx context.Context, key string) error
	// PresignedURL 生成预签名下载 URL，有效期由 expires 指定。
	// LocalStorage 直接返回本地路径（不支持真正的预签名），MinIO 返回真正的签名 URL。
	PresignedURL(ctx context.Context, key string, expires time.Duration) (string, error)
}

// NewStorage 根据配置创建相应的存储后端。
func NewStorage(cfg *config.Config, logger *zap.Logger) (StorageBackend, error) {
	switch cfg.StorageBackend {
	case "minio":
		return newMinIOStorage(cfg, logger)
	default:
		return newLocalStorage(cfg, logger)
	}
}

// ─────────────────────────────────────────────
// LocalStorage 实现
// ─────────────────────────────────────────────

// LocalStorage 将对象存储到本地文件系统。
type LocalStorage struct {
	basePath string
	logger   *zap.Logger
}

func newLocalStorage(cfg *config.Config, logger *zap.Logger) (*LocalStorage, error) {
	if err := os.MkdirAll(cfg.StorageLocalPath, 0755); err != nil {
		return nil, fmt.Errorf("创建本地存储目录失败: %w", err)
	}
	logger.Info("使用本地存储后端", zap.String("path", cfg.StorageLocalPath))
	return &LocalStorage{basePath: cfg.StorageLocalPath, logger: logger}, nil
}

func (s *LocalStorage) fullPath(key string) string {
	return filepath.Join(s.basePath, filepath.FromSlash(key))
}

func (s *LocalStorage) Put(ctx context.Context, key string, reader io.Reader, size int64, contentType string) error {
	path := s.fullPath(key)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("创建文件失败: %w", err)
	}
	defer f.Close()
	_, err = io.Copy(f, reader)
	return err
}

func (s *LocalStorage) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	return os.Open(s.fullPath(key))
}

func (s *LocalStorage) Delete(ctx context.Context, key string) error {
	return os.Remove(s.fullPath(key))
}

func (s *LocalStorage) PresignedURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	// 本地模式直接返回文件路径（调用方负责读取文件并响应）
	return "file://" + s.fullPath(key), nil
}

// ─────────────────────────────────────────────
// MinIOStorage 实现
// ─────────────────────────────────────────────

// MinIOStorage 将对象存储到 MinIO / S3 兼容服务。
type MinIOStorage struct {
	client *minio.Client
	bucket string
	logger *zap.Logger
}

func newMinIOStorage(cfg *config.Config, logger *zap.Logger) (*MinIOStorage, error) {
	client, err := minio.New(cfg.StorageMinioEndpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.StorageMinioAccessKey, cfg.StorageMinioSecretKey, ""),
		Secure: cfg.StorageMinioUseSSL,
		Region: cfg.StorageMinioRegion,
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 MinIO 客户端失败: %w", err)
	}

	// 确保 bucket 存在
	ctx := context.Background()
	exists, err := client.BucketExists(ctx, cfg.StorageMinioBucket)
	if err != nil {
		return nil, fmt.Errorf("检查 bucket 失败: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.StorageMinioBucket, minio.MakeBucketOptions{
			Region: cfg.StorageMinioRegion,
		}); err != nil {
			return nil, fmt.Errorf("创建 bucket 失败: %w", err)
		}
		logger.Info("已创建 MinIO bucket", zap.String("bucket", cfg.StorageMinioBucket))
	}

	logger.Info("使用 MinIO 存储后端",
		zap.String("endpoint", cfg.StorageMinioEndpoint),
		zap.String("bucket", cfg.StorageMinioBucket),
	)
	return &MinIOStorage{client: client, bucket: cfg.StorageMinioBucket, logger: logger}, nil
}

func (s *MinIOStorage) Put(ctx context.Context, key string, reader io.Reader, size int64, contentType string) error {
	_, err := s.client.PutObject(ctx, s.bucket, key, reader, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	return err
}

func (s *MinIOStorage) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	return obj, nil
}

func (s *MinIOStorage) Delete(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

func (s *MinIOStorage) PresignedURL(ctx context.Context, key string, expires time.Duration) (string, error) {
	u, err := s.client.PresignedGetObject(ctx, s.bucket, key, expires, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}
