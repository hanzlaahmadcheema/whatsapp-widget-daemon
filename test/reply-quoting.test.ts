import assert from 'node:assert';
import { test, describe } from 'node:test';
import { StateManager } from '../src/store/state-manager.js';

describe('WhatsApp Reply Quoting Context Resolution', () => {
  test('Resolves message by ID and fails cleanly when unresolvable', () => {
    const stateManager = new StateManager(null);

    // Add a message into history
    stateManager.addMessage({
      id: 'ORIGINAL_MSG_123',
      chatId: '15551234567@s.whatsapp.net',
      sender: 'Alice Johnson',
      fromMe: false,
      text: 'Original message text to quote',
      time: '07:10 AM',
      timestamp: 1787449800,
      rawMessage: { conversation: 'Original message text to quote' }
    });

    // PROVE 1: Message resolved by ID
    const resolved = stateManager.findMessageById('ORIGINAL_MSG_123');
    assert.notStrictEqual(resolved, null);
    assert.strictEqual(resolved?.id, 'ORIGINAL_MSG_123');
    assert.strictEqual(resolved?.text, 'Original message text to quote');

    // PROVE 2: Unresolvable ID returns null
    const unresolvable = stateManager.findMessageById('NON_EXISTENT_ID_999');
    assert.strictEqual(unresolvable, null);

    console.log('✓ REGRESSION TEST PASSED: WhatsApp Reply Context Resolution!');
  });
});
