import assert from 'node:assert';
import { test, describe } from 'node:test';
import { StateManager } from '../src/store/state-manager.js';

describe('Chat Identity Normalization & Merging', () => {
  test('Alice Johnson + 15551234567 → one chat entity', () => {
    const stateManager = new StateManager(null);

    // 1. Add chat entry under LID / Contact Name "Alice Johnson"
    stateManager.addOrUpdateChat({
      id: '10000000001@s.whatsapp.net',
      name: 'Alice Johnson',
      lastMessage: 'Message from LID stream',
      time: '06:01 AM',
      unreadCount: 1,
      avatarIcon: 'person',
      timestamp: 1787446800,
    });

    // 2. Add message under Phone JID 15551234567@s.whatsapp.net
    stateManager.addMessage({
      id: 'MSG_001',
      chatId: '15551234567@s.whatsapp.net',
      sender: 'Alice Johnson',
      fromMe: false,
      text: 'Message from Phone JID stream',
      time: '06:02 AM',
      timestamp: 1787446860,
    });

    // Register identity mapping (LID & Name -> Canonical Phone JID)
    stateManager.registerLidOrAliasMapping('10000000001@s.whatsapp.net', '15551234567@s.whatsapp.net');
    stateManager.registerLidOrAliasMapping('Alice Johnson', '15551234567@s.whatsapp.net');

    // 3. Query recent chats
    const recentChats = stateManager.getRecentChats();

    // PROVE: Exactly 1 chat entity returned
    assert.strictEqual(recentChats.length, 1, `Expected exactly 1 chat entity, got ${recentChats.length}`);

    const canonicalChat = recentChats[0];

    // PROVE: Canonical JID identity
    assert.strictEqual(canonicalChat.id, '15551234567@s.whatsapp.net');

    // PROVE: Preserves best available display name ("Alice Johnson")
    assert.strictEqual(canonicalChat.name, 'Alice Johnson');

    // PROVE: Preserves latest message text and timestamp
    assert.strictEqual(canonicalChat.lastMessage, 'Message from Phone JID stream');
    assert.strictEqual(canonicalChat.timestamp, 1787446860);

    // PROVE: Unified message history under canonical JID
    const history = stateManager.getChatHistory('15551234567@s.whatsapp.net');
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].chatId, '15551234567@s.whatsapp.net');

    // PROVE: Querying history via alias LID returns the exact same canonical history
    const historyViaLid = stateManager.getChatHistory('10000000001@s.whatsapp.net');
    assert.strictEqual(historyViaLid.length, 1);
    assert.strictEqual(historyViaLid[0].chatId, '15551234567@s.whatsapp.net');

    console.log('✓ REGRESSION TEST PASSED: Alice Johnson + 15551234567 → 1 canonical chat entity!');
  });
});
