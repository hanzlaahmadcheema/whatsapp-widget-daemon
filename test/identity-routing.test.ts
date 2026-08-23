import assert from 'node:assert';
import { test, describe } from 'node:test';
import { StateManager } from '../src/store/state-manager.js';

describe('Comprehensive Conversation Identity Routing & Isolation Test', () => {
  test('Exact conversation isolation across contacts, self-chat, LIDs, and formats', () => {
    const sm = new StateManager(null);

    // Set self JID
    sm.setMyJid('15550001111:3@s.whatsapp.net');

    const other1Jid = '15551234567@s.whatsapp.net';
    const other2Jid = '15559876543@s.whatsapp.net';
    const myJid = '15550001111@s.whatsapp.net';

    // 1. Incoming message: Other #1 -> You ("Yes")
    sm.addMessage({
      id: 'MSG_OTHER1_001',
      chatId: other1Jid,
      sender: 'Other One',
      fromMe: false,
      text: 'Yes',
      time: '08:00 AM',
      timestamp: 1787455200,
    });

    // 2. Outgoing message: You -> Other #1 ("Good")
    sm.addMessage({
      id: 'MSG_OUT1_002',
      chatId: other1Jid,
      sender: 'You',
      fromMe: true,
      text: 'Good',
      time: '08:01 AM',
      timestamp: 1787455260,
    });

    // 3. Outgoing message: You -> Yourself ("Ok")
    sm.addMessage({
      id: 'MSG_SELF_003',
      chatId: myJid,
      sender: 'You',
      fromMe: true,
      text: 'Ok',
      time: '08:02 AM',
      timestamp: 1787455320,
    });

    // 4. Incoming message: Other #2 -> You ("Hey")
    sm.addMessage({
      id: 'MSG_OTHER2_004',
      chatId: other2Jid,
      sender: 'Other Two',
      fromMe: false,
      text: 'Hey',
      time: '08:03 AM',
      timestamp: 1787455380,
    });

    // 5. Outgoing message: You -> Other #2 ("Nice")
    sm.addMessage({
      id: 'MSG_OUT2_005',
      chatId: other2Jid,
      sender: 'You',
      fromMe: true,
      text: 'Nice',
      time: '08:04 AM',
      timestamp: 1787455440,
    });

    // 6. LID message for Other #1
    const other1Lid = '10000000001@s.whatsapp.net';
    sm.registerLidOrAliasMapping(other1Lid, other1Jid);
    sm.addMessage({
      id: 'MSG_OTHER1_LID_006',
      chatId: other1Lid,
      sender: 'Other One',
      fromMe: false,
      text: 'LID message from Other One',
      time: '08:05 AM',
      timestamp: 1787455500,
    });

    // 7. Verify Recent Chats Count: MUST BE EXACTLY 3 DISTINCT CHATS (Other #2, Other #1, Message Yourself)
    const recentChats = sm.getRecentChats();
    assert.strictEqual(recentChats.length, 3, `Expected 3 distinct chats, got ${recentChats.length}`);

    const chatIds = recentChats.map((c) => c.id);
    assert.ok(chatIds.includes(other1Jid), 'Other #1 chat must exist as canonical JID');
    assert.ok(chatIds.includes(other2Jid), 'Other #2 chat must exist as canonical JID');
    assert.ok(chatIds.includes(myJid), 'Message Yourself must exist as canonical JID');

    // 8. Verify Message History for Other #1 (MUST NOT contain Other #2 or Self messages)
    const historyOther1 = sm.getChatHistory(other1Jid);
    const textOther1 = historyOther1.map((m) => m.text);
    assert.ok(textOther1.includes('Yes'), 'Other #1 history must include "Yes"');
    assert.ok(textOther1.includes('Good'), 'Other #1 history must include "Good"');
    assert.ok(textOther1.includes('LID message from Other One'), 'Other #1 history must include LID message');
    assert.strictEqual(textOther1.includes('Ok'), false, 'Other #1 history MUST NOT include self message "Ok"');
    assert.strictEqual(textOther1.includes('Hey'), false, 'Other #1 history MUST NOT include Other #2 message "Hey"');

    // 9. Verify Message History for Message Yourself (MUST ONLY contain "Ok")
    const historySelf = sm.getChatHistory(myJid);
    const textSelf = historySelf.map((m) => m.text);
    assert.strictEqual(historySelf.length, 1, `Expected 1 message in Message Yourself history, got ${historySelf.length}`);
    assert.strictEqual(textSelf[0], 'Ok', 'Message Yourself must ONLY contain "Ok"');

    // 10. Verify Message History for Other #2 (MUST contain "Hey" and "Nice")
    const historyOther2 = sm.getChatHistory(other2Jid);
    const textOther2 = historyOther2.map((m) => m.text);
    assert.ok(textOther2.includes('Hey'), 'Other #2 history must include "Hey"');
    assert.ok(textOther2.includes('Nice'), 'Other #2 history must include "Nice"');
    assert.strictEqual(textOther2.includes('Ok'), false, 'Other #2 history MUST NOT include self message "Ok"');

    // 11. Test format resolution: +1..., @c.us, and canonical JID resolution
    assert.strictEqual(sm.getCanonicalJid('+15551234567'), other1Jid);
    assert.strictEqual(sm.getCanonicalJid('15551234567@c.us'), other1Jid);
    assert.strictEqual(sm.getCanonicalJid(other1Jid), other1Jid);

    console.log('✓ REGRESSION TEST PASSED: 3 Conversations Completely Isolated & Canonical Identity Routing Verified!');
  });
});
