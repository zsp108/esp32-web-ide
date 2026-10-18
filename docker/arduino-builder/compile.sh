#!/bin/bash
set -e

SRC_DIR="${PROJECT_DIR:-/src}"
OUT_DIR="${OUTPUT_DIR:-/output}"

# 如果 SRC_DIR 中有 .ino 文件，但目录名与 .ino 不一致（例如 /src/test.ino），
# Arduino CLI 要求目录名必须与主 .ino 保持一致：
FIRST_INO=$(find "$SRC_DIR" -maxdepth 2 -name "*.ino" 2>/dev/null | head -n 1)
if [ -n "$FIRST_INO" ]; then
    INO_NAME=$(basename "$FIRST_INO" .ino)
    DIR_NAME=$(basename "$(dirname "$FIRST_INO")")
    if [ "$INO_NAME" != "$DIR_NAME" ]; then
        SKETCH_DIR="/tmp/sketch/$INO_NAME"
        mkdir -p "$SKETCH_DIR"
        cp -a "$SRC_DIR/." "$SKETCH_DIR/"
        SRC_DIR="$SKETCH_DIR"
    else
        SRC_DIR="$(dirname "$FIRST_INO")"
    fi
fi

echo "[Arduino Builder] Starting compilation..."
echo "[Arduino Builder] Board: $BOARD_FQBN"
echo "[Arduino Builder] Project dir: $SRC_DIR"
echo "[Arduino Builder] Output dir: $OUT_DIR"

arduino-cli compile \
    --fqbn "$BOARD_FQBN" \
    "$SRC_DIR" \
    --output-dir "$OUT_DIR" \
    --warnings all 2>&1

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
    echo "[Arduino Builder] Compilation successful!"
    ls -la "$OUT_DIR/"
else
    echo "[Arduino Builder] Compilation failed with exit code $EXIT_CODE"
fi
exit $EXIT_CODE
