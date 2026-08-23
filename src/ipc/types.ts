export type ConnectionStatus = 'unconfigured' | 'connecting' | 'authenticating' | 'syncing' | 'connected' | 'offline';
export type SyncState = 'idle' | 'syncing' | 'completed' | 'failed';

export interface NormalizedChat {
  id: string;
  name: string;
  lastMessage: string;
  time: string;
  unreadCount: number;
  avatarIcon: string;
  timestamp?: number;
}

export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'error';

export interface MessageStatusUpdatedEvent {
  event: 'message_status_updated';
  chatId: string;
  messageId: string;
  status: MessageStatus;
}

export interface NormalizedMessage {
  id: string;
  chatId: string;
  sender: string;
  fromMe: boolean;
  text: string;
  time: string;
  timestamp: number;
  status?: MessageStatus;
  replyToMessageId?: string;
  participant?: string;
  rawMessage?: any;
}

// Inbound Events (Daemon -> Widget)
export interface StatusChangedEvent {
  event: 'status_changed';
  daemonConfigured: boolean;
  daemonConnected: boolean;
  configured: boolean;
  connected: boolean;
  status: ConnectionStatus;
  syncState?: SyncState;
  lastConnectedAt?: number | null;
  qr?: string | null;
}

export interface UnreadChatsUpdatedEvent {
  event: 'unread_chats_updated';
  chats: NormalizedChat[];
}

export interface RecentChatsUpdatedEvent {
  event: 'recent_chats_updated';
  chats: NormalizedChat[];
}

export interface ChatHistoryUpdatedEvent {
  event: 'chat_history_updated';
  chatId: string;
  messages: NormalizedMessage[];
}

export interface MessageReceivedEvent {
  event: 'message_received';
  message: NormalizedMessage;
}

export interface ChatUpdatedEvent {
  event: 'chat_updated';
  chat: NormalizedChat;
}

export interface ReadStateUpdatedEvent {
  event: 'read_state_updated';
  chatId: string;
  unreadCount: number;
}

export interface ResponseMessage {
  type: 'response';
  id?: string;
  action?: string;
  success: boolean;
  error?: string | null;
  data?: any;
}

export type DaemonEvent =
  | StatusChangedEvent
  | UnreadChatsUpdatedEvent
  | RecentChatsUpdatedEvent
  | ChatHistoryUpdatedEvent
  | MessageReceivedEvent
  | MessageStatusUpdatedEvent
  | ChatUpdatedEvent
  | ReadStateUpdatedEvent
  | ResponseMessage;

// Outbound Requests (Widget -> Daemon)
export interface SendMessageRequest {
  id?: string;
  action: 'send_message';
  recipient: string;
  message: string;
  replyToMessageId?: string;
}

export interface MarkReadRequest {
  id?: string;
  action: 'mark_read';
  chatId: string;
}

export interface GetStatusRequest {
  id?: string;
  action: 'get_status';
}

export interface GetUnreadChatsRequest {
  id?: string;
  action: 'get_unread_chats';
}

export interface GetRecentChatsRequest {
  id?: string;
  action: 'get_recent_chats';
  limit?: number;
}

export interface GetChatHistoryRequest {
  id?: string;
  action: 'get_chat_history';
  chatId: string;
  limit?: number;
}

export interface SyncConfigRequest {
  id?: string;
  action: 'sync_config';
  config: {
    maxUnreadChats?: number;
    maxMessageHistory?: number;
    autoMarkAsRead?: boolean;
  };
}

export type WidgetRequest =
  | SendMessageRequest
  | MarkReadRequest
  | GetStatusRequest
  | GetUnreadChatsRequest
  | GetRecentChatsRequest
  | GetChatHistoryRequest
  | SyncConfigRequest;
