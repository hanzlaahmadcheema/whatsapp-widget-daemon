# whatsapp-widget-daemon

Lightweight, event-driven background daemon for the `end4-pC` WhatsApp desktop widget (`WhatsAppWidget.qml`).

## Features

- **WhatsApp Protocol Integration:** Direct WhatsApp Web WebSocket connectivity via `@whiskeysockets/baileys`.
- **Zero Heavy Browsers:** Runs fully headless without Puppeteer or Chromium.
- **Unix Domain Socket IPC:** Fast, clean JSON IPC stream over `/run/user/$UID/whatsapp-daemon.sock`.
- **Event-Driven Architecture:** Zero polling; updates emitted in real time as socket events.
- **Session Persistence:** Persistent auth state saved to `~/.config/whatsapp-widget-daemon/session`.
- **Resilient Reconnection:** Automatic exponential backoff reconnects on network dropouts.
- **Systemd Integration:** Optional user systemd service file included.

## Installation & Setup

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Build the Daemon:**
   ```bash
   npm run build
   ```

3. **Run Daemon & Authenticate:**
   ```bash
   npm start
   ```
   On first run, scan the displayed QR code with WhatsApp on your phone (`WhatsApp -> Linked Devices -> Link a Device`).

4. **Run as Systemd Service (Optional):**
   ```bash
   mkdir -p ~/.config/systemd/user/
   cp systemd/whatsapp-widget-daemon.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now whatsapp-widget-daemon
   ```

## IPC Contract & Protocol

Communication occurs via newline-delimited JSON (`\n`) over Unix socket at `/run/user/$UID/whatsapp-daemon.sock`.

### Outbound Widget Requests:
- `send_message`: `{ "action": "send_message", "recipient": "923001234567", "message": "Hello world" }`
- `mark_read`: `{ "action": "mark_read", "chatId": "12036304@c.us" }`
- `get_status`: `{ "action": "get_status" }`
- `get_unread_chats`: `{ "action": "get_unread_chats" }`

### Inbound Daemon Events:
- `status_changed`: `{ "event": "status_changed", "configured": true, "connected": true, "status": "connected" }`
- `unread_chats_updated`: `{ "event": "unread_chats_updated", "chats": [...] }`
# whatsapp-widget-daemon
