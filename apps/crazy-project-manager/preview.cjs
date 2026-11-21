const path = require('node:path');
const { existsSync } = require('node:fs');

const settings = path.join(__dirname, '.env');
if (existsSync(settings)) process.loadEnvFile(settings);

import('./server.mjs')
  .then(({ startServer }) => startServer({ openBrowser: process.argv.includes('--open') }))
  .catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
