'use strict';

/* Entry point: load config, start the server, close cleanly on signals. */

const { loadConfig } = require('./config');
const { createServer } = require('./app');

function main() {
  const config = loadConfig();
  const server = createServer(config);
  let closing = false;

  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`[server] ${signal} received, closing`);
    server.close().then(
      () => process.exit(0),
      (err) => {
        console.error('[server] error while closing', err);
        process.exit(1);
      }
    );
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.port).then(
    (port) => console.log(`[server] listening on port ${port}`),
    (err) => {
      console.error('[server] failed to start', err);
      process.exit(1);
    }
  );
}

main();
