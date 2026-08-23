#!/usr/bin/env bash
set -e

DAEMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/whatsapp-widget-daemon"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_NAME="whatsapp-widget-daemon.service"

echo "======================================================"
echo "    WhatsApp Widget Daemon Installation Setup"
echo "======================================================"
echo ""

# Add common user bin paths to PATH if present for portable execution
for bin_dir in "$HOME/.local/bin" "$HOME/.nvm/versions/node/"*"/bin" "/usr/local/bin"; do
  if [ -d "$bin_dir" ]; then
    PATH="$bin_dir:$PATH"
  fi
done
export PATH

OS_NAME="$(uname -s)"
if [ "$OS_NAME" != "Linux" ]; then
  echo "[✘] Error: whatsapp-widget-daemon requires a Linux operating system (detected: $OS_NAME)."
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[✘] Error: Node.js and npm are required. Please install Node.js (>= 18.0.0)."
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[✘] Error: Node.js version 18+ is required (detected $(node -v)). Please update Node.js."
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "[✘] Error: systemd is required to run the daemon service."
  exit 1
fi

# Test systemd user session
if ! systemctl --user status >/dev/null 2>&1; then
  echo "[!] Warning: systemd user session does not appear to be active or accessible."
fi

echo "[✓] Environment checks passed (Linux, Node.js $(node -v), systemd user session)."

# 2. Dependency Installation with Retries
echo ""
echo "[+] Installing npm dependencies..."
MAX_RETRIES=3
RETRY_COUNT=0
npm install || {
  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    echo "[!] npm install failed. Retrying ($RETRY_COUNT/$MAX_RETRIES)..."
    sleep 2
    npm install && break
  done
}

# 3. Build TypeScript Project
echo ""
echo "[+] Building TypeScript code..."
cd "$DAEMON_DIR"
npm run build

# 4. Systemd Service Setup
echo ""
echo "[+] Installing systemd user service..."

NODE_EXEC="$(command -v node)"
mkdir -p "$SYSTEMD_USER_DIR"

TEMPLATE_FILE="$DAEMON_DIR/systemd/whatsapp-widget-daemon.service.template"
TARGET_SERVICE="$SYSTEMD_USER_DIR/$SERVICE_NAME"

if [ ! -f "$TEMPLATE_FILE" ]; then
  echo "[✘] Error: Template file $TEMPLATE_FILE not found."
  exit 1
fi

sed -e "s|%NODE_EXEC%|$NODE_EXEC|g" \
    -e "s|%DAEMON_DIR%|$DAEMON_DIR|g" \
    "$TEMPLATE_FILE" > "$TARGET_SERVICE"

echo "[✓] Generated service unit at $TARGET_SERVICE"

echo "[+] Enabling and starting systemd user service..."
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

sleep 1

if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  echo "[✓] Daemon systemd service is active and running!"
else
  echo "[!] Warning: Service started but may not be active. Check logs with: ./whatsapp-daemon.sh logs"
fi

# 5. First-Run Setup & Authentication Check
echo ""
SESSION_FILE="$CONFIG_DIR/session/creds.json"
if [ ! -f "$SESSION_FILE" ]; then
  echo "======================================================"
  echo "            FIRST-TIME SETUP DETECTED"
  echo "======================================================"
  echo "No existing WhatsApp session found."
  echo "Launching interactive terminal QR code setup..."
  echo ""
  chmod +x "$DAEMON_DIR/whatsapp-daemon.sh"
  "$DAEMON_DIR/whatsapp-daemon.sh" auth
  AUTH_EXIT=$?
else
  echo "[✓] Found existing WhatsApp session credentials."
  chmod +x "$DAEMON_DIR/whatsapp-daemon.sh"
  "$DAEMON_DIR/whatsapp-daemon.sh" status
fi

echo ""
echo "======================================================"
echo "    Installation & Setup Complete!                    "
echo "======================================================"
echo "Useful Management Commands:"
echo "  ./whatsapp-daemon.sh status     Check daemon health"
echo "  ./whatsapp-daemon.sh auth       Re-authenticate WhatsApp"
echo "  ./whatsapp-daemon.sh logs       View real-time logs"
echo "  ./whatsapp-daemon.sh restart    Restart daemon service"
echo "  ./whatsapp-daemon.sh uninstall  Remove daemon & service"
echo "======================================================"
