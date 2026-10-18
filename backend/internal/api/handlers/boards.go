// Package handlers 提供板型（Board）相关的 HTTP 接口。
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Board 描述一块受支持的 ESP32 开发板。
type Board struct {
	ID        string   `json:"id"`              // Arduino FQBN 格式
	FQBN      string   `json:"fqbn,omitempty"`  // 兼容前端 fqbn 字段
	Name      string   `json:"name"`            // 友好显示名称
	Chip      string   `json:"chip"`            // 芯片类型
	Framework []string `json:"framework"`       // 支持的框架列表
	IDFTarget string   `json:"idf_target"`      // ESP-IDF 目标芯片
	FlashSize string   `json:"flash_size"`      // Flash 大小
	PSRAM     string   `json:"psram,omitempty"` // PSRAM 大小
}

// supportedBoards 是静态配置的受支持板型列表。
var supportedBoards = []Board{
	{
		ID:        "esp32:esp32:esp32",
		FQBN:      "esp32:esp32:esp32",
		Name:      "ESP32 DevKitC",
		Chip:      "ESP32",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32",
		FlashSize: "4MB",
	},
	{
		ID:        "esp32:esp32:esp32s3",
		FQBN:      "esp32:esp32:esp32s3:CDCOnBoot=cdc",
		Name:      "ESP32-S3 DevKit",
		Chip:      "ESP32-S3",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32s3",
		FlashSize: "8MB",
	},
	{
		ID:        "esp32:esp32:esp32s3_n16r8",
		FQBN:      "esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,CDCOnBoot=cdc",
		Name:      "ESP32-S3 N16R8 (16MB Flash / 8MB OPI PSRAM)",
		Chip:      "ESP32-S3",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32s3",
		FlashSize: "16MB",
		PSRAM:     "8MB",
	},
	{
		ID:        "esp32:esp32:esp32s2",
		FQBN:      "esp32:esp32:esp32s2",
		Name:      "ESP32-S2",
		Chip:      "ESP32-S2",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32s2",
		FlashSize: "4MB",
	},
	{
		ID:        "esp32:esp32:esp32c3",
		FQBN:      "esp32:esp32:esp32c3",
		Name:      "ESP32-C3",
		Chip:      "ESP32-C3",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32c3",
		FlashSize: "4MB",
	},
	{
		ID:        "esp32:esp32:waveshare_esp32_s3_zero",
		FQBN:      "esp32:esp32:waveshare_esp32_s3_zero",
		Name:      "Waveshare ESP32-S3-Zero",
		Chip:      "ESP32-S3",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32s3",
		FlashSize: "4MB",
	},
	{
		ID:        "esp32:esp32:waveshare_esp32_c3_zero",
		FQBN:      "esp32:esp32:waveshare_esp32_c3_zero",
		Name:      "Waveshare ESP32-C3-Zero",
		Chip:      "ESP32-C3",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32c3",
		FlashSize: "4MB",
	},
	{
		ID:        "esp32:esp32:waveshare_esp32_s3_touch_lcd",
		FQBN:      "esp32:esp32:waveshare_esp32_s3_touch_lcd",
		Name:      "Waveshare ESP32-S3-Touch-LCD",
		Chip:      "ESP32-S3",
		Framework: []string{"arduino", "espidf"},
		IDFTarget: "esp32s3",
		FlashSize: "16MB",
		PSRAM:     "8MB",
	},
	{
		ID:        "esp8266:esp8266:nodemcuv2",
		FQBN:      "esp8266:esp8266:nodemcuv2",
		Name:      "ESP8266 NodeMCU",
		Chip:      "ESP8266",
		Framework: []string{"arduino"},
		IDFTarget: "",
		FlashSize: "4MB",
	},
	{
		ID:        "waveshare:esp32s3:touch_amoled_175c",
		FQBN:      "waveshare:esp32s3:touch_amoled_175c",
		Name:      "Waveshare ESP32-S3-Touch-AMOLED-1.75C",
		Chip:      "ESP32-S3",
		Framework: []string{"espidf"},
		IDFTarget: "esp32s3",
		FlashSize: "32MB",
		PSRAM:     "8MB",
	},
}

// BoardsHandler 处理板型相关请求。
type BoardsHandler struct {
	logger *zap.Logger
}

// NewBoardsHandler 创建 BoardsHandler 实例。
func NewBoardsHandler(logger *zap.Logger) *BoardsHandler {
	return &BoardsHandler{logger: logger}
}

// List godoc
// @Summary  获取支持的板型列表
// @Tags     boards
// @Produce  json
// @Success  200  {array}  Board
// @Router   /api/v1/boards [get]
func (h *BoardsHandler) List(c *gin.Context) {
	c.JSON(http.StatusOK, supportedBoards)
}
