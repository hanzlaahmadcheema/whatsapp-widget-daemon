#!/usr/bin/env bash
set -e

# Add common user bin paths to PATH if present for portable execution
for bin_dir in "$HOME/.local/bin" "$HOME/.nvm/versions/node/"*"/bin" "/usr/local/bin"; do
  if [ -d "$bin_dir" ]; then
    PATH="$bin_dir:$PATH"
  fi
done
export PATH

SERVICE_NAME="whatsapp-widget-daemon.service"
DAEMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/whatsapp-widget-daemon"

function show_help() {
  echo "Usage: ./whatsapp-daemon.sh <command>"
  echo ""
  echo "Commands:"
  echo "  start       Start the WhatsApp daemon user service"
  echo "  stop        Stop the WhatsApp daemon user service"
  echo "  restart     Restart the WhatsApp daemon user service"
  echo "  status      Display detailed daemon health & connection status"
  echo "  logs        Follow daemon logs in real time (journalctl)"
  echo "  auth        Display terminal QR code for WhatsApp authentication"
  echo "  uninstall   Cleanly remove systemd service and daemon installation"
  echo ""
}

function start_daemon() {
  echo "[+] Starting ${SERVICE_NAME}..."
  if systemctl --user is-active --quiet "$SERVICE_NAME"; then
    echo "[✓] Service ${SERVICE_NAME} is already running."
  else
    systemctl --user start "$SERVICE_NAME"
    echo "[✓] Service ${SERVICE_NAME} started successfully."
  fi
}

function stop_daemon() {
  echo "[+] Stopping ${SERVICE_NAME}..."
  systemctl --user stop "$SERVICE_NAME" || true
  echo "[✓] Daemon stopped."
}

function restart_daemon() {
  echo "[+] Restarting ${SERVICE_NAME}..."
  systemctl --user restart "$SERVICE_NAME"
  echo "[✓] Service ${SERVICE_NAME} restarted."
}

function show_status() {
  if [ ! -f "$DAEMON_DIR/dist/cli.js" ]; then
    echo "[!] Building CLI control module..."
    (cd "$DAEMON_DIR" && npm run build --silent)
  fi
  node "$DAEMON_DIR/dist/cli.js" status
}

function show_logs() {
  echo "[+] Displaying live daemon logs (Press Ctrl+C to exit)..."
  journalctl --user -u "$SERVICE_NAME" -f -n 50
}

function run_auth() {
  start_daemon
  if [ ! -f "$DAEMON_DIR/dist/cli.js" ]; then
    (cd "$DAEMON_DIR" && npm run build --silent)
  fi
  node "$DAEMON_DIR/dist/cli.js" auth
}

function uninstall_daemon() {
  echo "======================================================"
  echo "      WhatsApp Widget Daemon Uninstaller"
  echo "======================================================"
  echo ""
  
  echo "[+] Stopping and disabling systemd service..."
  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true

  UNIT_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$SERVICE_NAME"
  if [ -f "$UNIT_PATH" ]; then
    echo "[+] Removing systemd unit file ($UNIT_PATH)..."
    rm -f "$UNIT_PATH"
    systemctl --user daemon-reload 2>/dev/null || true
  fi

  SOCKET_PATH="/run/user/$(id -u)/whatsapp-daemon.sock"
  if [ -S "$SOCKET_PATH" ]; then
    echo "[+] Removing active socket ($SOCKET_PATH)..."
    rm -f "$SOCKET_PATH" 2>/dev/null || true
  fi

  echo ""
  read -p "Do you also want to delete WhatsApp session & auth data ($CONFIG_DIR)? [y/N]: " confirm
  case "$confirm" in
    [yY][eE][sS]|[yY])
      if [ -d "$CONFIG_DIR" ]; then
        rm -rf "$CONFIG_DIR"
        echo "[✓] Removed session and authentication data."
      fi
      ;;
    *)
      echo "[i] Preserved session and authentication data at $CONFIG_DIR."
      ;;
  esac

  echo ""
  echo "[✓] Uninstall completed successfully."
}

COMMAND="${1:-help}"

case "$COMMAND" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    restart_daemon
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs
    ;;
  auth)
    run_auth
    ;;
  uninstall)
    uninstall_daemon
    ;;
  help|--help|-h)
    show_help
    ;;
  *)
    echo "Unknown command: $COMMAND"
    show_help
    exit 1
    ;;
esac
