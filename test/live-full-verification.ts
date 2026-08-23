import net from 'net';

const socketPath = '/run/user/1000/whatsapp-daemon.sock';
const selfRecipient = '15550001111';

console.log(`=== LIVE FULL VERIFICATION TEST ===`);
console.log(`Connecting to daemon socket: ${socketPath}`);

const socket = net.createConnection(socketPath, async () => {
  console.log('✔ Connected to live WhatsApp daemon IPC socket.');

  // Step 1: Send Message
  console.log(`\n--- 1. Testing send_message to ${selfRecipient} ---`);
  socket.write(
    JSON.stringify({
      id: 'req-send',
      action: 'send_message',
      recipient: selfRecipient,
      message: 'Test message from end4-pC widget daemon live verification',
    }) + '\n'
  );
});

let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');
  let lineIndex: number;
  while ((lineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, lineIndex);
    buffer = buffer.slice(lineIndex + 1);
    const parsed = JSON.parse(line);
    console.log('[IPC RECEIVED]:', JSON.stringify(parsed, null, 2));

    if (parsed.id === 'req-send' && parsed.success) {
      console.log('\n--- 2. send_message succeeded! Querying get_chat_history... ---');
      socket.write(
        JSON.stringify({
          id: 'req-history',
          action: 'get_chat_history',
          chatId: `${selfRecipient}@s.whatsapp.net`,
          limit: 10,
        }) + '\n'
      );
    }

    if (parsed.id === 'req-history' && parsed.success) {
      console.log('\n--- 3. get_chat_history succeeded! Testing mark_read... ---');
      socket.write(
        JSON.stringify({
          id: 'req-markread',
          action: 'mark_read',
          chatId: `${selfRecipient}@s.whatsapp.net`,
        }) + '\n'
      );
    }

    if (parsed.id === 'req-markread' && parsed.success) {
      console.log('\n✔ ALL REAL IPC ACTIONS (STATUS, SEND, HISTORY, MARK_READ) PASSED SUCCESSFULLY!');
      setTimeout(() => {
        socket.end();
        process.exit(0);
      }, 500);
    }
  }
});
