import net from 'net';

const socketPath = '/run/user/1000/whatsapp-daemon.sock';
console.log(`Connecting to live WhatsApp daemon IPC socket at: ${socketPath}`);

const socket = net.createConnection(socketPath, () => {
  console.log('✔ Connected to live daemon socket.');

  // Step 1: Query Get Status
  console.log('\n--- 1. Testing get_status ---');
  socket.write(JSON.stringify({ id: 'req-status', action: 'get_status' }) + '\n');

  // Step 2: Query Get Unread Chats
  console.log('--- 2. Testing get_unread_chats ---');
  socket.write(JSON.stringify({ id: 'req-unread', action: 'get_unread_chats' }) + '\n');
});

let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');
  let lineIndex: number;
  while ((lineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, lineIndex);
    buffer = buffer.slice(lineIndex + 1);
    console.log('[DAEMON IPC RESPONSE]:', line);
  }
});

setTimeout(() => {
  console.log('\nEnding verification client test.');
  socket.end();
  process.exit(0);
}, 3000);
