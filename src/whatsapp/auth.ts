import { useMultiFileAuthState, AuthenticationState } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import { daemonConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export interface AuthManager {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  isConfigured: boolean;
}

export async function initAuth(): Promise<AuthManager> {
  const sessionDir = daemonConfig.sessionDir;
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const isConfigured = fs.existsSync(path.join(sessionDir, 'creds.json'));

    return {
      state,
      saveCreds,
      isConfigured,
    };
  } catch (err) {
    logger.error({ err }, 'Detected corrupted WhatsApp session state directory. Safely resetting session credentials...');
    clearSession();
    fs.mkdirSync(sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    return {
      state,
      saveCreds,
      isConfigured: false,
    };
  }
}

export function clearSession(): void {
  const sessionDir = daemonConfig.sessionDir;
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      logger.info(`Cleared invalid WhatsApp session credentials from ${sessionDir}`);
    }
  } catch (err) {
    logger.error({ err }, 'Failed to clear session directory');
  }
}

export function displayQRCode(qr: string): void {
  logger.info('Scan the QR code below using WhatsApp on your phone:');
  qrcode.generate(qr, { small: true });
}
