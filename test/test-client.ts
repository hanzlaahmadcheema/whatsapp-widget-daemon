import net from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';

function getSocketPath(): string {
  if (process.env.WHATSAPP_DAEMON_SOCKET) {
    return process.env.WHATSAPP_DAEMON_SOCKET;
  }
  const uid = process.getuid ? process.getuid() : 1000;
  const runtimeDir = `/run/user/${uid}`;
  if (fs.existsSync(runtimeDir)) {
    return path.join(runtimeDir, 'whatsapp-daemon.sock');
  }
  return path.join(os.homedir(), '.local', 'share', 'whatsapp-widget-daemon', 'whatsapp-daemon.sock');
}

const socketPath = getSocketPath();
console.log(`Connecting to daemon socket at: ${socketPath}`);

const socket = net.createConnection(socketPath, () => {
  console.log('Successfully connected to WhatsApp Daemon IPC socket!');

  // Test 1: Send get_status
  console.log('\n--- Sending get_status ---');
  socket.write(JSON.stringify({ id: 'test-1', action: 'get_status' }) + '\n');

  // Test 2: Send get_unread_chats
  console.log('--- Sending get_unread_chats ---');
  socket.write(JSON.stringify({ id: 'test-2', action: 'get_unread_chats' }) + '\n');

  // Test 3: Send sync_config
  console.log('--- Sending sync_config ---');
  socket.write(
    JSON.stringify({
      id: 'test-3',
      action: 'sync_config',
      config: { maxUnreadChats: 5, maxMessageHistory: 25 },
    }) + '\n'
  );

  setTimeout(() => {
    console.log('\nDisconnecting test client.');
    socket.end();
  }, 1500);
});

let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk.toString('utf-8');
  let lineIndex: number;
  while ((lineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, lineIndex);
    buffer = buffer.slice(lineIndex + 1);
    console.log('RECEIVED IPC EVENT/RESPONSE:', line);
  }
});

socket.on('error', (err) => {
  console.error('Socket connection error:', err.message);
});
