package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/esp32-web-ide/backend/internal/config"
	"github.com/esp32-web-ide/backend/internal/models"
)

func TestResolveImageAndCmd(t *testing.T) {
	svc := &BuildService{
		cfg: &config.Config{
			IDFBuilderImage:     "esp32-idf-builder:v5.5.5",
			ArduinoBuilderImage: "esp32-arduino-builder:latest",
		},
	}

	tempDir := t.TempDir()
	esp32Subdir := filepath.Join(tempDir, "platforms", "esp32")
	if err := os.MkdirAll(esp32Subdir, 0755); err != nil {
		t.Fatalf("Failed to create test subdir: %v", err)
	}

	build := &models.BuildRecord{
		Framework: "espidf",
		BoardFQBN: "waveshare:esp32s3:touch_amoled_175c",
	}

	img, cmd, env := svc.resolveImageAndCmd(build, tempDir)
	if img != "esp32-idf-builder:v5.5.5" {
		t.Errorf("Unexpected image: %s", img)
	}
	if cmd != nil {
		t.Errorf("Expected nil cmd for entrypoint, got: %v", cmd)
	}

	envMap := make(map[string]string)
	for _, e := range env {
		for i := 0; i < len(e); i++ {
			if e[i] == '=' {
				envMap[e[:i]] = e[i+1:]
				break
			}
		}
	}

	if envMap["PROJECT_DIR"] != "/src/platforms/esp32" {
		t.Errorf("Expected PROJECT_DIR=/src/platforms/esp32, got: %s", envMap["PROJECT_DIR"])
	}
	if envMap["ProjectDir"] != "/src/platforms/esp32" {
		t.Errorf("Expected ProjectDir=/src/platforms/esp32, got: %s", envMap["ProjectDir"])
	}
	if envMap["OUTPUT_DIR"] != "/output" {
		t.Errorf("Expected OUTPUT_DIR=/output, got: %s", envMap["OUTPUT_DIR"])
	}
	if envMap["IDF_TARGET"] != "esp32s3" {
		t.Errorf("Expected IDF_TARGET=esp32s3, got: %s", envMap["IDF_TARGET"])
	}
	if envMap["FLASH_SIZE"] != "32MB" {
		t.Errorf("Expected FLASH_SIZE=32MB, got: %s", envMap["FLASH_SIZE"])
	}
}

func TestResolveBinPath(t *testing.T) {
	tempDir := t.TempDir()
	outDir := filepath.Join(tempDir, "output")
	if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("Failed to create out dir: %v", err)
	}

	// 1. When merged-firmware.bin exists, it should be chosen first
	mergedPath := filepath.Join(outDir, "merged-firmware.bin")
	firmwarePath := filepath.Join(outDir, "firmware.bin")

	if err := os.WriteFile(firmwarePath, []byte("firmware"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mergedPath, []byte("merged"), 0644); err != nil {
		t.Fatal(err)
	}

	selected := resolveBinPath(tempDir, outDir, "espidf")
	if selected != mergedPath {
		t.Errorf("Expected %s, got %s", mergedPath, selected)
	}

	// 2. When merged-firmware.bin is removed, fall back to firmware.bin
	if err := os.Remove(mergedPath); err != nil {
		t.Fatal(err)
	}
	selected = resolveBinPath(tempDir, outDir, "espidf")
	if selected != firmwarePath {
		t.Errorf("Expected fallback %s, got %s", firmwarePath, selected)
	}
}
