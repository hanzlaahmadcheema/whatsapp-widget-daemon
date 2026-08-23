import { StateManager } from './store/state-manager.js';
import { WhatsAppClient } from './whatsapp/client.js';
import { SocketServer } from './ipc/socket-server.js';
import { daemonConfig } from './config.js';
import { logger } from './utils/logger.js';

async function bootstrap() {
  logger.info('===============================================');
  logger.info('   whatsapp-widget-daemon starting up...       ');
  logger.info('===============================================');
  logger.info(`Socket path: ${daemonConfig.socketPath}`);
  logger.info(`Session dir: ${daemonConfig.sessionDir}`);

  const stateManager = new StateManager();
  const waClient = new WhatsAppClient(stateManager);
  const ipcServer = new SocketServer(stateManager, waClient);

  try {
    await ipcServer.start();
    await waClient.initialize();
  } catch (err) {
    logger.error({ err }, 'Daemon bootstrap error');
    process.exit(1);
  }

  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}. Gracefully shutting down daemon...`);

    try {
      await waClient.disconnect();
      await ipcServer.close();
      logger.info('Daemon shutdown complete. Goodbye!');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during daemon shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught Exception in daemon');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled Promise Rejection in daemon');
  });
}

bootstrap();
