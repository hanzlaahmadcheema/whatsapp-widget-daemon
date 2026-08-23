import assert from 'node:assert';
import { test, describe } from 'node:test';
import { StateManager } from '../src/store/state-manager.js';

describe('Saved Contact Name Resolution Priority Test', () => {
  test('Saved Contact Name takes precedence over WhatsApp Push Name & Phone Number', () => {
    const sm = new StateManager(null);
    sm.setMyJid('15550001111@s.whatsapp.net');

    const contact1Jid = '15551234567@s.whatsapp.net';
    const contact2Jid = '15559876543@s.whatsapp.net';

    // 1. Simulate contacts.upsert / messaging-history.set receiving Saved Contact Names + Push Names
    sm.addOrUpdateContact({
      id: contact1Jid,
      name: 'Actual Saved Name A', // Saved Contact Name from phone book
      notify: 'PushName A',       // WhatsApp Push Name
    });

    sm.addOrUpdateContact({
      id: contact2Jid,
      name: 'Actual Saved Name B', // Saved Contact Name from phone book
      notify: 'PushName B',       // WhatsApp Push Name
    });

    // 2. Add incoming messages from these contacts (where msg.pushName is present)
    sm.addMessage({
      id: 'MSG_A_001',
      chatId: contact1Jid,
      sender: 'PushName A',
      fromMe: false,
      text: 'Hello from A',
      time: '08:15 AM',
      timestamp: 1787456100,
    });

    sm.addMessage({
      id: 'MSG_B_002',
      chatId: contact2Jid,
      sender: 'PushName B',
      fromMe: false,
      text: 'Hello from B',
      time: '08:16 AM',
      timestamp: 1787456160,
    });

    // 3. Fetch Recent Chats IPC payload
    const recentChats = sm.getRecentChats();
    assert.strictEqual(recentChats.length, 2, `Expected 2 chats, got ${recentChats.length}`);

    const chatA = recentChats.find((c) => c.id === contact1Jid);
    const chatB = recentChats.find((c) => c.id === contact2Jid);

    assert.ok(chatA, 'Chat A must exist');
    assert.ok(chatB, 'Chat B must exist');

    // 4. Assert Saved Contact Name Priority
    assert.strictEqual(chatA.name, 'Actual Saved Name A', 'Chat A MUST display Saved Contact Name A');
    assert.strictEqual(chatB.name, 'Actual Saved Name B', 'Chat B MUST display Saved Contact Name B');

    console.log('✓ REGRESSION TEST PASSED: Saved Contact Names take priority over Push Names and Phone Numbers!');
  });
});
