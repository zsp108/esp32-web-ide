package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func TestBoardsHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := NewBoardsHandler(zap.NewNop())
	r := gin.New()
	r.GET("/api/v1/boards", h.List)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/api/v1/boards", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d", w.Code)
	}

	var boards []Board
	if err := json.Unmarshal(w.Body.Bytes(), &boards); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	var foundWaveshare bool
	for _, b := range boards {
		// All boards must have flash_size
		if b.FlashSize == "" {
			t.Errorf("Board %s missing flash_size", b.ID)
		}
		// Boards with IDF support must have idf_target
		for _, fw := range b.Framework {
			if fw == "espidf" && b.IDFTarget == "" {
				t.Errorf("Board %s supports espidf but missing idf_target", b.ID)
			}
		}

		if b.ID == "waveshare:esp32s3:touch_amoled_175c" {
			foundWaveshare = true
			if b.Name != "Waveshare ESP32-S3-Touch-AMOLED-1.75C" {
				t.Errorf("Unexpected name: %s", b.Name)
			}
			if b.Chip != "ESP32-S3" {
				t.Errorf("Unexpected chip: %s", b.Chip)
			}
			if b.IDFTarget != "esp32s3" {
				t.Errorf("Unexpected idf_target: %s", b.IDFTarget)
			}
			if b.FlashSize != "32MB" {
				t.Errorf("Unexpected flash_size: %s", b.FlashSize)
			}
			if b.PSRAM != "8MB" {
				t.Errorf("Unexpected psram: %s", b.PSRAM)
			}
			if len(b.Framework) != 1 || b.Framework[0] != "espidf" {
				t.Errorf("Unexpected framework: %v", b.Framework)
			}
		}
	}

	if !foundWaveshare {
		t.Errorf("Waveshare ESP32-S3-Touch-AMOLED-1.75C not found in supportedBoards")
	}
}
