// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageStatsReader } from './usageStats.js';

describe('daily usage reader', () => {
    it('preserves legacy history byte-for-byte across reader upgrades and restarts', async () => {
        const home = await mkdtemp(join(tmpdir(), 'usage-upgrade-'));
        try {
            const directory = join(home, 'usage/daily');
            await mkdir(directory, { recursive: true });
            const original = { '2024-02-29.jsonl': '100\n0\n25\n', '2025-12-31.jsonl': '7\r\n8\r\n', '2026-01-01.jsonl': '10\n' };
            for (const [file, content] of Object.entries(original)) await writeFile(join(directory, file), content);
            const before = await createUsageStatsReader(home)();
            const restarted = createUsageStatsReader(home);
            expect(await restarted()).toMatchObject({ days: before.days, totalTokens: 150, totalCalls: 6 });
            expect((await readdir(directory)).sort()).toEqual(Object.keys(original).sort());
            for (const [file, content] of Object.entries(original)) expect(await readFile(join(directory, file), 'utf8')).toBe(content);
            await appendFile(join(directory, '2026-01-01.jsonl'), '50\n');
            expect(await restarted()).toMatchObject({ totalTokens: 200, totalCalls: 7 });
            expect(await readFile(join(directory, '2024-02-29.jsonl'), 'utf8')).toBe(original['2024-02-29.jsonl']);
        } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('aggregates full history, refreshes appends, and uses Beijing midnight', async () => {
        const home = await mkdtemp(join(tmpdir(), 'usage-reader-'));
        try {
            const dir = join(home, 'usage/daily');
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, '2026-10-11.jsonl'), '10\n20\ninvalid\n-1\n');
            await writeFile(join(dir, '2026-10-12.jsonl'), '5\n'.repeat(1500));
            await writeFile(join(dir, 'unrelated.txt'), '99999\n');
            const reader = createUsageStatsReader(home, () => new Date('2026-10-12T16:00:00Z'));
            const result = await reader();
            expect(result.today).toBe('2026-10-13');
            expect(result.totalTokens).toBe(7530);
            expect(result.totalCalls).toBe(1502);
            expect(result.days[1]).toEqual({ date: '2026-10-12', tokens: 7500, callCount: 1500 });
            await appendFile(join(dir, '2026-10-12.jsonl'), '100\n');
            const refreshed = await reader();
            expect(refreshed.totalTokens).toBe(7630);
            expect((await createUsageStatsReader(home)()).totalTokens).toBe(7630);
        } finally { await rm(home, { recursive: true, force: true }); }
    });
    it('returns an empty snapshot before the first call', async () => {
        const home = await mkdtemp(join(tmpdir(), 'usage-empty-'));
        try {
            expect(await createUsageStatsReader(home)()).toMatchObject({ days: [], totalTokens: 0, totalCalls: 0 });
        } finally { await rm(home, { recursive: true, force: true }); }
    });
});
