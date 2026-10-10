#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
const endpoint = args[args.indexOf('--socket') + 1];
const pidFile = args[args.indexOf('--pid-file') + 1];
if (args.includes('--version')) { console.log('cua-driver 0.34.1'); process.exit(0); }
if (args.includes('serve')) {
  const server = net.createServer(socket => socket.destroy());
  server.listen(endpoint, () => fs.writeFileSync(pidFile, String(process.pid)));
  process.stdin.resume();
  process.stdin.on('end', () => server.close(() => process.exit(0)));
} else if (args.includes('call')) {
  if (args.includes('health_report')) {
    console.log(JSON.stringify({ checks: [{ name: 'bundle_identity', status: 'pass', data: {
      bundle_identifier: 'cn.pilotdeck.desktop', identity_source: 'parent_application', parent_process_id: process.ppid,
    } }] }));
    process.exit(0);
  }
  console.log(JSON.stringify({ accessibility: true, screen_recording: true, source: {
    attribution: 'host', host_bundle_id: 'cn.pilotdeck.desktop', pid: Number(fs.readFileSync(pidFile, 'utf8')),
  } }));
} else { process.exit(1); }
