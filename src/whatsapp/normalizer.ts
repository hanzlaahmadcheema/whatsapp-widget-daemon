import { WAMessage, isJidGroup } from '@whiskeysockets/baileys';
import { NormalizedChat, NormalizedMessage } from '../ipc/types.js';
import { formatTimestamp } from '../utils/time.js';

export function normalizeJid(jid: string): string {
  if (!jid) return '';
  const clean = jid.trim();
  if (clean.endsWith('@g.us')) {
    return clean;
  }
  const base = clean.split(':')[0];
  if (base.endsWith('@lid') || clean.endsWith('@lid')) {
    const lidBase = base.endsWith('@lid') ? base : base + '@lid';
    return lidBase;
  }
  if (base.endsWith('@c.us') || clean.endsWith('@c.us')) {
    const num = base.replace(/\D/g, '');
    return num ? `${num}@s.whatsapp.net` : clean;
  }
  if (base.endsWith('@s.whatsapp.net') || clean.endsWith('@s.whatsapp.net')) {
    const num = base.replace(/\D/g, '');
    return num ? `${num}@s.whatsapp.net` : clean;
  }
  const digits = clean.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : clean;
}

export function extractMessageText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return '';

  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : '📷 Photo';
  if (m.videoMessage) return m.videoMessage.caption ? `🎥 ${m.videoMessage.caption}` : '🎥 Video';
  if (m.audioMessage) return '🎵 Voice message';
  if (m.documentMessage) return `📄 ${m.documentMessage.fileName || 'Document'}`;
  if (m.stickerMessage) return '🎨 Sticker';
  if (m.contactMessage) return `👤 ${m.contactMessage.displayName || 'Contact'}`;
  if (m.locationMessage) return '📍 Location';
  if (m.reactionMessage) return `Reaction: ${m.reactionMessage.text || ''}`;
  if (m.ephemeralMessage?.message) return extractMessageText({ ...msg, message: m.ephemeralMessage.message } as WAMessage);
  if (m.viewOnceMessage?.message) return extractMessageText({ ...msg, message: m.viewOnceMessage.message } as WAMessage);
  if (m.viewOnceMessageV2?.message) return extractMessageText({ ...msg, message: m.viewOnceMessageV2.message } as WAMessage);
  if (m.protocolMessage) return '';
  if (m.senderKeyDistributionMessage) return '';

  return 'Message';
}

export function normalizeJidToPhoneOrId(jid: string): string {
  if (!jid) return '';
  const clean = jid.split('@')[0].split(':')[0];
  return clean;
}

export function normalizeMessage(msg: WAMessage, fallbackSenderName?: string): NormalizedMessage | null {
  const key = msg.key;
  if (!key || !key.remoteJid) return null;

  const chatId = normalizeJid(key.remoteJid);
  const timestamp = typeof msg.messageTimestamp === 'number'
    ? msg.messageTimestamp
    : typeof msg.messageTimestamp === 'object' && msg.messageTimestamp !== null && 'low' in msg.messageTimestamp
    ? (msg.messageTimestamp as any).low
    : Math.floor(Date.now() / 1000);

  const text = extractMessageText(msg);
  const fromMe = !!key.fromMe;

  if (!text && !fromMe) return null;

  const senderName = fromMe ? 'You' : msg.pushName || fallbackSenderName || normalizeJidToPhoneOrId(key.participant || chatId);

  const replyToId = msg.message?.extendedTextMessage?.contextInfo?.stanzaId || undefined;

  return {
    id: key.id || `${timestamp}_${Math.random()}`,
    chatId: chatId,
    sender: senderName,
    fromMe: fromMe,
    text: text,
    time: formatTimestamp(timestamp),
    timestamp: timestamp,
    status: fromMe ? 'sent' as const : undefined,
    replyToMessageId: replyToId,
    participant: key.participant || undefined,
    rawMessage: msg.message || undefined,
  };
}

export function buildNormalizedChat(
  chatId: string,
  chatName: string,
  lastMessageText: string,
  timestamp: number,
  unreadCount: number
): NormalizedChat {
  const normalizedChatId = normalizeJid(chatId);
  let name = chatName;

  // Only accept actually meaningful names — never generate phone numbers here.
  // display-name resolution is exclusively handled by StateManager.selectBestDisplayName().
  const isMeaningful = name
    && name !== 'You'
    && name !== normalizedChatId
    && !name.includes('@s.whatsapp.net')
    && !name.includes('@c.us')
    && !name.includes('@g.us')
    && !name.includes('@lid');

  return {
    id: normalizedChatId,
    name: isMeaningful ? name : '',
    lastMessage: lastMessageText,
    time: formatTimestamp(timestamp),
    unreadCount: unreadCount,
    avatarIcon: isJidGroup(normalizedChatId) ? 'group' : 'person',
    timestamp: timestamp,
  };
}
