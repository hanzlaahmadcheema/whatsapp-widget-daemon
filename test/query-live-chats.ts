import net from 'net';

const socketPath = '/run/user/1000/whatsapp-daemon.sock';
console.log(`Connecting to live daemon socket at: ${socketPath}`);

const socket = net.createConnection(socketPath, () => {
  console.log('✔ Connected to live WhatsApp daemon IPC socket.');
  console.log('\n--- Requesting get_recent_chats (limit: 25) ---');
  socket.write(
    JSON.stringify({
      id: 'query-recents-1',
      action: 'get_recent_chats',
      limit: 25,
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

    if (parsed.event === 'recent_chats_updated' || parsed.id === 'query-recents-1') {
      console.log('\n================ ACTUAL REAL WHATSAPP RECENT CHATS ================');
      const chats = parsed.chats || (parsed.data && parsed.data.chats) || [];
      console.log(`Total chats returned: ${chats.length}\n`);

      chats.forEach((c: any, i: number) => {
        console.log(
          `[${i + 1}] ${c.name} (${c.id})\n    Time: ${c.time} (ts: ${c.timestamp})\n    Last Message: "${c.lastMessage}"\n    Unread: ${c.unreadCount} | Icon: ${c.avatarIcon}\n`
        );
      });

      if (parsed.id === 'query-recents-1') {
        setTimeout(() => {
          socket.end();
          process.exit(0);
        }, 500);
      }
    }
  }
});
