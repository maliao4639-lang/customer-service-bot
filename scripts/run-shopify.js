'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const cli = process.env.SHOPIFY_CLI_PATH || path.resolve(__dirname, '../../shopify-cli/node_modules/@shopify/cli/bin/run.js');
if (!fs.existsSync(cli)) {
  console.error('Install the pinned CLI: npm install --prefix ../shopify-cli @shopify/cli@4.9.4');
  process.exitCode = 1;
} else {
  const args = process.argv.slice(2);
  const redactLogs = args.includes('--no-input');
  const child = spawn(process.execPath, [cli, ...args], { stdio: redactLogs ? ['inherit', 'pipe', 'pipe'] : 'inherit', env: process.env });
  if (redactLogs) {
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let pending = '';
      const clean = line => line.replace(/([?&](?:key|token|access_token|id_token)=)[^\s&]+/gi, '$1[redacted]');
      stream.on('data', chunk => {
        pending += chunk.toString();
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) output.write(clean(line) + '\n');
      });
      stream.on('end', () => { if (pending) output.write(clean(pending)); });
    }
  }
  child.on('error', () => { console.error('Could not start Shopify CLI.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
