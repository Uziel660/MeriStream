#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-full}"
APK_PATH="${2:-android/app/build/outputs/apk/debug/app-debug.apk}"

if [[ "$MODE" == "low-end" ]]; then
  PREFIX="meristream-low-end"
  START_DELAY=12
  PLAY_DELAY=6
else
  PREFIX="meristream"
  START_DELAY=18
  PLAY_DELAY=5
fi

capture_logcat() {
  adb logcat -d > "${PREFIX}-logcat.txt" 2>/dev/null || true
}
trap capture_logcat EXIT

echo "Installing: $APK_PATH"
adb install -r "$APK_PATH"
adb logcat -c
adb shell am force-stop me.merith.meristream
adb shell am start -W -n me.merith.meristream/.MainActivity | tee "${PREFIX}-start.txt"
sleep "$START_DELAY"

# The activity must still be the foreground Android surface.
adb shell dumpsys activity activities | grep -E "topResumedActivity=.*me.merith.meristream/.MainActivity"
adb shell ps -A | grep -i meristream || true

if [[ "$MODE" == "full" ]]; then
  adb shell uiautomator dump /sdcard/meristream-window.xml || true
  adb pull /sdcard/meristream-window.xml meristream-window.xml || true
  adb exec-out screencap -p > meristream-emulator.png || true
fi

# Wait for the debuggable WebView socket created by MainActivity.
SOCKET=""
for attempt in $(seq 1 20); do
  SOCKET="$(adb shell cat /proc/net/unix 2>/dev/null | grep -o 'webview_devtools_remote_[^ ]*' | head -1 | tr -d '\r' || true)"
  [[ -n "$SOCKET" ]] && break
  sleep 1
done

if [[ -z "$SOCKET" ]]; then
  echo "No WebView DevTools socket found."
  adb shell dumpsys package me.merith.meristream | grep -E "DEBUGGABLE|flags=" | head -8 || true
  adb logcat -d | tail -300 || true
  exit 1
fi

echo "Using WebView DevTools socket: $SOCKET"
adb forward --remove tcp:9222 >/dev/null 2>&1 || true
adb forward tcp:9222 "localabstract:$SOCKET"

PAGES_READY=0
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9222/json > "/tmp/${PREFIX}-webview-pages.json" 2>/dev/null; then
    PAGES_READY=1
    break
  fi
  sleep 1
done

if [[ "$PAGES_READY" != "1" ]]; then
  echo "WebView DevTools endpoint never became ready."
  exit 1
fi
cat "/tmp/${PREFIX}-webview-pages.json"

DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs state

if [[ "$MODE" == "full" ]]; then
  # Production can be Cloudflare-challenged from GitHub-hosted IPs. Seed the
  # app's own local catalog cache so UI screenshots remain deterministic and
  # exercise the real production React tree without mocking components.
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs seed-catalog
  adb exec-out screencap -p > meristream-catalog-seeded.png || true

  # Native navigation sheet.
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-menu
  sleep 1
  adb exec-out screencap -p > meristream-menu.png
  adb shell input keyevent 4
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-menu-closed

  # Preferences sheet + physical Back.
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-preferences
  sleep 1
  adb exec-out screencap -p > meristream-preferences.png
  adb shell input keyevent 4
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-preferences-closed

  # Login/register is a native bottom sheet and must honor hardware Back.
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-auth
  adb exec-out screencap -p > meristream-auth.png || true
  adb shell input keyevent 4
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-auth-closed

  # Explore filters are condensed into a touch-first sheet.
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-explore-filters
  adb exec-out screencap -p > meristream-explore-filters.png || true
  adb shell input keyevent 4
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-explore-filters-closed

  # Guest lists must remain reachable and list creation should feel native.
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-lists
  adb exec-out screencap -p > meristream-lists.png || true
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-list-create
  adb exec-out screencap -p > meristream-list-create.png || true
  adb shell input keyevent 4
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-list-modal-closed
fi

# Public HLS playback smoke, independent from the production Cloudflare gate.
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-player
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs play
sleep "$PLAY_DELAY"
adb exec-out screencap -p > "${PREFIX}-player.png" || true
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-player

adb shell dumpsys meminfo me.merith.meristream > "${PREFIX}-meminfo.txt" || true
capture_logcat
adb shell dumpsys activity activities | grep -E "topResumedActivity=.*me.merith.meristream/.MainActivity"
! grep -E "FATAL EXCEPTION.*me\.merith\.meristream|Process: me\.merith\.meristream" "${PREFIX}-logcat.txt"

echo "Android ${MODE} smoke completed successfully."
