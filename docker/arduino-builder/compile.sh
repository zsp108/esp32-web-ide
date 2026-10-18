#!/bin/bash
set -e

echo "[Arduino Builder] Starting compilation..."
echo "[Arduino Builder] Board: $BOARD_FQBN"
echo "[Arduino Builder] Project dir: ${PROJECT_DIR:-/src}"
echo "[Arduino Builder] Output dir: ${OUTPUT_DIR:-/output}"

SRC_DIR="${PROJECT_DIR:-/src}"
OUT_DIR="${OUTPUT_DIR:-/output}"

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
