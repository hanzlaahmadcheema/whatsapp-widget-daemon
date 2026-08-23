import assert from 'assert';
import path from 'path';
import os from 'os';
import fs from 'fs';

const testStateFile = path.join(os.tmpdir(), `whatsapp-test-state-${Date.now()}.json`);
process.env.WHATSAPP_DAEMON_STATE_FILE = testStateFile;

async function runAllTests() {
  const { normalizeJid } = await import('../src/whatsapp/normalizer.js');
  const { StateManager } = await import('../src/store/state-manager.js');
  const { SocketServer } = await import('../src/ipc/socket-server.js');
  const { WhatsAppClient } = await import('../src/whatsapp/client.js');
  const { daemonConfig } = await import('../src/config.js');
  const net = (await import('net')).default;

  // --- UNIT TEST 1: Focused JID Normalization Tests ---
  console.log('=== Running Unit Test 1: JID / Recipient Normalization ===');

  assert.strictEqual(normalizeJid('923001234567'), '923001234567@s.whatsapp.net');
  assert.strictEqual(normalizeJid('+92 300 1234567'), '923001234567@s.whatsapp.net');
  assert.strictEqual(normalizeJid('12036304@c.us'), '12036304@s.whatsapp.net');
  assert.strictEqual(normalizeJid('923001234567@s.whatsapp.net'), '923001234567@s.whatsapp.net');
  assert.strictEqual(normalizeJid('1203630401@g.us'), '1203630401@g.us');

  console.log('✔ JID Normalization unit tests passed!');

  // --- UNIT TEST 2: StateManager getRecentChats() Test ---
  console.log('\n=== Running Unit Test 2: StateManager getRecentChats() ===');

  const testState = new StateManager();
  testState.addOrUpdateChat({
    id: '1111111111@s.whatsapp.net',
    name: 'Chat Older',
    lastMessage: 'Old message',
    time: '10:00 AM',
    unreadCount: 0,
    avatarIcon: 'person',
    timestamp: 1000,
  });

  testState.addOrUpdateChat({
    id: '2222222222@s.whatsapp.net',
    name: 'Chat Newer',
    lastMessage: 'New message',
    time: '10:30 AM',
    unreadCount: 2,
    avatarIcon: 'person',
    timestamp: 2000,
  });

  const recents = testState.getRecentChats(10);
  assert.strictEqual(recents[0].id, '2222222222@s.whatsapp.net', 'Newest chat comes first');
  assert.strictEqual(recents[1].id, '1111111111@s.whatsapp.net', 'Older chat comes second');

  const recentsLimit1 = testState.getRecentChats(1);
  assert.strictEqual(recentsLimit1.length, 1);
  assert.strictEqual(recentsLimit1[0].id, '2222222222@s.whatsapp.net');

  console.log('✔ StateManager getRecentChats() unit tests passed!');

  // --- INTEGRATION TEST 3: IPC Socket Protocol & Payloads ---
  console.log('\n=== Running Integration Test 3: IPC Socket Protocol & Payloads ===');

  const stateManager = new StateManager();
  const waClient = new WhatsAppClient(stateManager);
  const server = new SocketServer(stateManager, waClient);

  await server.start();
  const socketPath = daemonConfig.socketPath;
  console.log(`Server started on socket: ${socketPath}`);

  // Seed state with an unread chat using @c.us input format
  stateManager.addOrUpdateChat({
    id: '12036304@c.us',
    name: 'Ahmed',
    lastMessage: 'Hello there',
    time: '10:42 AM',
    unreadCount: 3,
    avatarIcon: 'person',
    timestamp: 1755910000,
  });

  const clientSocket = net.createConnection(socketPath, () => {
    console.log('IPC client connected.');
  });

  const receivedEvents: any[] = [];
  let buffer = '';

  clientSocket.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    let lineIndex: number;
    while ((lineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, lineIndex);
      buffer = buffer.slice(lineIndex + 1);
      const parsed = JSON.parse(line);
      receivedEvents.push(parsed);
    }
  });

  // Wait briefly for initial status_changed, unread_chats_updated, and recent_chats_updated
  await new Promise((r) => setTimeout(r, 300));

  // --- Verify status_changed payload ---
  const statusEvent = receivedEvents.find((e) => e.event === 'status_changed');
  assert.ok(statusEvent, 'status_changed event must be emitted');
  assert.strictEqual(typeof statusEvent.daemonConfigured, 'boolean');
  assert.strictEqual(typeof statusEvent.daemonConnected, 'boolean');
  console.log('✔ status_changed payload matches widget contract:', statusEvent);

  // --- Verify unread_chats_updated payload structure ---
  const unreadEvent = receivedEvents.find((e) => e.event === 'unread_chats_updated');
  assert.ok(unreadEvent, 'unread_chats_updated event must be emitted');
  assert.ok(Array.isArray(unreadEvent.chats), 'unread_chats_updated chats array missing');
  console.log('✔ unread_chats_updated payload matches widget contract:', unreadEvent);

  // --- Verify recent_chats_updated payload structure ---
  const initialRecentEvent = receivedEvents.find((e) => e.event === 'recent_chats_updated');
  assert.ok(initialRecentEvent, 'recent_chats_updated event must be emitted on connect');
  assert.ok(Array.isArray(initialRecentEvent.chats), 'recent_chats_updated chats array missing');
  console.log('✔ recent_chats_updated initial event payload matches contract:', initialRecentEvent);

  // --- Test get_recent_chats request action ---
  console.log('\nTesting get_recent_chats action...');
  clientSocket.write(
    JSON.stringify({
      id: 'test-get-recent',
      action: 'get_recent_chats',
      limit: 10,
    }) + '\n'
  );

  await new Promise((r) => setTimeout(r, 300));

  const recentResponse = receivedEvents.find((e) => e.id === 'test-get-recent');
  assert.ok(recentResponse && recentResponse.success, 'get_recent_chats response successful');
  assert.ok(Array.isArray(recentResponse.data.chats), 'get_recent_chats response contains chats array');
  console.log('✔ get_recent_chats request returned successful response:', recentResponse);

  // --- Test mark_read action using @c.us format ---
  console.log('\nTesting mark_read action with @c.us format...');
  clientSocket.write(
    JSON.stringify({
      id: 'test-mark-read',
      action: 'mark_read',
      chatId: '12036304@c.us',
    }) + '\n'
  );

  await new Promise((r) => setTimeout(r, 300));

  const markReadResponse = receivedEvents.find((e) => e.id === 'test-mark-read');
  assert.ok(markReadResponse && markReadResponse.success, 'mark_read response successful');

  clientSocket.end();
  await server.close();
  if (fs.existsSync(testStateFile)) {
    try { fs.unlinkSync(testStateFile); } catch {}
  }
  console.log('\n✔ ALL IPC COMPATIBILITY & RECENT CHATS TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runAllTests().catch((err) => {
  console.error('Integration test error:', err);
  process.exit(1);
});
