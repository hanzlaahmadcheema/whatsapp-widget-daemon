import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test, describe } from 'node:test';
import { StateManager } from '../src/store/state-manager.js';

describe('Critical Integration Test: Chat Identity & State Synchronization', () => {
  const tmpStateFile = path.join(process.cwd(), 'scratch', 'test_sync_state.json');

  test('Unified single chat & history before and after daemon restart', () => {
    if (fs.existsSync(tmpStateFile)) fs.unlinkSync(tmpStateFile);

    let stateManager = new StateManager(tmpStateFile);

    // 1. Receives a message using the phone JID
    stateManager.addMessage({
      id: 'MSG_PHONE_001',
      chatId: '15551234567@s.whatsapp.net',
      sender: 'Alice Johnson',
      fromMe: false,
      text: 'Message received via Phone JID stream',
      time: '07:30 AM',
      timestamp: 1787451000,
    });

    // 2. Receives another update using the contact / LID identity
    stateManager.addOrUpdateChat({
      id: '10000000001@s.whatsapp.net',
      name: 'Alice Johnson',
      lastMessage: 'Update from LID stream',
      time: '07:31 AM',
      unreadCount: 2,
      avatarIcon: 'person',
      timestamp: 1787451060,
    });

    // 3. Sends a message to that contact (using name / phone / LID / JID)
    const targetCanonical = stateManager.getCanonicalJid('Alice Johnson');
    assert.strictEqual(targetCanonical, '15551234567@s.whatsapp.net');

    // 4. Receives the resulting message update
    stateManager.addMessage({
      id: 'MSG_SENT_002',
      chatId: targetCanonical,
      sender: 'You',
      fromMe: true,
      text: 'Sent reply message',
      time: '07:32 AM',
      timestamp: 1787451120,
    });

    // 5. Fetches recent chats
    const recentChats = stateManager.getRecentChats();
    assert.strictEqual(recentChats.length, 1, `Expected exactly 1 chat card, got ${recentChats.length}`);
    assert.strictEqual(recentChats[0].id, '15551234567@s.whatsapp.net');
    assert.strictEqual(recentChats[0].name, 'Alice Johnson');
    assert.strictEqual(recentChats[0].lastMessage, 'Sent reply message');

    // 6. Fetches history for the contact
    const history = stateManager.getChatHistory('15551234567@s.whatsapp.net');
    assert.strictEqual(history.length, 2, `Expected 2 messages in unified history, got ${history.length}`);
    assert.strictEqual(history[0].id, 'MSG_PHONE_001');
    assert.strictEqual(history[1].id, 'MSG_SENT_002');

    // Also fetch history via LID alias
    const historyViaLid = stateManager.getChatHistory('10000000001@s.whatsapp.net');
    assert.strictEqual(historyViaLid.length, 2);

    // 7. Test daemon restart / loading state.json
    stateManager = new StateManager(tmpStateFile);

    const reloadedRecentChats = stateManager.getRecentChats();
    assert.strictEqual(reloadedRecentChats.length, 1, `After restart, expected 1 chat card, got ${reloadedRecentChats.length}`);
    assert.strictEqual(reloadedRecentChats[0].id, '15551234567@s.whatsapp.net');
    assert.strictEqual(reloadedRecentChats[0].name, 'Alice Johnson');

    const reloadedHistory = stateManager.getChatHistory('15551234567@s.whatsapp.net');
    assert.strictEqual(reloadedHistory.length, 2, `After restart, expected 2 messages, got ${reloadedHistory.length}`);

    // Cleanup
    if (fs.existsSync(tmpStateFile)) fs.unlinkSync(tmpStateFile);

    console.log('✓ CRITICAL INTEGRATION TEST PASSED: Exactly 1 chat & 1 unified history preserved across operations and restart!');
  });
});
