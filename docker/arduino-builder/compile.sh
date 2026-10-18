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
# 系统核心库 / 内置头文件排除规则
is_builtin_or_local() {
    local h="$1"
    case "$h" in
        Arduino.h|SPI.h|Wire.h|WiFi.h|WiFiClient.h|WiFiServer.h|WiFiUdp.h|WiFiMulti.h|\
        EEPROM.h|FS.h|SPIFFS.h|LittleFS.h|SD.h|SD_MMC.h|FFat.h|\
        BluetoothSerial.h|BLEDevice.h|BLEServer.h|BLEUtils.h|BLE2902.h|BLEClient.h|\
        Ticker.h|Update.h|WebServer.h|DNSServer.h|HTTPClient.h|HTTPUpdate.h|\
        Preferences.h|esp_now.h|esp_wifi.h|esp_timer.h|esp_system.h|esp_task_wdt.h|\
        driver/*|soc/*|freertos/*|hal/*|esp_*|\
        stdio.h|stdlib.h|string.h|math.h|stdint.h|stdbool.h|time.h|stddef.h|assert.h|\
        vector|string|map|memory|algorithm|utility|functional|queue|stack|set|iostream)
            return 0
            ;;
        *)
            if [ -f "$SRC_DIR/$h" ] || [ -f "$SRC_DIR/$(basename "$h")" ] || [ -f "/src/$h" ]; then
                return 0
            fi
            return 1
            ;;
    esac
}

# 常见传感器、图形屏幕、通信驱动库字典匹配
map_header_to_lib() {
    local h="$1"
    case "$h" in
        Adafruit_GFX.h) echo "Adafruit GFX Library" ;;
        Adafruit_ST7735.h|Adafruit_ST7789.h) echo "Adafruit ST7735 and ST7789 Library" ;;
        Adafruit_SSD1306.h) echo "Adafruit SSD1306" ;;
        Adafruit_SH110X.h|Adafruit_SH1106.h|Adafruit_SH1107.h) echo "Adafruit SH110X" ;;
        Adafruit_NeoPixel.h) echo "Adafruit NeoPixel" ;;
        Adafruit_Sensor.h) echo "Adafruit Unified Sensor" ;;
        Adafruit_BME280.h) echo "Adafruit BME280 Library" ;;
        Adafruit_BMP280.h) echo "Adafruit BMP280 Library" ;;
        Adafruit_MPU6050.h) echo "Adafruit MPU6050" ;;
        Adafruit_AHTX0.h) echo "Adafruit AHTX0" ;;
        Adafruit_MAX31865.h) echo "Adafruit MAX31865 library" ;;
        Adafruit_ADS1X15.h) echo "Adafruit ADS1X15" ;;
        Adafruit_INA219.h) echo "Adafruit INA219" ;;
        Adafruit_VL53L0X.h) echo "Adafruit_VL53L0X" ;;
        Adafruit_TCS34725.h) echo "Adafruit TCS34725" ;;
        Adafruit_SHT31.h) echo "Adafruit SHT31 Library" ;;
        Adafruit_EPD.h) echo "Adafruit EPD" ;;
        Adafruit_ILI9341.h) echo "Adafruit ILI9341" ;;
        Adafruit_BusIO_Register.h|Adafruit_I2CDevice.h|Adafruit_SPIDevice.h) echo "Adafruit BusIO" ;;
        TFT_eSPI.h) echo "TFT_eSPI" ;;
        ArduinoJson.h) echo "ArduinoJson" ;;
        U8g2lib.h) echo "U8g2" ;;
        FastLED.h) echo "FastLED" ;;
        PubSubClient.h) echo "PubSubClient" ;;
        AsyncTCP.h) echo "AsyncTCP" ;;
        ESPAsyncWebServer.h) echo "ESPAsyncWebServer" ;;
        DHT.h|DHT_U.h) echo "DHT sensor library" ;;
        OneWire.h) echo "OneWire" ;;
        DallasTemperature.h) echo "DallasTemperature" ;;
        lvgl.h) echo "lvgl" ;;
        LovyanGFX.hpp|LovyanGFX.h) echo "LovyanGFX" ;;
        TinyGPSPlus.h) echo "TinyGPSPlus" ;;
        MPU6050.h) echo "MPU6050" ;;
        LiquidCrystal_I2C.h) echo "LiquidCrystal I2C" ;;
        LiquidCrystal.h) echo "LiquidCrystal" ;;
        RTClib.h) echo "RTClib" ;;
        Encoder.h) echo "Encoder" ;;
        Bounce2.h) echo "Bounce2" ;;
        ESP32Servo.h|Servo.h) echo "ESP32Servo" ;;
        NTPClient.h) echo "NTPClient" ;;
        WebSocketsClient.h|WebSocketsServer.h) echo "WebSockets" ;;
        AsyncMqttClient.h) echo "AsyncMqttClient" ;;
        IRremoteESP8266.h) echo "IRremoteESP8266" ;;
        IRremote.h) echo "IRremote" ;;
        ESP8266Audio.h|AudioFileSourceSPIFFS.h) echo "ESP8266Audio" ;;
        TFT_eWidget.h) echo "TFT_eWidget" ;;
        Button2.h) echo "Button2" ;;
        *) echo "" ;;
    esac
}

# 提取源码中的所有 #include <Header.h> 并匹配依赖
RAW_INCLUDES=$(grep -rohE '^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"][^>"]+[>"]' "$SRC_DIR" 2>/dev/null \
    | sed -E 's/^[[:space:]]*#[[:space:]]*include[[:space:]]*[<"]//; s/[>"].*$//' \
    | sort -u || true)

while IFS= read -r header; do
    [ -z "$header" ] && continue
    if is_builtin_or_local "$header"; then
        continue
    fi

    # 1. 优先查高频流行库字典
    mapped=$(map_header_to_lib "$header")
    if [ -n "$mapped" ]; then
        LIBS_TO_INSTALL+=("$mapped")
        continue
    fi

    # 2. 若字典未收录，提取头文件主干并在官方库索引中动态模糊匹配
    stem=$(basename "$header" | sed 's/\.[^.]*$//')
    if [ -n "$stem" ]; then
        searched=$(arduino-cli lib search "$stem" --names 2>/dev/null | grep -E '^Name: ' | head -n 1 | sed 's/^Name: "//; s/"$//' || true)
        if [ -n "$searched" ]; then
            LIBS_TO_INSTALL+=("$searched")
        else
            LIBS_TO_INSTALL+=("$stem")
        fi
    fi
done <<< "$RAW_INCLUDES"

# 2.4 使用关联数组安全去重（严格保留库名称内部的空格）
declare -A SEEN_MAP=()
UNIQUE_LIBS=()
for item in "${LIBS_TO_INSTALL[@]}"; do
    trimmed=$(echo "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$trimmed" ] && continue
    if [ -z "${SEEN_MAP["$trimmed"]}" ]; then
        SEEN_MAP["$trimmed"]=1
        UNIQUE_LIBS+=("$trimmed")
    fi
done

if [ ${#UNIQUE_LIBS[@]} -gt 0 ]; then
    echo "[Arduino Builder] 识别到 ${#UNIQUE_LIBS[@]} 个依赖库需求:"
    for lib in "${UNIQUE_LIBS[@]}"; do
        echo "  - $lib"
    done

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
            echo "[Arduino Builder] 依赖库已就绪 (本地缓存): \"$lib\""
        else
            echo "[Arduino Builder] [LIBRARY_DOWNLOAD] 正在自动下载并安装依赖库: \"$lib\" ..."
            if arduino-cli lib install "$lib" 2>&1; then
                echo "[Arduino Builder] 成功安装依赖库: \"$lib\""
            else
                echo "[Arduino Builder] 提示: 通过 \"$lib\" 安装未成功，尝试在官方库索引中模糊搜索..."
                fuzzy=$(arduino-cli lib search "$lib" --names 2>/dev/null | grep -E '^Name: ' | head -n 1 | sed 's/^Name: "//; s/"$//' || true)
                if [ -n "$fuzzy" ] && [ "$fuzzy" != "$lib" ]; then
                    echo "[Arduino Builder] 匹配到最佳驱动库: \"$fuzzy\"，正在安装..."
                    arduino-cli lib install "$fuzzy" 2>&1 || true
                fi
            fi
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
