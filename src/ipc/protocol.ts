import { WidgetRequest, DaemonEvent } from './types.js';

export function parseIPCMessage(rawMessage: string): WidgetRequest | null {
  try {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || !parsed.action) {
      return null;
    }
    return parsed as WidgetRequest;
  } catch {
    return null;
  }
}

export function serializeIPCMessage(event: DaemonEvent): string {
  return JSON.stringify(event) + '\n';
}
