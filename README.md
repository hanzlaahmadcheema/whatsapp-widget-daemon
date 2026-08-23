# whatsapp-widget-daemon

Lightweight, event-driven background daemon for WhatsApp Web integration with desktop widgets (such as QuickShell, `end4-pC`, Waybar, or custom desktop clients).

---

## 🌟 Key Features

- **Direct WhatsApp Protocol:** Connects directly to WhatsApp Web WebSockets via `@whiskeysockets/baileys`.
- **Zero Heavy Browsers:** Headless and lightweight; no Chromium, Electron, or Puppeteer required.
- **Unix Domain Socket IPC:** Fast, zero-overhead JSON IPC stream over `/run/user/$UID/whatsapp-daemon.sock`.
- **Event-Driven Architecture:** Push-based updates; zero polling required by clients.
- **Systemd User Integration:** Runs seamlessly in user space with automated startup and restart behavior (`no sudo required`).
- **Interactive First-Run & CLI:** Simple management CLI (`./whatsapp-daemon.sh`) for status checks, interactive terminal QR authentication, and logs.
- **Resilient Identity & Sync:** Robust JID/LID/Phone normalization, display-name resolution, and graceful history sync handling.

---

## 🏗 Architecture & Client Independence

The daemon is designed to be **completely client-independent**. It operates as a standalone background service and does not depend on any specific desktop environment or widget implementation.

```
WhatsApp Web WebSockets
          │
          ▼
┌───────────────────────────┐
│  whatsapp-widget-daemon   │  (Systemd User Service)
└─────────────┬─────────────┘
              │  Unix Socket IPC
              ▼  (/run/user/$UID/whatsapp-daemon.sock)
 ┌─────────────────────────┐
 │ end4-pC WhatsApp Widget │  (or any custom desktop client)
 └─────────────────────────┘
```

The dependency flows strictly downwards:
`WhatsApp -> whatsapp-widget-daemon -> Unix Socket IPC -> Desktop Widget`

---

## 📋 System Requirements

- **OS:** Linux
- **Node.js:** >= 18.0.0
- **Service Manager:** `systemd` (user session)
- **Optional Utility:** `journalctl` (for logs)

---

## 🚀 Quick Start & Installation

To install and initialize the daemon:

```bash
git clone https://github.com/hanzlaahmadcheema/whatsapp-widget-daemon.git
cd whatsapp-widget-daemon
./install.sh
```

### What `install.sh` does automatically:
1. Validates OS, Node.js version, and systemd user session.
2. Installs npm dependencies (with retry logic for network drops).
3. Compiles TypeScript codebase (`npm run build`).
4. Generates a custom systemd user unit for your system environment (`~/.config/systemd/user/whatsapp-widget-daemon.service`).
5. Enables and starts the systemd service.
6. Automatically prompts for QR authentication if no session exists.

---

## 🔐 First-Time WhatsApp Authentication

If authentication is required on first run, `install.sh` will launch the interactive QR setup. You can also trigger it manually at any time:

```bash
./whatsapp-daemon.sh auth
```

### Setup Steps:
1. Open WhatsApp on your mobile phone.
2. Tap **Menu (⋮)** or **Settings** -> **Linked Devices**.
3. Tap **Link a Device**.
4. Point your camera at the QR code displayed in your terminal.

The terminal will track the progress in real time:
`Connecting → Authenticating → Syncing → Ready`

Once scanned, history sync completes in the background and the status shifts to `Ready`.

---

## 🛠 Daemon Management CLI (`./whatsapp-daemon.sh`)

Management commands are provided via the `./whatsapp-daemon.sh` script:

| Command | Description |
| :--- | :--- |
| `./whatsapp-daemon.sh start` | Start the systemd daemon service |
| `./whatsapp-daemon.sh stop` | Stop the systemd daemon service |
| `./whatsapp-daemon.sh restart` | Restart the systemd daemon service |
| `./whatsapp-daemon.sh status` | Check detailed daemon health and WhatsApp connection state |
| `./whatsapp-daemon.sh logs` | Follow live daemon logs using `journalctl` |
| `./whatsapp-daemon.sh auth` | Render terminal QR code and monitor authentication progress |
| `./whatsapp-daemon.sh uninstall` | Safely remove systemd unit and installation files |

---

## 📊 Health & Status Verification

Run `./whatsapp-daemon.sh status` to get a structured health report:

```
======================================================
   whatsapp-widget-daemon Health & Status Report     
======================================================
[✓] Daemon Process:     Running
[✓] IPC Socket:         /run/user/1000/whatsapp-daemon.sock (Available)
[✓] WhatsApp Auth:      Authenticated (~/.config/whatsapp-widget-daemon/session)
[✓] WhatsApp Web:       CONNECTED
[✓] Message Sync:       COMPLETED
[i] Last Connected:     8/23/2026, 8:30:00 PM
[i] Active Unread:      2 chats
[i] Cached Recent:      15 chats
======================================================
```

---

## ⚙️ Configuration & Environment Variables

Settings are configured via environment variables or default to XDG-compliant standard locations:

| Environment Variable | Default Path | Description |
| :--- | :--- | :--- |
| `WHATSAPP_DAEMON_SOCKET` | `/run/user/$UID/whatsapp-daemon.sock` | Unix domain socket path |
| `WHATSAPP_DAEMON_SESSION_DIR` | `~/.config/whatsapp-widget-daemon/session` | WhatsApp session credentials |
| `WHATSAPP_DAEMON_STATE_FILE` | `~/.config/whatsapp-widget-daemon/state.json` | Persisted state storage |
| `WHATSAPP_DAEMON_CONTACTS_FILE` | `~/.config/whatsapp-widget-daemon/contacts.json` | Contact metadata cache |

---

## 🔌 IPC Protocol Specification

Communication occurs over the Unix socket via newline-delimited JSON (`\n`).

### Widget Requests (Outbound to Daemon):

- **Get Status:**
  `{ "id": "req-1", "action": "get_status" }`

- **Get Recent Chats:**
  `{ "id": "req-2", "action": "get_recent_chats", "limit": 25 }`

- **Get Unread Chats:**
  `{ "id": "req-3", "action": "get_unread_chats" }`

- **Get Chat History:**
  `{ "id": "req-4", "action": "get_chat_history", "chatId": "923001234567@s.whatsapp.net", "limit": 25 }`

- **Send Message:**
  `{ "id": "req-5", "action": "send_message", "recipient": "923001234567", "message": "Hello!" }`

- **Send Quoted Reply:**
  `{ "id": "req-6", "action": "send_message", "recipient": "923001234567", "message": "Replying to this", "replyToMessageId": "MSG_ID_123" }`

- **Mark Chat as Read:**
  `{ "id": "req-7", "action": "mark_read", "chatId": "923001234567@s.whatsapp.net" }`

### Daemon Events (Inbound to Widget):

- **Status Changed:**
  `{ "event": "status_changed", "configured": true, "connected": true, "status": "connected", "syncState": "completed" }`

- **Unread Chats Updated:**
  `{ "event": "unread_chats_updated", "chats": [...] }`

- **Recent Chats Updated:**
  `{ "event": "recent_chats_updated", "chats": [...] }`

- **Message Received:**
  `{ "event": "message_received", "message": { "id": "...", "chatId": "...", "sender": "...", "text": "...", "time": "..." } }`

- **Message Status Updated:**
  `{ "event": "message_status_updated", "chatId": "...", "messageId": "...", "status": "read" }`

---

## 🔧 Troubleshooting & Recovery

### Session Expired or Logged Out
If a session is revoked or expires, the daemon automatically clears corrupted credential state, updates connection status to `unconfigured`, and logs clear warnings. Simply run:
```bash
./whatsapp-daemon.sh auth
```

### Restarting the Service
If the socket or process is unresponsive:
```bash
./whatsapp-daemon.sh restart
```

### Viewing Logs
To check live systemd unit logs:
```bash
./whatsapp-daemon.sh logs
```

---

## 🗑 Clean Uninstallation

To uninstall the daemon and user systemd service:

```bash
./whatsapp-daemon.sh uninstall
```

The uninstaller will remove the systemd unit file, socket, and build artifacts. It will ask for explicit confirmation before deleting WhatsApp session & authentication data (`~/.config/whatsapp-widget-daemon`).

---

## 📄 License

MIT License.
