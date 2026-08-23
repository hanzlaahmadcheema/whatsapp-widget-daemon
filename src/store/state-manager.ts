import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import {
  NormalizedChat,
  NormalizedMessage,
  ConnectionStatus,
  SyncState,
  StatusChangedEvent,
  UnreadChatsUpdatedEvent,
  RecentChatsUpdatedEvent,
  ChatHistoryUpdatedEvent,
} from '../ipc/types.js';
import { daemonConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { normalizeJid, normalizeJidToPhoneOrId } from '../whatsapp/normalizer.js';

export interface ContactMetadata {
  id: string;
  contactName?: string;
  pushName?: string;
  verifiedName?: string;
}

interface PersistedState {
  unreadChats: Record<string, NormalizedChat>;
  messageHistory: Record<string, NormalizedMessage[]>;
  aliasMap?: Record<string, string>;
  contactsMap?: Record<string, ContactMetadata>;
  config: {
    maxUnreadChats: number;
    maxMessageHistory: number;
    autoMarkAsRead: boolean;
  };
}

export class StateManager extends EventEmitter {
  private configured: boolean = false;
  private connected: boolean = false;
  private status: ConnectionStatus = 'unconfigured';
  private syncState: SyncState = 'idle';
  private lastConnectedAt: number | null = null;
  private qrCode: string | null = null;

  private unreadChats: Map<string, NormalizedChat> = new Map();
  private messageHistory: Map<string, NormalizedMessage[]> = new Map();
  private aliasToCanonicalMap: Map<string, string> = new Map();
  private contactsMap: Map<string, ContactMetadata> = new Map();

  private maxUnreadChats: number = daemonConfig.defaultMaxUnreadChats;
  private maxMessageHistory: number = daemonConfig.defaultMaxMessageHistory;
  private autoMarkAsRead: boolean = false;
  private myJid: string = '';
  private myNumber: string = '';

  private customStateFile: string | null | false = undefined as any;

  constructor(stateFileOverride?: string | null | false) {
    super();
    if (stateFileOverride !== undefined) {
      this.customStateFile = stateFileOverride;
    }
    if (this.customStateFile !== null && this.customStateFile !== false) {
      this.loadPersistedState();
    }
  }

  private getStateFilePath(): string | null {
    if (this.customStateFile === null || this.customStateFile === false) return null;
    return this.customStateFile || daemonConfig.stateFile;
  }

  public getStatusEvent(): StatusChangedEvent {
    return {
      event: 'status_changed',
      daemonConfigured: this.configured,
      daemonConnected: this.connected,
      configured: this.configured,
      connected: this.connected,
      status: this.status,
      syncState: this.syncState,
      lastConnectedAt: this.lastConnectedAt,
      qr: this.qrCode,
    };
  }

  public setConnectionState(
    configured: boolean,
    connected: boolean,
    status: ConnectionStatus,
    syncState: SyncState = 'idle',
    qr: string | null = null
  ): void {
    if (connected && !this.connected) {
      this.lastConnectedAt = Date.now();
    }

    const changed =
      this.configured !== configured ||
      this.connected !== connected ||
      this.status !== status ||
      this.syncState !== syncState ||
      this.qrCode !== qr;

    this.configured = configured;
    this.connected = connected;
    this.status = status;
    this.syncState = syncState;
    this.qrCode = qr;

    if (changed) {
      this.emit('status_changed', this.getStatusEvent());
    }
  }

  public setSyncState(syncState: SyncState): void {
    if (this.syncState !== syncState) {
      this.syncState = syncState;
      if (this.connected && syncState === 'syncing') {
        this.status = 'syncing';
      } else if (this.connected && syncState === 'completed') {
        this.status = 'connected';
      }
      this.emit('status_changed', this.getStatusEvent());
    }
  }

  public updateConfig(config: {
    maxUnreadChats?: number;
    maxMessageHistory?: number;
    autoMarkAsRead?: boolean;
  }): void {
    if (config.maxUnreadChats !== undefined && config.maxUnreadChats > 0) {
      this.maxUnreadChats = config.maxUnreadChats;
    }
    if (config.maxMessageHistory !== undefined && config.maxMessageHistory > 0) {
      this.maxMessageHistory = config.maxMessageHistory;
    }
    if (config.autoMarkAsRead !== undefined) {
      this.autoMarkAsRead = config.autoMarkAsRead;
    }
    this.pruneHistory();
    this.savePersistedState();
    this.emitChatsUpdated();
  }

  public registerLidOrAliasMapping(aliasOrLidOrName: string, canonicalJid: string): void {
    if (!aliasOrLidOrName || !canonicalJid) return;
    const cleanCanonical = normalizeJid(canonicalJid);
    const cleanAlias = normalizeJid(aliasOrLidOrName);

    if (cleanCanonical) {
      const oldTarget = (cleanAlias && this.aliasToCanonicalMap.get(cleanAlias)) || cleanAlias;

      if (cleanAlias && cleanAlias !== cleanCanonical) {
        this.aliasToCanonicalMap.set(cleanAlias, cleanCanonical);
        this.aliasToCanonicalMap.set(cleanAlias.toLowerCase(), cleanCanonical);
      }
      const rawAlias = aliasOrLidOrName.trim();
      if (rawAlias && !rawAlias.includes('@')) {
        this.aliasToCanonicalMap.set(rawAlias.toLowerCase(), cleanCanonical);
      }

      if (oldTarget && oldTarget !== cleanCanonical) {
        for (const [k, v] of this.aliasToCanonicalMap.entries()) {
          if (v === oldTarget) {
            this.aliasToCanonicalMap.set(k, cleanCanonical);
          }
        }
      }

      // When a LID→phone mapping is newly established, copy any existing contact
      // metadata from the LID key to the phone JID so chat name resolution works.
      if (cleanAlias.endsWith('@lid') && cleanCanonical.endsWith('@s.whatsapp.net') && !cleanCanonical.includes('@lid')) {
        const lidMeta = this.contactsMap.get(cleanAlias);
        if (lidMeta) {
          const phoneExisting = this.contactsMap.get(cleanCanonical) || { id: cleanCanonical };
          this.contactsMap.set(cleanCanonical, {
            id: cleanCanonical,
            contactName: lidMeta.contactName || phoneExisting.contactName,
            pushName: lidMeta.pushName || phoneExisting.pushName,
            verifiedName: lidMeta.verifiedName || phoneExisting.verifiedName,
          });
        }
      }

      this.deduplicateAndMergeChats();
    }
  }

  public getCanonicalJid(rawInput: string, associatedName?: string): string {
    if (!rawInput) return '';
    const clean = rawInput.trim();

    // 1. Direct mapping check by exact alias / JID / LID
    if (this.aliasToCanonicalMap.has(clean)) {
      return this.aliasToCanonicalMap.get(clean)!;
    }
    const lower = clean.toLowerCase();
    if (this.aliasToCanonicalMap.has(lower)) {
      return this.aliasToCanonicalMap.get(lower)!;
    }

    const norm = normalizeJid(clean);
    if (this.aliasToCanonicalMap.has(norm)) {
      return this.aliasToCanonicalMap.get(norm)!;
    }
    const lowerNorm = norm.toLowerCase();
    if (this.aliasToCanonicalMap.has(lowerNorm)) {
      return this.aliasToCanonicalMap.get(lowerNorm)!;
    }

    // 2. Check associated display name mapping
    if (associatedName && !associatedName.startsWith('+') && associatedName !== 'Message Yourself' && !associatedName.includes('@')) {
      const nameKey = associatedName.trim().toLowerCase();
      if (this.aliasToCanonicalMap.has(nameKey)) {
        const canonical = this.aliasToCanonicalMap.get(nameKey)!;
        this.aliasToCanonicalMap.set(norm, canonical);
        this.aliasToCanonicalMap.set(lower, canonical);
        return canonical;
      }
    }

    // 3. Search existing chats in unreadChats for matching display name or phone number
    const targetNameKey = associatedName ? associatedName.trim().toLowerCase() : (clean.includes('@') ? '' : lower);

    for (const [existingJid, existingChat] of this.unreadChats.entries()) {
      if (existingJid.endsWith('@s.whatsapp.net') && !existingJid.includes('@lid')) {
        const existingNameKey = existingChat.name ? existingChat.name.trim().toLowerCase() : '';
        const rawNum = normalizeJidToPhoneOrId(existingJid);

        if (
          (targetNameKey && existingNameKey && targetNameKey === existingNameKey) ||
          (rawNum && rawNum.length >= 6 && (clean.includes(rawNum) || norm.includes(rawNum)))
        ) {
          this.aliasToCanonicalMap.set(norm, existingJid);
          this.aliasToCanonicalMap.set(lower, existingJid);
          if (targetNameKey) {
            this.aliasToCanonicalMap.set(targetNameKey, existingJid);
          }
          return existingJid;
        }
      }
    }

    // 4. Default: If norm is phone JID without @lid, it's canonical
    if (norm.endsWith('@s.whatsapp.net') && !norm.includes('@lid')) {
      return norm;
    }

    return norm;
  }

  public addOrUpdateChat(chat: NormalizedChat): void {
    const canonicalJid = this.getCanonicalJid(chat.id, chat.name);
    if (canonicalJid === '0@s.whatsapp.net' || canonicalJid === 'status@broadcast') return;
    const existing = this.unreadChats.get(canonicalJid);

    const nameToUse = this.selectBestDisplayName([chat.name, existing?.name], canonicalJid);

    const normalizedChat: NormalizedChat = {
      ...existing,
      ...chat,
      id: canonicalJid,
      name: nameToUse,
      lastMessage: chat.lastMessage || existing?.lastMessage || '',
      timestamp: chat.timestamp || existing?.timestamp || Math.floor(Date.now() / 1000),
      unreadCount: chat.unreadCount !== undefined ? chat.unreadCount : (existing?.unreadCount || 0)
    };

    // Always register name aliases (including phone numbers) for JID resolution.
    // Display-name priority is exclusively handled by selectBestDisplayName().
    if (chat.name && chat.name !== 'Message Yourself') {
      this.aliasToCanonicalMap.set(chat.name.trim().toLowerCase(), canonicalJid);
    }
    if (chat.id && chat.id !== canonicalJid) {
      this.aliasToCanonicalMap.set(normalizeJid(chat.id), canonicalJid);
    }

    this.unreadChats.set(canonicalJid, normalizedChat);
    this.deduplicateAndMergeChats();
    this.savePersistedState();

    const mergedChat = this.unreadChats.get(canonicalJid) || normalizedChat;
    this.emit('chat_updated', { event: 'chat_updated', chat: mergedChat });
    this.emitChatsUpdated();
  }

  public markChatAsRead(rawChatId: string): boolean {
    const canonicalJid = this.getCanonicalJid(rawChatId);
    const chat = this.unreadChats.get(canonicalJid);
    let updated = false;
    if (chat) {
      chat.unreadCount = 0;
      this.unreadChats.set(canonicalJid, chat);
      updated = true;
    }
    this.deduplicateAndMergeChats();
    this.savePersistedState();
    this.emit('read_state_updated', { event: 'read_state_updated', chatId: canonicalJid, unreadCount: 0 });
    this.emitChatsUpdated();
    return updated;
  }

  public addMessage(message: NormalizedMessage): void {
    const canonicalJid = this.getCanonicalJid(message.chatId, message.sender !== 'You' ? message.sender : undefined);
    if (canonicalJid === '0@s.whatsapp.net' || canonicalJid === 'status@broadcast') return;
    const normalizedMsg = { ...message, chatId: canonicalJid };

    if (normalizedMsg.sender && normalizedMsg.sender !== 'You' && !normalizedMsg.sender.includes('@')) {
      this.aliasToCanonicalMap.set(normalizedMsg.sender.trim().toLowerCase(), canonicalJid);
    }

    const history = this.messageHistory.get(canonicalJid) || [];
    const exists = history.some((m) => m.id === normalizedMsg.id);
    if (!exists) {
      history.push(normalizedMsg);
      history.sort((a, b) => a.timestamp - b.timestamp);
      if (history.length > this.maxMessageHistory) {
        history.splice(0, history.length - this.maxMessageHistory);
      }
      this.messageHistory.set(canonicalJid, history);
    }

    const latestMsg = history[history.length - 1] || normalizedMsg;
    const existingChat = this.unreadChats.get(canonicalJid);
    const isGrp = canonicalJid.endsWith('@g.us');

    const nameToUse = this.selectBestDisplayName(
      [existingChat?.name, normalizedMsg.sender !== 'You' ? normalizedMsg.sender : undefined],
      canonicalJid
    );

    const updatedChat: NormalizedChat = {
      id: canonicalJid,
      name: nameToUse,
      lastMessage: latestMsg.text || existingChat?.lastMessage || '',
      time: latestMsg.time || existingChat?.time || '',
      unreadCount: existingChat ? existingChat.unreadCount : 0,
      avatarIcon: isGrp ? 'group' : 'person',
      timestamp: latestMsg.timestamp || existingChat?.timestamp || Math.floor(Date.now() / 1000),
    };
    this.unreadChats.set(canonicalJid, updatedChat);

    this.deduplicateAndMergeChats();
    this.savePersistedState();

    if (!exists) {
      this.emit('message_received', {
        event: 'message_received',
        message: normalizedMsg,
      });

      this.emit('chat_history_updated', {
        event: 'chat_history_updated',
        chatId: canonicalJid,
        messages: this.messageHistory.get(canonicalJid) || history,
      } as ChatHistoryUpdatedEvent);
    }

    const mergedChat = this.unreadChats.get(canonicalJid) || updatedChat;
    this.emit('chat_updated', { event: 'chat_updated', chat: mergedChat });
    this.emitChatsUpdated();
  }

  public updateMessageStatus(chatId: string, messageId: string, status: string): void {
    const canonicalJid = this.getCanonicalJid(chatId);
    const history = this.messageHistory.get(canonicalJid);
    if (!history) {
      logger.info(`[updateMessageStatus] No history for canonicalJid=${canonicalJid} (original=${chatId})`);
      return;
    }

    const msg = history.find((m) => m.id === messageId);
    if (!msg) {
      logger.info(`[updateMessageStatus] No message found id=${messageId} in history of ${canonicalJid} (${history.length} msgs)`);
      return;
    }

    const statusPriority: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, error: -1 };
    const current = statusPriority[msg.status || 'sent'] ?? 1;
    const incoming = statusPriority[status] ?? 1;
    if (incoming <= current) {
      logger.info(`[updateMessageStatus] Skipped: ${msg.status} -> ${status} (not progressing) msgId=${messageId}`);
      return;
    }

    logger.info(`[updateMessageStatus] ${msg.status} -> ${status} msgId=${messageId} chatId=${canonicalJid}`);
    msg.status = status as any;
    this.messageHistory.set(canonicalJid, history);
    this.savePersistedState();

    this.emit('message_status_updated', {
      event: 'message_status_updated',
      chatId: canonicalJid,
      messageId,
      status: status as any,
    });
  }

  public setMyJid(jid: string): void {
    if (!jid) return;
    const cleanJid = normalizeJid(jid);
    this.myJid = cleanJid;
    this.myNumber = normalizeJidToPhoneOrId(cleanJid);

    if (this.myJid) {
      this.aliasToCanonicalMap.set(this.myJid, this.myJid);
      if (jid && jid !== this.myJid) {
        this.aliasToCanonicalMap.set(normalizeJid(jid), this.myJid);
        this.aliasToCanonicalMap.set(jid, this.myJid);
      }
    }
    if (this.myNumber) {
      this.aliasToCanonicalMap.set(`${this.myNumber}@s.whatsapp.net`, this.myJid);
      this.aliasToCanonicalMap.set(`+${this.myNumber}`, this.myJid);
    }

    const existingSelf = this.unreadChats.get(this.myJid);
    if (existingSelf) {
      this.unreadChats.set(this.myJid, {
        ...existingSelf,
        id: this.myJid,
        name: 'Message Yourself',
        avatarIcon: 'person',
      });
    }

    this.deduplicateAndMergeChats();
    this.savePersistedState();
    this.emitChatsUpdated();
  }

  public addOrUpdateContact(contact: { id: string; name?: string; notify?: string; verifiedName?: string; lid?: string }): void {
    if (!contact || !contact.id) return;
    const canonicalJid = this.getCanonicalJid(contact.id);
    const cleanJid = normalizeJid(canonicalJid || contact.id);

    if (contact.lid) {
      this.registerLidOrAliasMapping(contact.lid, cleanJid);
    }

    const existing = this.contactsMap.get(cleanJid) || { id: cleanJid };
    const updated: ContactMetadata = {
      id: cleanJid,
      contactName: contact.name || existing.contactName,
      pushName: contact.notify || existing.pushName,
      verifiedName: contact.verifiedName || existing.verifiedName,
    };
    this.contactsMap.set(cleanJid, updated);

    // Also store under the phone JID when this is a LID contact, so chats keyed
    // by phone JID can find the contact metadata during name resolution.
    if (contact.lid && cleanJid.endsWith('@lid')) {
      const phoneJid = this.aliasToCanonicalMap.get(cleanJid)
        || this.aliasToCanonicalMap.get(cleanJid.toLowerCase());
      if (phoneJid && phoneJid !== cleanJid && phoneJid.endsWith('@s.whatsapp.net') && !phoneJid.includes('@lid')) {
        const phoneExisting = this.contactsMap.get(phoneJid) || { id: phoneJid };
        this.contactsMap.set(phoneJid, {
          id: phoneJid,
          contactName: updated.contactName || phoneExisting.contactName,
          pushName: updated.pushName || phoneExisting.pushName,
          verifiedName: updated.verifiedName || phoneExisting.verifiedName,
        });
      }
    }

    if (contact.name && !contact.name.startsWith('+') && !contact.name.includes('@')) {
      this.aliasToCanonicalMap.set(contact.name.trim().toLowerCase(), cleanJid);
    }
    if (contact.notify && !contact.notify.startsWith('+') && !contact.notify.includes('@')) {
      if (!this.aliasToCanonicalMap.has(contact.notify.trim().toLowerCase())) {
        this.aliasToCanonicalMap.set(contact.notify.trim().toLowerCase(), cleanJid);
      }
    }

    const existingChat = this.unreadChats.get(cleanJid);
    if (existingChat) {
      const bestName = this.selectBestDisplayName(
        [updated.contactName, updated.pushName, updated.verifiedName, existingChat.name],
        cleanJid
      );
      if (existingChat.name !== bestName) {
        this.unreadChats.set(cleanJid, {
          ...existingChat,
          name: bestName,
        });
        this.deduplicateAndMergeChats();
        this.savePersistedState();
        this.emitChatsUpdated();
      }
    }
  }

  private formatPhoneNumber(raw: string): string {
    if (!raw) return '';
    const clean = raw.trim();
    if (clean.includes('@')) {
      const parts = clean.split('@');
      return this.formatPhoneNumber(parts[0].split(':')[0]);
    }
    const digits = clean.replace(/\D/g, '');
    if (!digits) return clean;
    return `+${digits}`;
  }

  private static isFormattedPhone(name: string): boolean {
    return /^\+\d{7,15}$/.test(name.trim());
  }

  private selectBestDisplayName(candidates: (string | undefined)[], fallbackJid: string): string {
    const canonicalJid = this.getCanonicalJid(fallbackJid);
    const cleanJid = normalizeJid(canonicalJid || fallbackJid);
    const meta = this.contactsMap.get(cleanJid);

    if (this.myJid && cleanJid === this.myJid) {
      return 'Message Yourself';
    }

    // Tier 1: Saved contact name from phone book sync
    if (meta?.contactName && meta.contactName.trim() && !StateManager.isFormattedPhone(meta.contactName) && /[a-zA-Z]/.test(meta.contactName)) {
      return meta.contactName.trim();
    }

    // Tier 2: WhatsApp push name or verified name from contactsMap
    const metaNames = [meta?.pushName, meta?.verifiedName];
    for (const c of metaNames) {
      if (!c) continue;
      const trimmed = c.trim();
      if (
        trimmed &&
        trimmed !== 'You' &&
        trimmed !== 'Message Yourself' &&
        !trimmed.includes('@s.whatsapp.net') &&
        !trimmed.includes('@g.us') &&
        !trimmed.includes('@c.us') &&
        !trimmed.includes('@lid') &&
        !StateManager.isFormattedPhone(trimmed) &&
        /[a-zA-Z]/.test(trimmed)
      ) {
        return trimmed;
      }
    }

    // Tier 3: Meaningful names from candidates (pushName, notify, existing chat name)
    // Explicitly reject formatted phone numbers — they must never shadow contact metadata.
    for (const c of candidates) {
      if (!c) continue;
      const trimmed = c.trim();
      if (
        trimmed &&
        trimmed !== 'You' &&
        trimmed !== 'Message Yourself' &&
        !trimmed.includes('@s.whatsapp.net') &&
        !trimmed.includes('@g.us') &&
        !trimmed.includes('@c.us') &&
        !trimmed.includes('@lid') &&
        !StateManager.isFormattedPhone(trimmed) &&
        /[a-zA-Z]/.test(trimmed)
      ) {
        return trimmed;
      }
    }

    // Tier 4: For LID JIDs, try to find the mapped phone JID from aliasMap
    if (cleanJid.endsWith('@lid')) {
      for (const [alias, target] of this.aliasToCanonicalMap.entries()) {
        if (target.endsWith('@s.whatsapp.net') && !target.includes('@lid')) {
          const targetMeta = this.contactsMap.get(target);
          if (targetMeta?.pushName || targetMeta?.contactName || targetMeta?.verifiedName) {
            const resolvedName = this.selectBestDisplayName([], target);
            if (resolvedName && resolvedName !== target) {
              return resolvedName;
            }
          }
        }
      }
      // No phone JID mapped yet — return empty rather than a meaningless LID-as-phone
      return '';
    }

    // Tier 5: Formatted phone number — only when no contact metadata exists at all
    const formattedFallbackPhone = this.formatPhoneNumber(cleanJid);
    if (formattedFallbackPhone && formattedFallbackPhone.startsWith('+')) {
      return formattedFallbackPhone;
    }

    // Tier 6: JID as absolute last resort
    return cleanJid;
  }

  public deduplicateAndMergeChats(): void {
    // 0. Pre-pass: Map LID / non-phone JIDs to Phone JIDs if they share display names, senders, or history
    for (const [lidKey, lidChat] of this.unreadChats.entries()) {
      const isLid = !lidKey.endsWith('@s.whatsapp.net') || lidKey.includes('@lid') || normalizeJidToPhoneOrId(lidKey).length > 14;
      if (isLid) {
        const nameCandidate = lidChat.name;
        const mappedCanonical = nameCandidate ? this.aliasToCanonicalMap.get(nameCandidate.trim().toLowerCase()) : undefined;

        if (mappedCanonical && mappedCanonical.endsWith('@s.whatsapp.net') && !mappedCanonical.includes('@lid') && normalizeJidToPhoneOrId(mappedCanonical).length <= 14) {
          const cleanMapped = normalizeJid(mappedCanonical);
          this.aliasToCanonicalMap.set(lidKey, cleanMapped);
          this.aliasToCanonicalMap.set(lidKey.toLowerCase(), cleanMapped);
        } else {
          for (const [phoneKey, phoneChat] of this.unreadChats.entries()) {
            if (this.myJid && phoneKey === this.myJid) continue;

            if (phoneKey.endsWith('@s.whatsapp.net') && !phoneKey.includes('@lid') && normalizeJidToPhoneOrId(phoneKey).length <= 14) {
              const cleanPhoneKey = normalizeJid(phoneKey);
              const phoneMsgs = this.messageHistory.get(phoneKey) || [];
              const lidMsgs = this.messageHistory.get(lidKey) || [];
              const hasMatchingSender = phoneMsgs.some(m => m.sender === nameCandidate) || lidMsgs.some(m => m.sender === phoneChat.name);
              const nameMatches = !!(nameCandidate && phoneChat.name && nameCandidate.trim().toLowerCase() === phoneChat.name.trim().toLowerCase());

              if (nameMatches || hasMatchingSender) {
                this.aliasToCanonicalMap.set(lidKey, cleanPhoneKey);
                this.aliasToCanonicalMap.set(lidKey.toLowerCase(), cleanPhoneKey);
                if (nameCandidate && !nameCandidate.startsWith('+') && !nameCandidate.includes('@')) {
                  this.aliasToCanonicalMap.set(nameCandidate.trim().toLowerCase(), cleanPhoneKey);
                }
                break;
              }
            }
          }
        }
      }
    }

    const canonicalChatGroups = new Map<string, NormalizedChat[]>();
    const canonicalHistoryGroups = new Map<string, NormalizedMessage[]>();

    // 1. Group all chats by resolved canonical JID or display name alias
    for (const [key, chat] of this.unreadChats.entries()) {
      let canonicalJid = normalizeJid(this.getCanonicalJid(chat.id || key, chat.name));
      
      if (chat.name && !chat.name.startsWith('+') && chat.name !== 'Message Yourself' && !chat.name.includes('@')) {
        const nameKey = chat.name.trim().toLowerCase();
        if (this.aliasToCanonicalMap.has(nameKey)) {
          canonicalJid = normalizeJid(this.aliasToCanonicalMap.get(nameKey)!);
        } else if (canonicalJid && !canonicalJid.includes('@lid')) {
          this.aliasToCanonicalMap.set(nameKey, canonicalJid);
        }
      }

      if (!canonicalJid) canonicalJid = normalizeJid(key);

      const group = canonicalChatGroups.get(canonicalJid) || [];
      group.push(chat);
      canonicalChatGroups.set(canonicalJid, group);
    }

    // 2. Group all message histories by resolved canonical JID
    for (const [key, msgs] of this.messageHistory.entries()) {
      let canonicalJid = normalizeJid(this.getCanonicalJid(key));
      if (!canonicalJid) canonicalJid = normalizeJid(key);

      const group = canonicalHistoryGroups.get(canonicalJid) || [];
      group.push(...msgs);
      canonicalHistoryGroups.set(canonicalJid, group);
    }

    // 3. Clear existing maps to re-build cleanly with canonical keys
    this.unreadChats.clear();
    this.messageHistory.clear();

    // 4. Merge message histories
    for (const [canonicalJid, allMsgs] of canonicalHistoryGroups.entries()) {
      const deduplicated: NormalizedMessage[] = [];
      const seenIds = new Set<string>();

      for (const m of allMsgs) {
        if (m && m.id && !seenIds.has(m.id)) {
          seenIds.add(m.id);
          deduplicated.push({
            ...m,
            chatId: canonicalJid,
          });
        }
      }

      deduplicated.sort((a, b) => a.timestamp - b.timestamp);
      const trimmedHistory = deduplicated.slice(-this.maxMessageHistory);
      this.messageHistory.set(canonicalJid, trimmedHistory);
    }

    // 5. Merge chat cards
    for (const [canonicalJid, chats] of canonicalChatGroups.entries()) {
      if (chats.length === 0) continue;

      let latestTimestamp = 0;
      let latestMessage = '';
      let latestTime = '';
      let maxUnread = 0;
      const candidateNames: (string | undefined)[] = [];

      for (const c of chats) {
        candidateNames.push(c.name);
        if ((c.unreadCount || 0) > maxUnread) {
          maxUnread = c.unreadCount;
        }
        if ((c.timestamp || 0) >= latestTimestamp) {
          latestTimestamp = c.timestamp || 0;
          latestMessage = c.lastMessage || latestMessage;
          latestTime = c.time || latestTime;
        }
      }

      // Check merged message history for latest text / timestamp if richer
      const history = this.messageHistory.get(canonicalJid);
      if (history && history.length > 0) {
        const lastHist = history[history.length - 1];
        if (lastHist.timestamp >= latestTimestamp) {
          latestTimestamp = lastHist.timestamp;
          latestMessage = lastHist.text;
          latestTime = lastHist.time;
        }
        for (const h of history) {
          if (h.sender && h.sender !== 'You' && !h.sender.includes('@')) {
            candidateNames.push(h.sender);
          }
        }
      }

      const bestName = this.selectBestDisplayName(candidateNames, canonicalJid);
      const isGrp = canonicalJid.endsWith('@g.us');

      const mergedChat: NormalizedChat = {
        id: canonicalJid,
        name: bestName,
        lastMessage: latestMessage,
        time: latestTime,
        unreadCount: maxUnread,
        avatarIcon: isGrp ? 'group' : 'person',
        timestamp: latestTimestamp,
      };

      this.unreadChats.set(canonicalJid, mergedChat);

      // Register display name alias for future lookups
      if (bestName && !bestName.startsWith('+') && bestName !== 'Message Yourself' && !bestName.includes('@')) {
        this.aliasToCanonicalMap.set(bestName.trim().toLowerCase(), canonicalJid);
      }
    }
  }

  public getRecentChats(limit?: number): NormalizedChat[] {
    this.deduplicateAndMergeChats();
    const uniqueChats = Array.from(this.unreadChats.values());
    uniqueChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const max = limit && limit > 0 ? limit : 25;
    return uniqueChats.slice(0, max);
  }

  public getRecentChatsEvent(limit?: number): RecentChatsUpdatedEvent {
    return {
      event: 'recent_chats_updated',
      chats: this.getRecentChats(limit),
    };
  }

  public getUnreadChats(): NormalizedChat[] {
    const uniqueChats = this.getRecentChats(50);
    return uniqueChats.filter((c) => c.unreadCount > 0).slice(0, this.maxUnreadChats);
  }

  public getUnreadChatsEvent(): UnreadChatsUpdatedEvent {
    return {
      event: 'unread_chats_updated',
      chats: this.getUnreadChats(),
    };
  }

  public getChatHistory(rawChatId: string, limit?: number): NormalizedMessage[] {
    const canonicalJid = this.getCanonicalJid(rawChatId);
    const history = this.messageHistory.get(canonicalJid) || [];
    const chat = this.unreadChats.get(canonicalJid);
    const resolvedName = chat?.name || this.selectBestDisplayName([], canonicalJid);

    const max = limit || this.maxMessageHistory;
    const sliced = history.slice(-max);

    return sliced.map((m) => {
      if (!m.fromMe && (!m.sender || m.sender === 'You' || m.sender.includes('@') || /^\d+$/.test(m.sender))) {
        return {
          ...m,
          sender: resolvedName,
        };
      }
      return m;
    });
  }

  public findMessageById(messageId: string): NormalizedMessage | null {
    if (!messageId) return null;
    for (const history of this.messageHistory.values()) {
      const found = history.find((m) => m && m.id === messageId);
      if (found) return found;
    }
    return null;
  }

  private emitChatsUpdated(): void {
    this.emit('unread_chats_updated', this.getUnreadChatsEvent());
    this.emit('recent_chats_updated', this.getRecentChatsEvent());
  }

  private pruneHistory(): void {
    for (const [chatId, messages] of this.messageHistory.entries()) {
      if (messages.length > this.maxMessageHistory) {
        this.messageHistory.set(chatId, messages.slice(-this.maxMessageHistory));
      }
    }
  }

  private savePersistedState(): void {
    const filePath = this.getStateFilePath();
    if (!filePath) return;
    try {
      this.deduplicateAndMergeChats();
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: PersistedState = {
        unreadChats: Object.fromEntries(this.unreadChats.entries()),
        messageHistory: Object.fromEntries(this.messageHistory.entries()),
        aliasMap: Object.fromEntries(this.aliasToCanonicalMap.entries()),
        contactsMap: Object.fromEntries(this.contactsMap.entries()),
        config: {
          maxUnreadChats: this.maxUnreadChats,
          maxMessageHistory: this.maxMessageHistory,
          autoMarkAsRead: this.autoMarkAsRead,
        },
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err }, 'Failed to persist state file');
    }
  }

  private loadPersistedState(): void {
    const filePath = this.getStateFilePath();
    if (!filePath) return;
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed: PersistedState = JSON.parse(raw);
        if (parsed.aliasMap) {
          for (const [k, v] of Object.entries(parsed.aliasMap)) {
            this.aliasToCanonicalMap.set(k, v);
          }
        }
        if (parsed.contactsMap) {
          for (const [k, v] of Object.entries(parsed.contactsMap)) {
            this.contactsMap.set(k, v);
          }
        }
        if (daemonConfig.contactsFile && fs.existsSync(daemonConfig.contactsFile)) {
          try {
            const contactsRaw = fs.readFileSync(daemonConfig.contactsFile, 'utf-8');
            const contactsList = JSON.parse(contactsRaw);
            if (Array.isArray(contactsList)) {
              for (const c of contactsList) {
                if (c && c.id && c.name) {
                  this.addOrUpdateContact({ id: c.id, name: c.name, notify: c.notify });
                }
              }
            }
          } catch (e) {}
        }
        if (parsed.unreadChats) {
          for (const [k, v] of Object.entries(parsed.unreadChats)) {
            const canonical = this.getCanonicalJid(k);
            this.unreadChats.set(canonical, { ...v, id: canonical });
          }
        }
        if (parsed.messageHistory) {
          for (const [k, v] of Object.entries(parsed.messageHistory)) {
            const canonical = this.getCanonicalJid(k);
            const msgs = v.map((m) => ({ ...m, chatId: canonical }));
            const existing = this.messageHistory.get(canonical) || [];
            this.messageHistory.set(canonical, [...existing, ...msgs]);
          }
        }
        if (parsed.config) {
          if (parsed.config.maxUnreadChats) this.maxUnreadChats = parsed.config.maxUnreadChats;
          if (parsed.config.maxMessageHistory) this.maxMessageHistory = parsed.config.maxMessageHistory;
          if (parsed.config.autoMarkAsRead !== undefined) this.autoMarkAsRead = parsed.config.autoMarkAsRead;
        }
        this.deduplicateAndMergeChats();
        logger.info('Successfully loaded persisted daemon state');
      }
    } catch (err) {
      logger.warn({ err }, 'Could not read persisted state file, starting fresh');
    }
  }
}
