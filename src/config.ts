import path from 'path';
import os from 'os';
import fs from 'fs';

export interface DaemonConfig {
  socketPath: string;
  sessionDir: string;
  stateFile: string;
  storeFile: string;
  contactsFile: string;
  defaultMaxUnreadChats: number;
  defaultMaxMessageHistory: number;
}

function getSocketPath(): string {
  if (process.env.WHATSAPP_DAEMON_SOCKET) {
    return process.env.WHATSAPP_DAEMON_SOCKET;
  }
  const uid = process.getuid ? process.getuid() : 1000;
  const runtimeDir = `/run/user/${uid}`;

  if (fs.existsSync(runtimeDir)) {
    return path.join(runtimeDir, 'whatsapp-daemon.sock');
  }

  const fallbackDir = path.join(os.homedir(), '.local', 'share', 'whatsapp-widget-daemon');
  if (!fs.existsSync(fallbackDir)) {
    fs.mkdirSync(fallbackDir, { recursive: true });
  }
  return path.join(fallbackDir, 'whatsapp-daemon.sock');
}

function getConfigDir(): string {
  const baseDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const dir = path.join(baseDir, 'whatsapp-widget-daemon');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

const configDir = getConfigDir();

export const daemonConfig: DaemonConfig = {
  socketPath: getSocketPath(),
  sessionDir: process.env.WHATSAPP_DAEMON_SESSION_DIR || path.join(configDir, 'session'),
  stateFile: process.env.WHATSAPP_DAEMON_STATE_FILE || path.join(configDir, 'state.json'),
  storeFile: process.env.WHATSAPP_DAEMON_STORE_FILE || path.join(configDir, 'baileys_store.json'),
  contactsFile: process.env.WHATSAPP_DAEMON_CONTACTS_FILE || path.join(configDir, 'contacts.json'),
  defaultMaxUnreadChats: 5,
  defaultMaxMessageHistory: 25,
};
