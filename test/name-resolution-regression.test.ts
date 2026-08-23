import assert from 'node:assert';
import { test, describe } from 'node:test';
import { StateManager } from '../src/store/state-manager.js';
import { normalizeMessage, buildNormalizedChat } from '../src/whatsapp/normalizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Regression: buildNormalizedChat must never generate phone numbers
// ─────────────────────────────────────────────────────────────────────────────

describe('buildNormalizedChat — must not fabricate phone numbers', () => {
  test('null chatName → empty string, not phone number', () => {
    const chat = buildNormalizedChat('923001234567@s.whatsapp.net', null as any, 'Hi', 1000, 1);
    assert.strictEqual(chat.name, '', 'null chatName must produce empty string, not a phone number');
  });

  test('empty chatName → empty string, not phone number', () => {
    const chat = buildNormalizedChat('923001234567@s.whatsapp.net', '', 'Hi', 1000, 1);
    assert.strictEqual(chat.name, '', 'empty chatName must produce empty string');
  });

  test('JID as chatName → empty string, not phone number', () => {
    const chat = buildNormalizedChat('923001234567@s.whatsapp.net', '923001234567@s.whatsapp.net', 'Hi', 1000, 1);
    assert.strictEqual(chat.name, '', 'JID chatName must produce empty string');
  });

  test('meaningful name preserved as-is', () => {
    const chat = buildNormalizedChat('923001234567@s.whatsapp.net', 'Alice', 'Hi', 1000, 1);
    assert.strictEqual(chat.name, 'Alice', 'Meaningful name must be preserved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: contactsMap contactName wins when Baileys chat.name = null
// ─────────────────────────────────────────────────────────────────────────────

describe('selectBestDisplayName — contactsMap takes precedence over phone numbers', () => {
  test('Baileys chat.name=null + contactsMap.contactName="TestUser" → "TestUser"', () => {
    const sm = new StateManager(null);
    sm.setMyJid('921111111111@s.whatsapp.net');

    const contactJid = '923001234567@s.whatsapp.net';

    // 1. Register saved contact name in contactsMap (simulates contacts.upsert / messaging-history.set contacts)
    sm.addOrUpdateContact({
      id: contactJid,
      name: 'TestUser',
      notify: 'Pushy',
    });

    // 2. Baileys fires messaging-history.set chat with null name (realistic for individual chats)
    const chatFromBaileys = buildNormalizedChat(contactJid, null as any, '', Math.floor(Date.now() / 1000), 0);
    assert.strictEqual(chatFromBaileys.name, '', 'buildNormalizedChat must not fabricate a name');

    // 3. Add the chat — selectBestDisplayName must resolve from contactsMap
    sm.addOrUpdateChat(chatFromBaileys);

    const chats = sm.getRecentChats();
    const chat = chats.find(c => c.id === contactJid);
    assert.ok(chat, 'Chat must exist');
    assert.strictEqual(chat.name, 'TestUser', 'contactsMap.contactName must win over phone number');
  });

  test('Baileys chat.name=null + no contact metadata → formatted phone number', () => {
    const sm = new StateManager(null);
    sm.setMyJid('921111111111@s.whatsapp.net');

    const unsavedJid = '923009999999@s.whatsapp.net';

    // No addOrUpdateContact — contact is unsaved
    const chatFromBaileys = buildNormalizedChat(unsavedJid, null as any, '', Math.floor(Date.now() / 1000), 0);
    sm.addOrUpdateChat(chatFromBaileys);

    const chats = sm.getRecentChats();
    const chat = chats.find(c => c.id === unsavedJid);
    assert.ok(chat, 'Chat must exist');
    assert.strictEqual(chat.name, '+923009999999', 'Unsaved contact must fall through to formatted phone number');
  });

  test('contactsMap.pushName wins when contactName is missing', () => {
    const sm = new StateManager(null);
    sm.setMyJid('921111111111@s.whatsapp.net');

    const contactJid = '923001234567@s.whatsapp.net';

    sm.addOrUpdateContact({
      id: contactJid,
      notify: 'PushOnly',
    });

    const chatFromBaileys = buildNormalizedChat(contactJid, null as any, '', Math.floor(Date.now() / 1000), 0);
    sm.addOrUpdateChat(chatFromBaileys);

    const chats = sm.getRecentChats();
    const chat = chats.find(c => c.id === contactJid);
    assert.ok(chat, 'Chat must exist');
    assert.strictEqual(chat.name, 'PushOnly', 'contactsMap.pushName must win when contactName is absent');
  });

  test('formatted phone number in contactsMap.contactName is rejected', () => {
    const sm = new StateManager(null);
    sm.setMyJid('921111111111@s.whatsapp.net');

    const contactJid = '923001234567@s.whatsapp.net';

    // Simulate Baileys sending a phone number as contact.name (edge case)
    sm.addOrUpdateContact({
      id: contactJid,
      name: '+923001234567',
      notify: 'RealPushName',
    });

    const chatFromBaileys = buildNormalizedChat(contactJid, null as any, '', Math.floor(Date.now() / 1000), 0);
    sm.addOrUpdateChat(chatFromBaileys);

    const chats = sm.getRecentChats();
    const chat = chats.find(c => c.id === contactJid);
    assert.ok(chat, 'Chat must exist');
    assert.strictEqual(chat.name, 'RealPushName', 'Phone-number contactName must be rejected; pushName must be used');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full integration: two saved contacts + one unsaved + self-chat + restart
// ─────────────────────────────────────────────────────────────────────────────

describe('Full daemon flow — clean state end-to-end', () => {
  test('complete lifecycle: saved contacts, unsaved, self-chat, restart, IPC payload', () => {
    const selfJid = '921111111111@s.whatsapp.net';
    const savedJidA = '923001111111@s.whatsapp.net';
    const savedJidB = '923002222222@s.whatsapp.net';
    const unsavedJid = '923003333333@s.whatsapp.net';

    // ── Phase 1: Fresh daemon start (no state.json) ──────────────────────
    const sm = new StateManager(null);
    sm.setMyJid(selfJid);

    // Simulate messaging-history.set: contacts first
    sm.addOrUpdateContact({ id: savedJidA, name: 'Alice Saved', notify: 'Alice Push' });
    sm.addOrUpdateContact({ id: savedJidB, name: 'Bob Saved', notify: 'Bob Push' });
    // unsavedJid has no contact entry

    // Simulate messaging-history.set: chats with null names (realistic Baileys behavior)
    sm.addOrUpdateChat(buildNormalizedChat(savedJidA, null as any, '', 1000, 0));
    sm.addOrUpdateChat(buildNormalizedChat(savedJidB, null as any, '', 1000, 0));
    sm.addOrUpdateChat(buildNormalizedChat(unsavedJid, null as any, '', 1000, 0));
    sm.addOrUpdateChat(buildNormalizedChat(selfJid, null as any, '', 1000, 0));

    // Verify names after initial sync
    let recent = sm.getRecentChats();
    const findChat = (jid: string) => recent.find(c => c.id === jid);

    assert.strictEqual(findChat(savedJidA)?.name, 'Alice Saved',
      'Saved contact A must show saved name after initial sync');
    assert.strictEqual(findChat(savedJidB)?.name, 'Bob Saved',
      'Saved contact B must show saved name after initial sync');
    assert.strictEqual(findChat(unsavedJid)?.name, '+923003333333',
      'Unsaved contact must show formatted phone number');
    assert.strictEqual(findChat(selfJid)?.name, 'Message Yourself',
      'Self-chat must show "Message Yourself"');

    // ── Phase 2: Incoming messages ───────────────────────────────────────
    const msgFromA = normalizeMessage({
      key: { remoteJid: savedJidA, fromMe: false, id: 'MSG_A1' },
      pushName: 'Alice Push',
      message: { conversation: 'Hello from A' },
      messageTimestamp: 2000,
    } as any)!;
    sm.addMessage(msgFromA);

    const msgFromB = normalizeMessage({
      key: { remoteJid: savedJidB, fromMe: false, id: 'MSG_B1' },
      pushName: 'Bob Push',
      message: { conversation: 'Hello from B' },
      messageTimestamp: 2000,
    } as any)!;
    sm.addMessage(msgFromB);

    // Verify names still correct after incoming messages
    recent = sm.getRecentChats();
    assert.strictEqual(findChat(savedJidA)?.name, 'Alice Saved',
      'Saved name must survive incoming message from A');
    assert.strictEqual(findChat(savedJidB)?.name, 'Bob Saved',
      'Saved name must survive incoming message from B');

    // Verify message senders use push names
    const histA = sm.getChatHistory(savedJidA);
    const lastMsgA = histA[histA.length - 1];
    assert.strictEqual(lastMsgA.sender, 'Alice Push',
      'Message sender must be the push name from the raw message');

    // ── Phase 3: Outgoing messages ───────────────────────────────────────
    const outgoingA = normalizeMessage({
      key: { remoteJid: savedJidA, fromMe: true, id: 'MSG_A_OUT' },
      message: { conversation: 'Reply to A' },
      messageTimestamp: 3000,
    } as any)!;
    sm.addMessage(outgoingA);

    const outgoingB = normalizeMessage({
      key: { remoteJid: savedJidB, fromMe: true, id: 'MSG_B_OUT' },
      message: { conversation: 'Reply to B' },
      messageTimestamp: 3000,
    } as any)!;
    sm.addMessage(outgoingB);

    recent = sm.getRecentChats();
    assert.strictEqual(findChat(savedJidA)?.name, 'Alice Saved',
      'Saved name must survive outgoing message to A');
    assert.strictEqual(findChat(savedJidB)?.name, 'Bob Saved',
      'Saved name must survive outgoing message to B');

    // ── Phase 4: Incoming message from unsaved number ────────────────────
    const msgFromUnsaved = normalizeMessage({
      key: { remoteJid: unsavedJid, fromMe: false, id: 'MSG_UNSAVED' },
      pushName: 'Unsaved Push',
      message: { conversation: 'Hey' },
      messageTimestamp: 4000,
    } as any)!;
    sm.addMessage(msgFromUnsaved);

    recent = sm.getRecentChats();
    // Unsaved contact with pushName — pushName should win over phone number
    assert.strictEqual(findChat(unsavedJid)?.name, 'Unsaved Push',
      'Unsaved contact incoming message must show push name');

    // ── Phase 5: Simulate daemon restart (fresh StateManager, no state) ─
    const sm2 = new StateManager(null);
    sm2.setMyJid(selfJid);

    // Re-populate from what the daemon would receive on restart
    sm2.addOrUpdateContact({ id: savedJidA, name: 'Alice Saved', notify: 'Alice Push' });
    sm2.addOrUpdateContact({ id: savedJidB, name: 'Bob Saved', notify: 'Bob Push' });

    sm2.addOrUpdateChat(buildNormalizedChat(savedJidA, null as any, '', 1000, 0));
    sm2.addOrUpdateChat(buildNormalizedChat(savedJidB, null as any, '', 1000, 0));
    sm2.addOrUpdateChat(buildNormalizedChat(unsavedJid, null as any, '', 1000, 0));
    sm2.addOrUpdateChat(buildNormalizedChat(selfJid, null as any, '', 1000, 0));

    recent = sm2.getRecentChats();
    assert.strictEqual(findChat(savedJidA)?.name, 'Alice Saved',
      'Saved name must survive daemon restart');
    assert.strictEqual(findChat(savedJidB)?.name, 'Bob Saved',
      'Saved name must survive daemon restart');
    assert.strictEqual(findChat(unsavedJid)?.name, '+923003333333',
      'Unsaved contact must show phone after restart');
    assert.strictEqual(findChat(selfJid)?.name, 'Message Yourself',
      'Self-chat must survive restart');

    // ── Phase 6: IPC payload structure (what widget receives) ────────────
    const event = sm.getRecentChatsEvent();
    assert.strictEqual(event.event, 'recent_chats_updated');
    assert.ok(Array.isArray(event.chats), 'IPC event must contain chats array');

    const ipcChatA = event.chats.find(c => c.id === savedJidA);
    assert.ok(ipcChatA, 'IPC payload must contain chat A');
    assert.strictEqual(ipcChatA.name, 'Alice Saved', 'IPC payload must have correct display name');

    console.log('\n✓ FULL DAEMON FLOW TEST PASSED: All phases verified.');
  });
});
