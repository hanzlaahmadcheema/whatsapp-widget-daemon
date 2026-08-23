import assert from 'assert';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Setup temporary test directories
const testDir = path.join(os.tmpdir(), `whatsapp-logout-test-${Date.now()}`);
const testSessionDir = path.join(testDir, 'session');
const testStateFile = path.join(testDir, 'state.json');

process.env.WHATSAPP_DAEMON_SESSION_DIR = testSessionDir;
process.env.WHATSAPP_DAEMON_STATE_FILE = testStateFile;
process.env.WHATSAPP_DAEMON_SOCKET = path.join(testDir, 'ipc.sock');

async function runLogoutTest() {
  console.log('=== Running Logout & 401 Re-Authentication Test ===');

  const { initAuth, clearSession } = await import('../src/whatsapp/auth.js');
  const { StateManager } = await import('../src/store/state-manager.js');
  const { daemonConfig } = await import('../src/config.js');

  // Step 1: Create dummy session file & dummy state.json
  fs.mkdirSync(testSessionDir, { recursive: true });
  fs.writeFileSync(path.join(testSessionDir, 'creds.json'), JSON.stringify({ noiseKey: 'test' }));
  
  const stateManager = new StateManager(testStateFile);
  stateManager.addOrUpdateChat({
    id: '1234567890@s.whatsapp.net',
    name: 'Preserved Contact',
    lastMessage: 'Preserved Message',
    time: '10:00 AM',
    unreadCount: 1,
    avatarIcon: 'person',
    timestamp: 1000,
  });

  assert.strictEqual(fs.existsSync(testStateFile), true, 'state.json file must exist');
  assert.strictEqual(fs.existsSync(path.join(testSessionDir, 'creds.json')), true, 'creds.json must exist prior to logout');

  let authManager = await initAuth();
  assert.strictEqual(authManager.isConfigured, true, 'authManager must report isConfigured = true initially');

  // Step 2: Simulate 401 Logout -> clearSession()
  console.log('Simulating 401 / DisconnectReason.loggedOut session cleanup...');
  clearSession();

  // Step 3: Assert sessionDir creds cleared, BUT state.json remains preserved!
  assert.strictEqual(fs.existsSync(path.join(testSessionDir, 'creds.json')), false, 'creds.json must be deleted after clearSession');
  assert.strictEqual(fs.existsSync(testStateFile), true, 'state.json MUST NOT be deleted by clearSession!');

  const freshState = new StateManager(testStateFile);
  const recents = freshState.getRecentChats();
  assert.strictEqual(recents.length, 1, 'Preserved chats in state.json must be loaded intact after session reset');
  assert.strictEqual(recents[0].name, 'Preserved Contact');
  console.log('✔ Verified: clearSession removes invalid credentials while preserving state.json intact!');

  // Step 4: Re-initialize auth -> verifies clean fresh state ready for QR generation
  authManager = await initAuth();
  assert.strictEqual(authManager.isConfigured, false, 'Fresh auth state reports isConfigured = false');
  console.log('✔ Verified: Fresh initAuth produces clean unconfigured state ready for QR generation!');

  // Cleanup test temp files
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log('\n✔ ALL LOGOUT & RE-AUTHENTICATION TESTS PASSED SUCCESSFULLY!');
  process.exit(0);
}

runLogoutTest().catch((err) => {
  console.error('Logout test error:', err);
  process.exit(1);
});
