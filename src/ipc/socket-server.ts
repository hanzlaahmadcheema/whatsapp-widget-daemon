import net from 'net';
import fs from 'fs';
import path from 'path';
import { daemonConfig } from '../config.js';
import { parseIPCMessage, serializeIPCMessage } from './protocol.js';
import { DaemonEvent, ResponseMessage } from './types.js';
import { StateManager } from '../store/state-manager.js';
import { WhatsAppClient } from '../whatsapp/client.js';
import { logger } from '../utils/logger.js';

export class SocketServer {
  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();
  private stateManager: StateManager;
  private waClient: WhatsAppClient;

  constructor(stateManager: StateManager, waClient: WhatsAppClient) {
    this.stateManager = stateManager;
    this.waClient = waClient;
    this.setupStateListeners();
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketPath = daemonConfig.socketPath;

      // Remove existing socket file if orphaned
      if (fs.existsSync(socketPath)) {
        try {
          fs.unlinkSync(socketPath);
        } catch (err) {
          logger.warn({ err }, `Could not remove existing socket file at ${socketPath}`);
        }
      }

      // Ensure directory exists
      const socketDir = path.dirname(socketPath);
      if (!fs.existsSync(socketDir)) {
        fs.mkdirSync(socketDir, { recursive: true });
      }

      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.on('error', (err) => {
        logger.error({ err }, 'IPC Socket server error');
        reject(err);
      });

      this.server.listen(socketPath, () => {
        logger.info(`IPC Socket server listening on ${socketPath}`);
        // Ensure proper socket permissions (user read/write only)
        try {
          fs.chmodSync(socketPath, '0700');
        } catch {}
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    logger.info('New IPC client connected');
    this.clients.add(socket);

    // Send current status, unread state, and recent chats immediately to new client
    this.sendToSocket(socket, this.stateManager.getStatusEvent());
    this.sendToSocket(socket, this.stateManager.getUnreadChatsEvent());
    this.sendToSocket(socket, this.stateManager.getRecentChatsEvent());

    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf-8');
      let lineIndex: number;
      while ((lineIndex = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, lineIndex);
        buffer = buffer.slice(lineIndex + 1);

        const request = parseIPCMessage(rawLine);
        if (request) {
          await this.handleRequest(socket, request);
        }
      }
    });

    socket.on('close', () => {
      logger.info('IPC client disconnected');
      this.clients.delete(socket);
    });

    socket.on('error', (err) => {
      logger.warn({ err }, 'IPC client socket error');
      this.clients.delete(socket);
    });
  }

  private async handleRequest(socket: net.Socket, req: any): Promise<void> {
    const reqId = req.id;
    const action = req.action;

    switch (action) {
      case 'get_status': {
        const statusEvt = this.stateManager.getStatusEvent();
        this.sendToSocket(socket, statusEvt);
        const sessionExists = fs.existsSync(path.join(daemonConfig.sessionDir, 'creds.json'));
        this.sendResponse(socket, reqId, action, true, null, {
          ...statusEvt,
          sessionExists,
          unreadCount: this.stateManager.getUnreadChats().length,
          recentChatsCount: this.stateManager.getRecentChats().length,
        });
        break;
      }

      case 'get_unread_chats': {
        this.sendToSocket(socket, this.stateManager.getUnreadChatsEvent());
        this.sendResponse(socket, reqId, action, true);
        break;
      }

      case 'get_recent_chats': {
        const limit = req.limit || 25;
        const chats = this.stateManager.getRecentChats(limit);
        this.sendToSocket(socket, {
          event: 'recent_chats_updated',
          chats: chats,
        });
        this.sendResponse(socket, reqId, action, true, null, { chats });
        break;
      }

      case 'get_chat_history': {
        const chatId = req.chatId;
        if (!chatId) {
          this.sendResponse(socket, reqId, action, false, 'Missing chatId parameter');
          return;
        }
        const limit = req.limit || 25;
        const messages = this.stateManager.getChatHistory(chatId, limit);
        this.sendToSocket(socket, {
          event: 'chat_history_updated',
          chatId: chatId,
          messages: messages,
        });
        this.sendResponse(socket, reqId, action, true, null, { messages });
        break;
      }

      case 'send_message': {
        const { recipient, message, replyToMessageId } = req;
        if (!recipient || !message) {
          this.sendResponse(socket, reqId, action, false, 'Missing recipient or message text');
          return;
        }
        const result = await this.waClient.sendMessage(recipient, message, replyToMessageId);
        this.sendResponse(socket, reqId, action, result.success, result.error);
        break;
      }

      case 'mark_read': {
        const { chatId } = req;
        if (!chatId) {
          this.sendResponse(socket, reqId, action, false, 'Missing chatId parameter');
          return;
        }
        const result = await this.waClient.markRead(chatId);
        this.sendResponse(socket, reqId, action, result.success, result.error);
        break;
      }

      case 'set_contacts': {
        const { contacts } = req;
        if (!contacts || !Array.isArray(contacts)) {
          this.sendResponse(socket, reqId, action, false, 'Missing contacts array');
          return;
        }
        for (const c of contacts) {
          if (c && c.id && c.name) {
            this.stateManager.addOrUpdateContact({ id: c.id, name: c.name, notify: c.notify });
          }
        }
        this.sendResponse(socket, reqId, action, true);
        break;
      }

      case 'sync_config': {
        if (req.config) {
          this.stateManager.updateConfig(req.config);
          this.sendResponse(socket, reqId, action, true);
        } else {
          this.sendResponse(socket, reqId, action, false, 'Missing config object');
        }
        break;
      }

      default: {
        this.sendResponse(socket, reqId, action, false, `Unknown action: ${action}`);
        break;
      }
    }
  }

  private sendResponse(
    socket: net.Socket,
    id: string | undefined,
    action: string,
    success: boolean,
    error?: string | null,
    data?: any
  ): void {
    const res: ResponseMessage = {
      type: 'response',
      id: id,
      action: action,
      success: success,
      error: error || null,
      data: data,
    };
    this.sendToSocket(socket, res);
  }

  private sendToSocket(socket: net.Socket, event: DaemonEvent): void {
    try {
      if (!socket.destroyed) {
        socket.write(serializeIPCMessage(event));
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to write to client IPC socket');
    }
  }

  public broadcast(event: DaemonEvent): void {
    const serialized = serializeIPCMessage(event);
    for (const client of this.clients) {
      try {
        if (!client.destroyed) {
          client.write(serialized);
        }
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private setupStateListeners(): void {
    this.stateManager.on('status_changed', (evt) => this.broadcast(evt));
    this.stateManager.on('unread_chats_updated', (evt) => this.broadcast(evt));
    this.stateManager.on('recent_chats_updated', (evt) => this.broadcast(evt));
    this.stateManager.on('chat_history_updated', (evt) => this.broadcast(evt));
    this.stateManager.on('message_received', (evt) => this.broadcast(evt));
    this.stateManager.on('message_status_updated', (evt) => this.broadcast(evt));
    this.stateManager.on('chat_updated', (evt) => this.broadcast(evt));
    this.stateManager.on('read_state_updated', (evt) => this.broadcast(evt));
  }

  public close(): Promise<void> {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        try {
          client.destroy();
        } catch {}
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          logger.info('IPC Socket server closed');
          const socketPath = daemonConfig.socketPath;
          if (fs.existsSync(socketPath)) {
            try {
              fs.unlinkSync(socketPath);
            } catch {}
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
