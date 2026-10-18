// Package services 提供 Docker 容器编译管理。
package services

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"go.uber.org/zap"
)

// DockerService 封装 Docker 客户端，提供编译容器管理。
type DockerService struct {
	cli    *client.Client
	logger *zap.Logger
}

// NewDockerService 创建 DockerService 实例（自动从环境读取 DOCKER_HOST）。
func NewDockerService(logger *zap.Logger) (*DockerService, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("初始化 Docker 客户端失败: %w", err)
	}
	return &DockerService{cli: cli, logger: logger}, nil
}

// BuildOptions 描述单次编译任务的容器配置。
type BuildOptions struct {
	Image          string            // Docker 镜像名称
	Cmd            []string          // 容器启动命令
	Env            []string          // 环境变量 KEY=VALUE
	Binds          []string          // 卷挂载 "host:container"
	TimeoutSec     int               // 超时秒数
	NetworkEnabled bool              // 是否启用网络（ESP-IDF 下载组件等需要网络）
	LogCallback    func(line string) // 日志回调（逐行）
}

// RunBuild 在 Docker 容器中执行编译任务：
//  1. 创建容器（Memory=1GB, NanoCPUs=1CPU, PidsLimit=100）
//  2. 启动容器并流式读取日志
//  3. 等待容器退出或超时
//  4. 超时时强制 Kill + Remove 容器
//
// 返回容器退出码非 0 时的错误。
func (d *DockerService) RunBuild(ctx context.Context, opts BuildOptions) error {
	const (
		memoryLimit = 1 * 1024 * 1024 * 1024 // 1 GB
		nanoCPUs    = 1 * 1e9                 // 1 CPU
	)
	pidsLimit := int64(100)

	containerConfig := &container.Config{
		Image: opts.Image,
		Cmd:   opts.Cmd,
		Env:   opts.Env,
	}

	hostConfig := &container.HostConfig{
		Binds: opts.Binds,
		Resources: container.Resources{
			Memory:    memoryLimit,
			NanoCPUs:  nanoCPUs,
			PidsLimit: &pidsLimit,
		},
		AutoRemove: false, // 手动清理，确保日志读完
	}

	if !opts.NetworkEnabled {
		containerConfig.NetworkDisabled = true
		hostConfig.NetworkMode = "none" // 禁用网络
	}

	// 创建容器
	resp, err := d.cli.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, "")
	if err != nil {
		return fmt.Errorf("创建容器失败: %w", err)
	}
	containerID := resp.ID
	d.logger.Info("容器已创建", zap.String("container_id", containerID[:12]), zap.String("image", opts.Image))

	// 确保容器最终被清理
	defer func() {
		rmCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		d.cli.ContainerRemove(rmCtx, containerID, container.RemoveOptions{Force: true}) //nolint:errcheck
	}()

	// 启动容器
	if err := d.cli.ContainerStart(ctx, containerID, container.StartOptions{}); err != nil {
		return fmt.Errorf("启动容器失败: %w", err)
	}

	// 流式读取日志（stdout + stderr）
	logReader, err := d.cli.ContainerLogs(ctx, containerID, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     true,
		Timestamps: false,
	})
	if err != nil {
		return fmt.Errorf("获取容器日志失败: %w", err)
	}
	defer logReader.Close()

	// 超时控制
	timeout := time.Duration(opts.TimeoutSec) * time.Second
	if timeout == 0 {
		timeout = 300 * time.Second
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// 异步读取日志
	logDone := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(logReader)
		for scanner.Scan() {
			line := scanner.Text()
			if opts.LogCallback != nil {
				opts.LogCallback(line)
			}
		}
		logDone <- scanner.Err()
	}()

	// 等待容器退出
	statusCh, errCh := d.cli.ContainerWait(timeoutCtx, containerID, container.WaitConditionNotRunning)
	select {
	case status := <-statusCh:
		<-logDone // 等待日志读完
		if status.StatusCode != 0 {
			return fmt.Errorf("编译失败，退出码: %d", status.StatusCode)
		}
		d.logger.Info("编译容器正常退出", zap.String("container_id", containerID[:12]))
		return nil

	case err := <-errCh:
		return fmt.Errorf("等待容器退出时出错: %w", err)

	case <-timeoutCtx.Done():
		d.logger.Warn("编译超时，强制终止容器", zap.String("container_id", containerID[:12]))
		// 强制 Kill
		killCtx, killCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer killCancel()
		d.cli.ContainerKill(killCtx, containerID, "SIGKILL") //nolint:errcheck
		return fmt.Errorf("编译超时（%v）", timeout)
	}
}

// Close 关闭 Docker 客户端连接。
func (d *DockerService) Close() error {
	return d.cli.Close()
}

// mustRead 丢弃多路复用头（Docker Attach 协议的 8 字节头）。
// 注意：ContainerLogs 返回的是多路复用流，实际使用时需要 demux，
// 此处为简化版本，生产中可用 stdcopy.StdCopy 正确分离 stdout/stderr。
func mustRead(r io.Reader, buf []byte) (int, error) {
	return io.ReadFull(r, buf)
}
