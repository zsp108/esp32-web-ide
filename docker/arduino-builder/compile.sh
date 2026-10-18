#!/bin/bash
set -e

SRC_DIR="${PROJECT_DIR:-/src}"
OUT_DIR="${OUTPUT_DIR:-/output}"

# 1. 如果 SRC_DIR 中有 .ino 文件，但目录名与 .ino 不一致，Arduino CLI 要求目录名必须与主 .ino 保持一致
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
else
    # 若用户删除了 .ino 文件，但有 .cpp 或 .c 文件，创建兼容的 Arduino sketch 入口
    FIRST_CPP=$(find "$SRC_DIR" -maxdepth 2 \( -name "*.cpp" -o -name "*.c" \) 2>/dev/null | head -n 1)
    if [ -n "$FIRST_CPP" ]; then
        echo "[Arduino Builder] 项目未包含 .ino 文件，检测到 C/C++ 源文件，正在生成 Arduino 规范入口..."
        SKETCH_DIR="/tmp/sketch/sketch"
        mkdir -p "$SKETCH_DIR"
        cp -a "$SRC_DIR/." "$SKETCH_DIR/"
        touch "$SKETCH_DIR/sketch.ino"
        SRC_DIR="$SKETCH_DIR"
    fi
fi

echo "[Arduino Builder] Starting compilation..."
echo "[Arduino Builder] Board: $BOARD_FQBN"
echo "[Arduino Builder] Project dir: $SRC_DIR"
echo "[Arduino Builder] Output dir: $OUT_DIR"

# 2. 依赖库自动检测与安装 (Library Auto-Dependency Management)
echo "[Arduino Builder] 正在智能扫描项目依赖库..."
declare -a LIBS_TO_INSTALL=()

# 2.1 检查 platformio.ini 中的 lib_deps
PIO_FILE=""
if [ -f "$SRC_DIR/platformio.ini" ]; then
    PIO_FILE="$SRC_DIR/platformio.ini"
elif [ -f "/src/platformio.ini" ]; then
    PIO_FILE="/src/platformio.ini"
fi

if [ -n "$PIO_FILE" ]; then
    echo "[Arduino Builder] 检测到 platformio.ini，正在解析 lib_deps 配置..."
    IN_LIB_DEPS=0
    while IFS= read -r line || [ -n "$line" ]; do
        trimmed=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        if [[ "$trimmed" =~ ^\[.*\] ]]; then
            IN_LIB_DEPS=0
        fi
        if [[ "$trimmed" =~ ^lib_deps ]]; then
            IN_LIB_DEPS=1
            val=$(echo "$trimmed" | sed 's/^lib_deps[[:space:]]*=[[:space:]]*//')
            if [ -n "$val" ]; then
                clean_val=$(echo "$val" | sed 's|^[^/]*/||; s|[@^~=<>].*$||; s/[[:space:]]*$//')
                [ -n "$clean_val" ] && LIBS_TO_INSTALL+=("$clean_val")
            fi
            continue
        fi
        if [ $IN_LIB_DEPS -eq 1 ]; then
            if [ -n "$trimmed" ] && ! [[ "$trimmed" =~ ^# ]] && ! [[ "$trimmed" =~ ^\; ]]; then
                clean_val=$(echo "$trimmed" | sed 's|^[^/]*/||; s|[@^~=<>].*$||; s/[[:space:]]*$//')
                [ -n "$clean_val" ] && LIBS_TO_INSTALL+=("$clean_val")
            fi
        fi
    done < "$PIO_FILE"
fi

# 2.2 检查 libraries.txt
LIB_TXT=""
if [ -f "$SRC_DIR/libraries.txt" ]; then
    LIB_TXT="$SRC_DIR/libraries.txt"
elif [ -f "/src/libraries.txt" ]; then
    LIB_TXT="/src/libraries.txt"
fi

if [ -n "$LIB_TXT" ]; then
    echo "[Arduino Builder] 检测到 libraries.txt，正在解析依赖列表..."
    while IFS= read -r line || [ -n "$line" ]; do
        trimmed=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        if [ -n "$trimmed" ] && ! [[ "$trimmed" =~ ^# ]]; then
            LIBS_TO_INSTALL+=("$trimmed")
        fi
    done < "$LIB_TXT"
fi

# 2.3 智能扫描源码文件中的 #include <...>
ALL_INCLUDES=$(grep -rohE '^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"][^>"]+[>"]' "$SRC_DIR" 2>/dev/null || true)

add_lib_if_included() {
    local header="$1"
    local lib_name="$2"
    if echo "$ALL_INCLUDES" | grep -qi "$header"; then
        LIBS_TO_INSTALL+=("$lib_name")
    fi
}

# 常见传感器、图形屏幕、通信驱动库字典匹配
add_lib_if_included "Adafruit_GFX.h" "Adafruit GFX Library"
add_lib_if_included "Adafruit_ST7735.h" "Adafruit ST7735 and ST7789 Library"
add_lib_if_included "Adafruit_ST7789.h" "Adafruit ST7735 and ST7789 Library"
add_lib_if_included "Adafruit_SSD1306.h" "Adafruit SSD1306"
add_lib_if_included "Adafruit_SH110X.h" "Adafruit SH110X"
add_lib_if_included "Adafruit_NeoPixel.h" "Adafruit NeoPixel"
add_lib_if_included "TFT_eSPI.h" "TFT_eSPI"
add_lib_if_included "ArduinoJson.h" "ArduinoJson"
add_lib_if_included "U8g2lib.h" "U8g2"
add_lib_if_included "FastLED.h" "FastLED"
add_lib_if_included "PubSubClient.h" "PubSubClient"
add_lib_if_included "AsyncTCP.h" "AsyncTCP"
add_lib_if_included "ESPAsyncWebServer.h" "ESPAsyncWebServer"
add_lib_if_included "DHT.h" "DHT sensor library"
add_lib_if_included "OneWire.h" "OneWire"
add_lib_if_included "DallasTemperature.h" "DallasTemperature"
add_lib_if_included "lvgl.h" "lvgl"
add_lib_if_included "LovyanGFX.hpp" "LovyanGFX"
add_lib_if_included "LovyanGFX.h" "LovyanGFX"
add_lib_if_included "TinyGPSPlus.h" "TinyGPSPlus"
add_lib_if_included "MPU6050.h" "MPU6050"

# 去重并安装所需第三方库
if [ ${#LIBS_TO_INSTALL[@]} -gt 0 ]; then
    # 通过排序去重
    UNIQUE_LIBS=($(printf "%s\n" "${LIBS_TO_INSTALL[@]}" | sort -u))
    echo "[Arduino Builder] 识别到 ${#UNIQUE_LIBS[@]} 个依赖库需求: ${UNIQUE_LIBS[*]}"

    for lib in "${UNIQUE_LIBS[@]}"; do
        [ -z "$lib" ] && continue
        INSTALLED=0
        clean_dir_name=$(echo "$lib" | tr ' ' '_')
        if [ -d "/root/Arduino/libraries/$lib" ] || [ -d "/root/Arduino/libraries/$clean_dir_name" ]; then
            INSTALLED=1
        elif arduino-cli lib list 2>/dev/null | grep -qFi "$lib"; then
            INSTALLED=1
        fi

        if [ $INSTALLED -eq 1 ]; then
            echo "[Arduino Builder] 依赖库已就绪 (本地缓存): $lib"
        else
            echo "[Arduino Builder] [LIBRARY_DOWNLOAD] 正在自动下载并安装依赖库: $lib ..."
            arduino-cli lib install "$lib" 2>&1 || {
                echo "[Arduino Builder] 警告: 安装依赖库 $lib 遇到非致命错误，将继续尝试编译"
            }
        fi
    done
else
    echo "[Arduino Builder] 未检测到第三方外部驱动库依赖，直接开始编译。"
fi

# 3. 执行编译
echo "[Arduino Builder] 正在执行 Arduino CLI 编译..."
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
