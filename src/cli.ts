import net from 'net';
import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode-terminal';
import { daemonConfig } from './config.js';
import { StatusChangedEvent, ResponseMessage } from './ipc/types.js';

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return 'N/A';
  return new Date(ts).toLocaleString();
}

async function runCli() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  const socketPath = daemonConfig.socketPath;
  const sessionDir = daemonConfig.sessionDir;
  const sessionExists = fs.existsSync(path.join(sessionDir, 'creds.json'));

  if (command === 'status') {
    await handleStatus(socketPath, sessionExists, sessionDir);
  } else if (command === 'auth') {
    await handleAuth(socketPath, sessionExists);
  } else {
    console.log(`Unknown CLI command: '${command}'`);
    console.log('Available commands: status, auth');
    process.exit(1);
  }
}

function handleStatus(socketPath: string, sessionExists: boolean, sessionDir: string): Promise<void> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      console.log('\n======================================================');
      console.log('   whatsapp-widget-daemon Health & Status Report     ');
      console.log('======================================================');
      console.log('[✘] Daemon Process:     Stopped / Inactive');
      console.log(`[✘] IPC Socket:         ${socketPath} (Not Available)`);
      console.log(`[${sessionExists ? '✓' : '✘'}] WhatsApp Auth:      ${sessionExists ? `Authenticated (${sessionDir})` : 'Not Authenticated'}`);
      console.log('[✘] WhatsApp Web:       Offline (Daemon not running)');
      console.log('[✘] Message Sync:       Offline');
      console.log('======================================================\n');
      resolve();
      return;
    }

    const socket = net.createConnection(socketPath);
    let receivedStatus = false;
    let buffer = '';

    const timer = setTimeout(() => {
      if (!receivedStatus) {
        console.log('\n[!] Socket connected but response timed out.');
        socket.destroy();
        resolve();
      }
    }, 3000);

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 'cli-req', action: 'get_status' }) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let lineIndex: number;
      while ((lineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineIndex);
        buffer = buffer.slice(lineIndex + 1);

        try {
          const msg = JSON.parse(line);
          if (msg && msg.type === 'response' && msg.id === 'cli-req' && msg.data) {
            receivedStatus = true;
            clearTimeout(timer);
            const data = msg.data;
            printStatusReport(socketPath, sessionExists, sessionDir, data);
            socket.end();
            resolve();
            return;
          }
        } catch {}
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      console.log('\n======================================================');
      console.log('   whatsapp-widget-daemon Health & Status Report     ');
      console.log('======================================================');
      console.log('[✘] Daemon Process:     Error connecting to IPC socket');
      console.log(`[!] Error Details:      ${err.message}`);
      console.log(`[${sessionExists ? '✓' : '✘'}] WhatsApp Auth:      ${sessionExists ? 'Authenticated' : 'Not Authenticated'}`);
      console.log('======================================================\n');
      resolve();
    });
  });
}

function printStatusReport(socketPath: string, sessionExists: boolean, sessionDir: string, data: any) {
  const isConnected = data.connected || data.status === 'connected' || data.status === 'syncing';
  const statusStr = data.status || (isConnected ? 'connected' : 'offline');
  const syncStateStr = data.syncState || (statusStr === 'syncing' ? 'syncing' : (isConnected ? 'completed' : 'idle'));

  console.log('\n======================================================');
  console.log('   whatsapp-widget-daemon Health & Status Report     ');
  console.log('======================================================');
  console.log('[✓] Daemon Process:     Running');
  console.log(`[✓] IPC Socket:         ${socketPath} (Available)`);
  console.log(`[${sessionExists ? '✓' : '✘'}] WhatsApp Auth:      ${sessionExists ? `Authenticated (${sessionDir})` : 'Not Authenticated'}`);
  console.log(`[${isConnected ? '✓' : '!'}] WhatsApp Web:       ${statusStr.toUpperCase()}`);
  console.log(`[${syncStateStr === 'completed' ? '✓' : (syncStateStr === 'syncing' ? '↻' : '!')}] Message Sync:       ${syncStateStr.toUpperCase()}`);
  console.log(`[i] Last Connected:     ${formatTimestamp(data.lastConnectedAt)}`);
  console.log(`[i] Active Unread:      ${data.unreadCount ?? 0} chats`);
  console.log(`[i] Cached Recent:      ${data.recentChatsCount ?? 0} chats`);
  console.log('======================================================\n');
}

function handleAuth(socketPath: string, sessionExists: boolean): Promise<void> {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      console.log('\n[✘] Error: Daemon is not running.');
      console.log('Please start the daemon first: ./whatsapp-daemon.sh start\n');
      resolve();
      return;
    }

    console.log('\n======================================================');
    console.log('         WhatsApp Authentication Setup');
    console.log('======================================================');
    console.log('Connecting to daemon socket...\n');

    const socket = net.createConnection(socketPath);
    let buffer = '';
    let lastQrShown = '';
    let lastPhase = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id: 'auth-req', action: 'get_status' }) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let lineIndex: number;
      while ((lineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineIndex);
        buffer = buffer.slice(lineIndex + 1);

        try {
          const msg = JSON.parse(line);

          // Handle status_changed events (streamed during auth)
          if (msg && msg.event === 'status_changed') {
            handleAuthStatusEvent(socket, msg, lastQrShown, (newQr) => {
              lastQrShown = newQr;
            }, lastPhase, (newPhase) => {
              lastPhase = newPhase;
            }, resolve);
          }

          // Handle get_status response (initial or after sync)
          if (msg && msg.type === 'response' && msg.id === 'auth-req' && msg.data) {
            const data = msg.data;
            if (data.status === 'connected' && data.syncState === 'completed') {
              // Sync complete — fetch recent chats for summary
              socket.write(JSON.stringify({ id: 'auth-chats', action: 'get_recent_chats', limit: 100 }) + '\n');
            }
          }

          // Handle get_recent_chats response
          if (msg && msg.type === 'response' && msg.id === 'auth-chats' && msg.data) {
            const chats = msg.data.chats || [];
            printAuthSummary(chats);
            socket.end();
            resolve();
            return;
          }
        } catch {}
      }
    });

    socket.on('error', (err) => {
      console.log(`[✘] Socket Error: ${err.message}`);
      resolve();
    });
  });
}

function handleAuthStatusEvent(
  socket: net.Socket,
  evt: StatusChangedEvent,
  lastQrShown: string,
  setLastQr: (qr: string) => void,
  lastPhase: string,
  setLastPhase: (phase: string) => void,
  resolve: () => void
) {
  // Don't resolve here — let the get_recent_chats response handle final exit
  if (evt.status === 'connected' && evt.syncState === 'completed') {
    if (lastPhase !== 'ready') {
      setLastPhase('ready');
      console.log('\n[✓] Progress: Connecting → Authenticating → Syncing → Ready');
      console.log('[✓] WhatsApp is fully authenticated and connected!');
    }
    return;
  }

  if (evt.status === 'syncing') {
    if (lastPhase !== 'syncing') {
      setLastPhase('syncing');
      console.log('[✓] Progress: Connecting → Authenticating → Syncing (in progress)...');
      console.log('[✓] QR Code scanned! Syncing WhatsApp message history...\n');
    }
    return;
  }

  if (evt.qr && evt.qr !== lastQrShown) {
    setLastQr(evt.qr);
    console.log('\n======================================================');
    console.log('   SCAN QR CODE WITH WHATSAPP ON YOUR MOBILE PHONE');
    console.log('======================================================');
    qrcode.generate(evt.qr, { small: true });
    console.log('\nInstructions:');
    console.log('  1. Open WhatsApp on your phone.');
    console.log('  2. Tap Menu (⋮) or Settings -> Linked Devices.');
    console.log('  3. Tap "Link a Device".');
    console.log('  4. Point your camera at the QR code above.\n');
    console.log('Current Phase: [ Connecting → Authenticating (Waiting for scan...) ]\n');
  } else if (evt.status === 'authenticating' && !evt.qr) {
    console.log('Phase: [ Connecting → Authenticating (Generating QR code...) ]');
  } else if (evt.status === 'connecting') {
    console.log('Phase: [ Connecting to WhatsApp Web... ]');
  }
}

function printAuthSummary(chats: any[]): void {
  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const chat of chats) {
    const name = chat.name || '';
    const id = chat.id || '';
    if (!name) {
      failed.push(id);
    } else if (/^\+\d{7,15}$/.test(name.trim())) {
      failed.push(name);
    } else {
      succeeded.push(name);
    }
  }

  console.log('\n======================================================');
  console.log('              Sync Summary');
  console.log('======================================================');
  console.log(`  [✓] Succeeded:  ${succeeded.length} chats`);
  if (succeeded.length > 0) {
    for (const n of succeeded.slice(0, 10)) {
      console.log(`       • ${n}`);
    }
    if (succeeded.length > 10) {
      console.log(`       ... and ${succeeded.length - 10} more`);
    }
  }
  console.log(`  [✘] Failed:     ${failed.length} chats`);
  if (failed.length > 0) {
    for (const n of failed.slice(0, 5)) {
      console.log(`       • ${n}`);
    }
    if (failed.length > 5) {
      console.log(`       ... and ${failed.length - 5} more`);
    }
  }
  console.log(`  [↻] Total:      ${chats.length} chats`);
  console.log('======================================================\n');
}

runCli().catch((err) => {
  console.error('CLI Error:', err);
  process.exit(1);
});
