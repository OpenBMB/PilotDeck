// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageStatsReader } from './usageStats.js';

describe('daily usage reader', () => {
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
