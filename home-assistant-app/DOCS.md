# Home Assistant Screenshot App

## Before starting

Create a dedicated, non-administrator Home Assistant user and create a Long-Lived Access Token from that user's profile. Enter the token in the App configuration. Revoke and replace it if it might have been disclosed.

The default `ha_url` uses Home Assistant's internal app-network hostname. Change it only when your installation requires another URL. Set `ignore_https_errors` only when that URL uses a certificate Chromium cannot validate.

## First run

1. Save the App options and start the App.
2. Open **Web UI** from the App page.
3. Add at least one capture task and select **Save & apply**.
4. Wait for the first capture, then fetch `http://<home-assistant-host>:3000/screenshots/<task-id>` from the display.

Port 3000 is deliberately unauthenticated. Keep it on a trusted LAN or add network controls appropriate for your installation. The ingress URL is authenticated and session-oriented; do not give it to display clients.

## Persistence and backups

Supervisor options stay in `/data/options.json`. Tasks and feeds are stored atomically in `/data/config.json`, while last-good images are under `/data/images/`. These App-owned files are included in Home Assistant backups.

The Home Assistant access token is read from Supervisor options and is not copied into the task document or image directory.

## Installation compatibility

Apps require Home Assistant OS or another Supervisor-managed installation. Home Assistant Container users should run the same image with Docker or Compose as documented in the repository README.
