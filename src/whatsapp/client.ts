import makeWASocket, {
  DisconnectReason,
  WASocket,
  WAMessageStatus,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { initAuth, clearSession, displayQRCode, AuthManager } from './auth.js';
import { normalizeMessage, buildNormalizedChat, normalizeJid } from './normalizer.js';
import { StateManager } from '../store/state-manager.js';
import { logger } from '../utils/logger.js';

export class WhatsAppClient {
  private socket: WASocket | null = null;
  private authManager: AuthManager | null = null;
  private stateManager: StateManager;
  private isConnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private syncFallbackTimer: NodeJS.Timeout | null = null;
  private historySyncReceived: boolean = false;
  private contactsReceived: boolean = false;

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  public async initialize(): Promise<void> {
    try {
      this.authManager = await initAuth();
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'Failed to initialize WhatsApp Client');
      this.stateManager.setConnectionState(false, false, 'offline', 'failed');
      this.scheduleReconnect();
    }
  }

  private cleanupSocket(): void {
    this.clearSyncCompletionFallback();
    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.ev.removeAllListeners('messaging-history.set');
        this.socket.ev.removeAllListeners('chats.upsert');
        this.socket.ev.removeAllListeners('chats.update');
        this.socket.ev.removeAllListeners('contacts.upsert');
        this.socket.ev.removeAllListeners('contacts.update');
        this.socket.ev.removeAllListeners('messages.update');
        this.socket.ev.removeAllListeners('message-receipt.update');
        this.socket.end(undefined);
      } catch {}
      this.socket = null;
    }
  }

  private scheduleSyncCompletionFallback(): void {
    this.clearSyncCompletionFallback();
    // Fallback: If messaging-history.set takes longer than 15s or completes early, transition syncState to 'completed'
    this.syncFallbackTimer = setTimeout(() => {
      this.syncFallbackTimer = null;
      logger.info('History sync fallback timer reached. Transitioning daemon status to Ready.');
      this.completeSync();
    }, 15000);
  }

  private completeSync(): void {
    this.clearSyncCompletionFallback();
    if (!this.contactsReceived) {
      logger.info('No contacts received yet, deferring sync completion until contacts arrive');
      return;
    }
    this.stateManager.setSyncState('completed');
  }

  private clearSyncCompletionFallback(): void {
    if (this.syncFallbackTimer) {
      clearTimeout(this.syncFallbackTimer);
      this.syncFallbackTimer = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.cleanupSocket();

    if (!this.authManager) {
      this.authManager = await initAuth();
    }

    const { state, saveCreds, isConfigured } = this.authManager;
    this.stateManager.setConnectionState(isConfigured, false, isConfigured ? 'connecting' : 'unconfigured', 'idle');

    try {
      this.socket = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: logger.child({ module: 'baileys' }) as any,
        browser: ['end4-pC WhatsApp Widget', 'Desktop', '1.0.0'],
        syncFullHistory: true,
        shouldSyncHistoryMessage: () => true,
      });

      this.socket.ev.on('creds.update', async () => {
        await saveCreds();
      });

      this.socket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          logger.info('QR Code generated');
          displayQRCode(qr);
          this.stateManager.setConnectionState(false, false, 'authenticating', 'idle', qr);
        }

        if (connection === 'connecting') {
          logger.info('Connecting to WhatsApp Web...');
          const configured = !!this.authManager?.isConfigured;
          this.stateManager.setConnectionState(configured, false, configured ? 'connecting' : 'authenticating', 'idle');
        }

        if (connection === 'open') {
          logger.info('WhatsApp Web Connection Established');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.historySyncReceived = false;
          this.contactsReceived = false;
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          if (this.authManager) {
            this.authManager.isConfigured = true;
          }
          if (this.socket?.user?.id) {
            this.stateManager.setMyJid(this.socket.user.id);
          }
          // Set status to syncing and start fallback timer
          this.stateManager.setConnectionState(true, true, 'syncing', 'syncing');
          this.scheduleSyncCompletionFallback();
        }

        if (connection === 'close') {
          this.isConnecting = false;
          this.clearSyncCompletionFallback();
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
          const shouldReconnect = !isLoggedOut;

          logger.warn(
            { statusCode, shouldReconnect, isLoggedOut, err: lastDisconnect?.error },
            'WhatsApp Connection Closed'
          );

          this.cleanupSocket();

          if (isLoggedOut) {
            logger.error('Session logged out or credentials invalid (401). Clearing invalid credentials and restarting authentication...');
            clearSession();
            this.authManager = null;
            this.stateManager.setConnectionState(false, false, 'unconfigured', 'idle');
            this.reconnectAttempts = 0;
            this.scheduleReconnect(1000);
          } else {
            const configured = !!this.authManager?.isConfigured;
            this.stateManager.setConnectionState(configured, false, 'offline', 'idle');
            if (shouldReconnect) {
              this.scheduleReconnect();
            }
          }
        }
      });

      this.socket.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages) {
          const msgJid = normalizeJid(msg.key?.remoteJid || '');
          if (msgJid === '0@s.whatsapp.net' || msgJid === 'status@broadcast') continue;
          const normalizedMsg = normalizeMessage(msg);
          if (!normalizedMsg) continue;

          this.stateManager.addMessage(normalizedMsg);

          const chatId = normalizedMsg.chatId;
          let unreadCount = 1;
          const existingUnread = this.stateManager.getUnreadChats().find((c) => c.id === chatId);
          if (existingUnread) {
            unreadCount = existingUnread.unreadCount + (normalizedMsg.fromMe ? 0 : 1);
          } else if (normalizedMsg.fromMe) {
            unreadCount = 0;
          }

          const chatObj = buildNormalizedChat(
            chatId,
            msg.pushName || chatId,
            normalizedMsg.text,
            normalizedMsg.timestamp,
            unreadCount
          );

          this.stateManager.addOrUpdateChat(chatObj);
        }
      });

      this.socket.ev.on('messaging-history.set', (data: any) => {
        const { chats, messages, contacts } = data;
        logger.info(`Received messaging history sync: ${chats?.length || 0} chats, ${messages?.length || 0} messages, ${contacts?.length || 0} contacts`);
        if (contacts && Array.isArray(contacts)) {
          for (const contact of contacts) {
            if (contact.id && contact.id !== '0@s.whatsapp.net') {
              this.stateManager.addOrUpdateContact(contact);
            }
          }
          if (contacts.length > 0) {
            this.contactsReceived = true;
          }
        }
        if (chats && Array.isArray(chats)) {
          for (const c of chats) {
            const jid = normalizeJid(c.id);
            if (jid === '0@s.whatsapp.net' || jid === 'status@broadcast') continue;
            if (c.name || c.notify) {
              this.stateManager.addOrUpdateContact({ id: c.id, name: c.name, notify: c.notify });
            }
            const ts = c.conversationTimestamp
              ? (typeof c.conversationTimestamp === 'number' ? c.conversationTimestamp : Number(c.conversationTimestamp))
              : Math.floor(Date.now() / 1000);
            const chatObj = buildNormalizedChat(
              jid,
              c.name || c.notify || jid,
              '',
              ts,
              c.unreadCount || 0
            );
            this.stateManager.addOrUpdateChat(chatObj);
          }
        }
        if (messages && Array.isArray(messages)) {
          for (const msg of messages) {
            if (msg.key?.remoteJid) {
              const msgJid = normalizeJid(msg.key.remoteJid);
              if (msgJid === '0@s.whatsapp.net' || msgJid === 'status@broadcast') continue;
            }
            if (msg.pushName && msg.key?.remoteJid) {
              this.stateManager.addOrUpdateContact({ id: msg.key.remoteJid, notify: msg.pushName });
            }
            const normalized = normalizeMessage(msg);
            if (normalized) {
              this.stateManager.addMessage(normalized);
            }
          }
        }

        // History sync received — complete only if contacts arrived, otherwise defer
        this.historySyncReceived = true;
        this.completeSync();
      });

      this.socket.ev.on('chats.upsert', (chats: any[]) => {
        logger.info(`Received chats upsert: ${chats?.length || 0} chats`);
        for (const c of chats) {
          const jid = normalizeJid(c.id);
          if (jid === '0@s.whatsapp.net' || jid === 'status@broadcast') continue;
          if (c.name || c.notify) {
            this.stateManager.addOrUpdateContact({ id: c.id, name: c.name, notify: c.notify });
          }
          const existing = this.stateManager.getUnreadChats().find((x) => x.id === jid);
          const ts = c.conversationTimestamp
            ? (typeof c.conversationTimestamp === 'number' ? c.conversationTimestamp : Number(c.conversationTimestamp))
            : (existing?.timestamp || Math.floor(Date.now() / 1000));
          const chatObj = buildNormalizedChat(
            jid,
            c.name || c.notify || existing?.name || jid,
            existing?.lastMessage || '',
            ts,
            c.unreadCount !== undefined ? c.unreadCount : (existing?.unreadCount || 0)
          );
          this.stateManager.addOrUpdateChat(chatObj);
        }
      });

      this.socket.ev.on('chats.update', (updates: any[]) => {
        logger.info(`Received chats update: ${updates?.length || 0} chats`);
        for (const u of updates) {
          const jid = normalizeJid(u.id);
          if (jid === '0@s.whatsapp.net' || jid === 'status@broadcast') continue;
          if (u.name || u.notify) {
            this.stateManager.addOrUpdateContact({ id: u.id, name: u.name, notify: u.notify });
          }
          const existing = this.stateManager.getUnreadChats().find((x) => x.id === jid);
          if (existing) {
            const unread = u.unreadCount !== undefined ? u.unreadCount : (u.read ? 0 : existing.unreadCount);
            this.stateManager.addOrUpdateChat({
              ...existing,
              unreadCount: unread >= 0 ? unread : 0,
            });
          }
        }
      });

      this.socket.ev.on('contacts.upsert', (contacts: any[]) => {
        logger.info(`Received contacts upsert: ${contacts?.length || 0} contacts`);
        for (const contact of contacts) {
          if (contact.id && contact.id !== '0@s.whatsapp.net') {
            this.stateManager.addOrUpdateContact(contact);
          }
        }
        if (contacts.length > 0) {
          this.contactsReceived = true;
          this.completeSync();
        }
      });

      this.socket.ev.on('contacts.update', (updates: any[]) => {
        logger.info(`Received contacts update: ${updates?.length || 0} contacts`);
        for (const update of updates) {
          if (update.id && update.id !== '0@s.whatsapp.net') {
            this.stateManager.addOrUpdateContact(update);
          }
        }
      });

      this.socket.ev.on('messages.update', (updates: any[]) => {
        for (const u of updates) {
          const key = u.key;
          if (!key || !key.remoteJid) continue;
          const chatJid = normalizeJid(key.remoteJid);
          if (chatJid === '0@s.whatsapp.net' || chatJid === 'status@broadcast') continue;

          const statusNum = u.update?.status;
          if (statusNum === undefined || statusNum === null) continue;

          let statusStr: string;
          switch (statusNum) {
            case WAMessageStatus.PENDING: statusStr = 'pending'; break;
            case WAMessageStatus.SERVER_ACK: statusStr = 'sent'; break;
            case WAMessageStatus.DELIVERY_ACK: statusStr = 'delivered'; break;
            case WAMessageStatus.READ: statusStr = 'read'; break;
            case WAMessageStatus.PLAYED: statusStr = 'read'; break;
            case WAMessageStatus.ERROR: statusStr = 'error'; break;
            default: statusStr = 'sent'; break;
          }

          logger.info(`[messages.update] chatJid=${chatJid} msgId=${key.id} status=${statusStr} (raw=${statusNum})`);
          this.stateManager.updateMessageStatus(chatJid, key.id!, statusStr);
        }
      });

      this.socket.ev.on('message-receipt.update', (updates: any[]) => {
        for (const u of updates) {
          const key = u.key;
          if (!key || !key.remoteJid) continue;
          const chatJid = normalizeJid(key.remoteJid);
          if (chatJid === '0@s.whatsapp.net' || chatJid === 'status@broadcast') continue;

          const receipt = u.receipt;
          if (!receipt) continue;

          let statusStr: string | null = null;
          if (receipt.readTimestamp) statusStr = 'read';
          else if (receipt.receiptTimestamp) statusStr = 'delivered';

          if (statusStr) {
            logger.info(`[message-receipt.update] chatJid=${chatJid} msgId=${key.id} status=${statusStr}`);
            this.stateManager.updateMessageStatus(chatJid, key.id!, statusStr);
          }
        }
      });
    } catch (err) {
      this.isConnecting = false;
      logger.error({ err }, 'Error creating WhatsApp socket');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(customDelay?: number): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = customDelay !== undefined
      ? customDelay
      : Math.min(Math.pow(2, this.reconnectAttempts) * 1000, 60000);

    logger.info(`Scheduling reconnect attempt #${this.reconnectAttempts} in ${delay / 1000}s`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  public formatJid(recipient: string): string {
    const canonical = this.stateManager.getCanonicalJid(recipient);
    return normalizeJid(canonical || recipient);
  }

  public async sendMessage(
    recipient: string,
    messageText: string,
    replyToMessageId?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.socket || this.stateManager.getStatusEvent().status !== 'connected') {
      return { success: false, error: 'Daemon is offline or not connected to WhatsApp' };
    }

    try {
      const jid = this.formatJid(recipient);
      let options: any = {};

      if (replyToMessageId) {
        const targetMsg = this.stateManager.findMessageById(replyToMessageId);
        if (!targetMsg) {
          logger.warn({ replyToMessageId, recipient }, 'Failed to resolve referenced message for reply');
          return {
            success: false,
            error: `Cannot reply: referenced message '${replyToMessageId}' was not found in message history`,
          };
        }

        const isGrp = jid.endsWith('@g.us');
        const quotedKey: any = {
          remoteJid: jid,
          fromMe: !!targetMsg.fromMe,
          id: targetMsg.id,
        };

        if (isGrp && targetMsg.participant) {
          quotedKey.participant = targetMsg.participant;
        }

        let quotedMessage: any;
        if (targetMsg.rawMessage) {
          quotedMessage = targetMsg.rawMessage;
        } else {
          quotedMessage = {
            conversation: targetMsg.text || 'Message',
          };
        }

        options.quoted = {
          key: quotedKey,
          message: quotedMessage,
        };
      }

      const result = await this.socket.sendMessage(jid, { text: messageText }, options);

      if (result) {
        const normalized = normalizeMessage(result);
        if (normalized) {
          this.stateManager.addMessage(normalized);
        }
      }

      return { success: true };
    } catch (err: any) {
      logger.error({ err, recipient }, 'Failed to send WhatsApp message');
      return { success: false, error: err.message || 'Send message failed' };
    }
  }

  public async markRead(chatId: string): Promise<{ success: boolean; error?: string }> {
    const jid = this.formatJid(chatId);
    if (!this.socket || this.stateManager.getStatusEvent().status !== 'connected') {
      // Even if disconnected from WhatsApp server, update local state
      this.stateManager.markChatAsRead(jid);
      return { success: true };
    }

    try {
      const history = this.stateManager.getChatHistory(jid);

      if (history.length > 0) {
        const lastMsg = history[history.length - 1];
        await this.socket.readMessages([
          {
            remoteJid: jid,
            id: lastMsg.id,
            fromMe: lastMsg.fromMe,
          },
        ]);
      }

      this.stateManager.markChatAsRead(jid);
      return { success: true };
    } catch (err: any) {
      logger.error({ err, chatId }, 'Failed to mark messages as read');
      this.stateManager.markChatAsRead(jid);
      return { success: true };
    }
  }

  public async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupSocket();
  }
}
