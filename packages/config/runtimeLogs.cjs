const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LOG_RETENTION_DAYS = Object.freeze([1, 3, 7, 30, 90]);
const writers = new Set();
let retentionDays = 7;
function normalizeLogRetentionDays(value) {
  return LOG_RETENTION_DAYS.includes(value) ? value : 7;
}
function setRuntimeLogRetention(value) {
  retentionDays = normalizeLogRetentionDays(value);
  for (const writer of writers) writer.setRetentionDays(retentionDays);
  return retentionDays;
}
const day = date => date.toISOString().slice(0, 10);

// One owner per file: desktop captures its children's output; standalone
// processes use their own logger. Never delete files outside this log directory.
function createRuntimeLogWriter(logPath, options = {}) {
  logPath = path.resolve(logPath);
  const directory = path.dirname(logPath), stem = path.basename(logPath, '.log');
  const now = options.now || (() => new Date());
  let keep = normalizeLogRetentionDays(options.retentionDays ?? retentionDays);
  let activeDay, fd, closed = false;
  const closeFile = () => { if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } };
  const prune = () => {
    try {
      const cutoff = day(new Date(now().getTime() - (keep - 1) * 86400000));
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const match = entry.name.match(/^(?:runtime|renderer)-(\d{4}-\d{2}-\d{2})-[\da-f-]+\.log$/);
        if (match && match[1] < cutoff) fs.unlinkSync(path.join(directory, entry.name));
      }
      const reports = path.join(directory, 'diagnostics');
      if (fs.existsSync(reports) && !fs.lstatSync(reports).isSymbolicLink()) {
        for (const entry of fs.readdirSync(reports, { withFileTypes: true })) {
          if (!entry.isFile() || !/^(gateway|server|desktop)-[\da-f-]+\.json$/.test(entry.name)) continue;
          const file = path.join(reports, entry.name);
          if (day(fs.statSync(file).mtime) < cutoff) fs.unlinkSync(file);
        }
      }
    } catch { /* Optional maintenance must never prevent startup. */ }
  };
  const open = () => {
    const today = day(now());
    if (activeDay === today && fd !== undefined) return;
    closeFile();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(logPath)) {
      const stat = fs.lstatSync(logPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid runtime log file');
      const previousDay = activeDay || day(stat.mtime);
      if (previousDay !== today) fs.renameSync(logPath, path.join(directory, `${stem}-${previousDay}-${randomUUID()}.log`));
    }
    activeDay = today;
    fd = fs.openSync(logPath, 'a', 0o600);
    prune();
  };
  const writer = {
    write(text) {
      if (closed) return false;
      try { open(); fs.writeSync(fd, text); return true; }
      catch { try { closeFile(); } catch {} return false; }
    },
    setRetentionDays(value) { keep = normalizeLogRetentionDays(value); prune(); },
    close() { closed = true; clearInterval(timer); writers.delete(writer); try { closeFile(); } catch {} },
  };
  const timer = setInterval(() => { try { open(); prune(); } catch {} }, 60 * 60 * 1000);
  timer.unref();
  writers.add(writer);
  try { open(); } catch { /* Retry on the next write. */ }
  return writer;
}

module.exports = { LOG_RETENTION_DAYS, normalizeLogRetentionDays, setRuntimeLogRetention, createRuntimeLogWriter };
