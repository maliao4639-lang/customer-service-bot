'use strict';
// Keep the historical smoke-test entrypoint, backed by the current integration suite.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, ['--test', path.join(__dirname, '..', 'tests', 'shopify.test.js')], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
