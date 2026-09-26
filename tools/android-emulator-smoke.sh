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


# GitHub's Pixel emulator can occasionally surface launcher/Quickstep ANR
# dialogs while the tested Activity itself is healthy. Those OS-owned dialogs
# steal Back presses and cover screenshots, so disable them for deterministic
# UI evidence. This does not suppress MeriStream crashes: logcat + foreground
# checks below still fail the smoke on app process failures.
suppress_emulator_system_dialogs() {
  adb shell settings put global hide_error_dialogs 1 >/dev/null 2>&1 || true
  adb shell settings put global show_first_crash_dialog 0 >/dev/null 2>&1 || true
  adb shell settings put global show_restart_in_crash_dialog 0 >/dev/null 2>&1 || true
  adb shell settings put secure anr_show_background 0 >/dev/null 2>&1 || true
  # Android's one-time immersive-mode education ("Viewing full screen") is
  # system UI, not part of MeriStream. Mark it acknowledged so it cannot cover
  # player screenshots or consume the Back press meant for the overflow sheet.
  adb shell settings put secure immersive_mode_confirmations confirmed >/dev/null 2>&1 || true
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
}

assert_app_foreground() {
  local activity_dump window_dump
  activity_dump="$(adb shell dumpsys activity activities 2>/dev/null || true)"
  window_dump="$(adb shell dumpsys window windows 2>/dev/null || true)"

  if printf '%s\n' "$activity_dump" | grep -E "topResumedActivity=.*me\.merith\.meristream/.MainActivity|mResumedActivity:.*me\.merith\.meristream/.MainActivity|ResumedActivity:.*me\.merith\.meristream/.MainActivity" >/dev/null; then
    return 0
  fi
  if printf '%s\n' "$window_dump" | grep -E "mCurrentFocus=.*me\.merith\.meristream/.MainActivity|mFocusedApp=.*me\.merith\.meristream/.MainActivity" >/dev/null; then
    return 0
  fi

  echo "MeriStream is not detected as the foreground Activity."
  printf '%s\n' "$activity_dump" | grep -E "Resumed|meristream|MainActivity" | tail -40 || true
  printf '%s\n' "$window_dump" | grep -E "CurrentFocus|FocusedApp|meristream" | tail -40 || true
  return 1
}
trap capture_logcat EXIT

echo "Installing: $APK_PATH"
suppress_emulator_system_dialogs
adb install -r "$APK_PATH"
adb logcat -c
adb shell am force-stop me.merith.meristream
adb shell am start -W -n me.merith.meristream/.MainActivity | tee "${PREFIX}-start.txt"
sleep "$START_DELAY"
suppress_emulator_system_dialogs
sleep 1

# The activity must still be the foreground Android surface. Android 10 and
# Android 15 expose different dumpsys field names, so check both families.
adb exec-out screencap -p > "${PREFIX}-startup.png" || true
assert_app_foreground
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
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-native-plugins
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs performance | tee "${PREFIX}-performance.txt"

if [[ "$MODE" == "low-end" ]]; then
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-low-end-mode
fi

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

  # Watch Party create/join must also behave as a native sheet.
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-watch-party
  sleep 1
  adb exec-out screencap -p > meristream-watch-party.png || true
  adb shell input keyevent 4
  DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-watch-party-closed

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
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-native-player
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs play
sleep "$PLAY_DELAY"
adb exec-out screencap -p > "${PREFIX}-player.png" || true
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-player

DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-player-more
sleep 1
adb exec-out screencap -p > "${PREFIX}-player-more.png" || true
adb shell input keyevent 4
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-player-more-closed

DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-player-party
adb shell input keyevent 4
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-player-party-closed

DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs open-player-quality
adb shell input keyevent 4
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-player-quality-closed

adb shell input keyevent 4
DEVTOOLS_PORT=9222 node tools/android-webview-smoke.mjs assert-player-closed

adb shell dumpsys meminfo me.merith.meristream > "${PREFIX}-meminfo.txt" || true
capture_logcat
assert_app_foreground
! grep -E "FATAL EXCEPTION.*me\.merith\.meristream|Process: me\.merith\.meristream" "${PREFIX}-logcat.txt"

echo "Android ${MODE} smoke completed successfully."
