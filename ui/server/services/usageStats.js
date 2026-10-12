import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { resolvePilotHome } from '../utils/pilotPaths.js';

const timeZone = 'Asia/Shanghai';
const dayFormatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Cache daily totals; unchanged historical files are never rescanned. */
export function createUsageStatsReader(pilotHome = resolvePilotHome(), now = () => new Date()) {
    const directory = join(pilotHome, 'usage', 'daily');
    const cache = new Map();
    let inFlight;
    async function read() {
        let names;
        try { names = await readdir(directory); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            names = [];
        }
        const days = [];
        for (const name of names.sort()) {
            if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
            const file = join(directory, name);
            const info = await stat(file);
            if (!info.isFile()) continue;
            const cached = cache.get(name);
            let day;
            if (cached?.size === info.size && cached?.mtimeMs === info.mtimeMs) {
                day = cached.day;
            } else {
                day = { date: name.slice(0, 10), tokens: 0, callCount: 0 };
                // Bound the read to a snapshot, so a concurrent append isn't
                // counted twice or cached under the wrong file size.
                if (info.size > 0) {
                    const stream = createReadStream(file, { encoding: 'utf8', end: info.size - 1 });
                    const lines = createInterface({ input: stream, crlfDelay: Infinity });
                    stream.on('error', error => lines.emit('error', error));
                    try {
                        for await (const line of lines) {
                            if (!/^\d+$/.test(line)) continue;
                            const tokens = Number(line);
                            if (!Number.isSafeInteger(tokens)) continue;
                            day.tokens += tokens;
                            day.callCount += 1;
                        }
                    } finally { lines.close(); stream.destroy(); }
                }
                cache.set(name, { size: info.size, mtimeMs: info.mtimeMs, day });
            }
            days.push(day);
        }
        const timestamp = now();
        return {
            timeZone,
            today: dayFormatter.format(timestamp),
            days,
            totalTokens: days.reduce((sum, day) => sum + day.tokens, 0),
            totalCalls: days.reduce((sum, day) => sum + day.callCount, 0),
            updatedAt: timestamp.toISOString(),
        };
    }
    return () => {
        inFlight ??= read().finally(() => { inFlight = undefined; });
        return inFlight;
    };
}
