#!/bin/bash
set -e

echo "[IDF Builder] Starting compilation..."
echo "[IDF Builder] Target: ${IDF_TARGET:-esp32s3}"
echo "[IDF Builder] Project dir: ${PROJECT_DIR:-/src}"
echo "[IDF Builder] Output dir: ${OUTPUT_DIR:-/output}"

# Activate IDF environment
. $IDF_PATH/export.sh

# Support sub-directory projects (e.g. platforms/esp32)
SRC_DIR="${PROJECT_DIR:-/src}"
OUT_DIR="${OUTPUT_DIR:-/output}"
TARGET="${IDF_TARGET:-esp32s3}"
FLASH_SIZE="${FLASH_SIZE:-4MB}"

cd "$SRC_DIR"

# Set target (only needed on first build or target change)
idf.py set-target "$TARGET" 2>&1 || true

# Build the project
idf.py build 2>&1

EXIT_CODE=$?
if [ $EXIT_CODE -ne 0 ]; then
    echo "[IDF Builder] Compilation failed with exit code $EXIT_CODE"
    exit $EXIT_CODE
fi

echo "[IDF Builder] Compilation successful!"

# Copy individual bin files
cp build/*.bin "$OUT_DIR/" 2>/dev/null || true
cp build/partition_table/partition-table.bin "$OUT_DIR/" 2>/dev/null || true
cp build/bootloader/bootloader.bin "$OUT_DIR/" 2>/dev/null || true
cp build/flash_project_args "$OUT_DIR/" 2>/dev/null || true

# Merge all bin files into a single flashable firmware
# This allows the web IDE to flash from address 0x0 with a single file
if [ -f build/flash_project_args ]; then
    echo "[IDF Builder] Merging firmware bins..."
    cd build
    esptool.py --chip "$TARGET" merge_bin \
        -o "$OUT_DIR/merged-firmware.bin" \
        --flash_mode dio \
        --flash_freq 80m \
        --flash_size "$FLASH_SIZE" \
        @flash_project_args 2>&1
    echo "[IDF Builder] Merged firmware created: merged-firmware.bin"
fi

echo "[IDF Builder] Output files:"
ls -la "$OUT_DIR/"
