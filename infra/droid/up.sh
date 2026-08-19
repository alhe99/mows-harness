#!/usr/bin/env bash
# up.sh — bring up the Android QA stack: start the redroid container, wait for Android to
# finish booting, keep (re)connecting adb until it does. The ws-scrcpy web console needs
# no bringing up — it runs 24/7 via systemd (see ws-scrcpy.service.template) and shows the
# screen the moment the device is up. Stop when done: `docker stop redroid` — the
# container is on-demand by design (RAM budget), never auto-started at boot.
# Install: install -m755 infra/droid/up.sh ~/redroid/up.sh   (see SETUP.md)
set -e
docker start redroid 2>/dev/null || true
until [ "$(adb -s 127.0.0.1:6555 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
  adb connect 127.0.0.1:6555 >/dev/null 2>&1
  sleep 3
done
echo "Android up: adb device 127.0.0.1:6555"
echo "Web console: the dashboard's /droid page, or: ssh -L 8000:localhost:8000 <box>  ->  http://localhost:8000"
