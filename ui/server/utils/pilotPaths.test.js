import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createCollisionResistantProjectId as createCoreCollisionId,
    createProjectId as createCoreProjectId,
    resolveProjectStorageId as resolveCoreProjectStorageId,
    ensurePilotProjectGitIgnore as ensureCoreGitIgnore,
} from '../../../src/pilot/paths.js';
import {
    createCollisionResistantProjectId,
    createProjectId,
    resolveProjectStorageId,
    ensurePilotProjectGitIgnore,
} from './pilotPaths.js';
import { getAlwaysOnRoot } from '../services/always-on-paths.js';

describe('UI project storage ID resolution', () => {
    it('repairs internal ignore rules identically to the core without creating metadata during Git browse', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-ui-ignore-'));
        try {
            const uiRoot = join(root, 'ui'), coreRoot = join(root, 'core');
            mkdirSync(uiRoot); mkdirSync(coreRoot);
            ensurePilotProjectGitIgnore(uiRoot, false);
            expect(existsSync(join(uiRoot, '.pilotdeck'))).toBe(false);
            for (const project of [uiRoot, coreRoot]) {
                mkdirSync(join(project, '.pilotdeck'));
                writeFileSync(join(project, '.pilotdeck', '.gitignore'), '# existing\n*.tmp\n!keep.txt');
            }
            ensurePilotProjectGitIgnore(uiRoot, false);
            ensureCoreGitIgnore(coreRoot, false);
            const expected = readFileSync(join(coreRoot, '.pilotdeck', '.gitignore'), 'utf8');
            expect(readFileSync(join(uiRoot, '.pilotdeck', '.gitignore'), 'utf8')).toBe(expected);
            ensurePilotProjectGitIgnore(uiRoot, false);
            expect(readFileSync(join(uiRoot, '.pilotdeck', '.gitignore'), 'utf8')).toBe(expected);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
    it('matches the core resolver for colliding non-ASCII workspaces', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-ui-project-id-'));
        try {
            const pilotHome = join(root, 'pilot-home');
            const projectA = join(root, 'home', '内部测试');
            const projectB = join(root, 'home', '会议纪要');
            mkdirSync(projectA, { recursive: true });
            mkdirSync(projectB, { recursive: true });

            const legacyId = createProjectId(projectA);
            const collisionId = createCollisionResistantProjectId(projectB);
            expect(createProjectId(projectB)).toBe(legacyId);

            mkdirSync(join(pilotHome, 'projects', legacyId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', legacyId, '.cwd'), projectA, 'utf8');
            mkdirSync(join(pilotHome, 'projects', collisionId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', collisionId, '.cwd'), projectB, 'utf8');

            expect(createProjectId(projectA)).toBe(createCoreProjectId(projectA));
            expect(collisionId).toBe(createCoreCollisionId(projectB));
            expect(resolveProjectStorageId(projectA, pilotHome)).toBe(legacyId);
            expect(resolveProjectStorageId(projectB, pilotHome)).toBe(collisionId);
            expect(resolveProjectStorageId(projectA, pilotHome)).toBe(
                resolveCoreProjectStorageId(projectA, pilotHome),
            );
            expect(resolveProjectStorageId(projectB, pilotHome)).toBe(
                resolveCoreProjectStorageId(projectB, pilotHome),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('matches core fallback behavior for missing and invalid markers', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-ui-project-id-fallback-'));
        try {
            const pilotHome = join(root, 'pilot-home');
            const projectRoot = join(root, 'workspace', 'ascii-project');
            mkdirSync(projectRoot, { recursive: true });

            const invalidId = createCollisionResistantProjectId(projectRoot);
            mkdirSync(join(pilotHome, 'projects', invalidId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', invalidId, '.cwd'), join(root, 'missing'), 'utf8');

            expect(resolveProjectStorageId(projectRoot, pilotHome)).toBe(createProjectId(projectRoot));
            expect(resolveProjectStorageId(projectRoot, pilotHome)).toBe(
                resolveCoreProjectStorageId(projectRoot, pilotHome),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('uses the resolved storage ID for the UI Always-On root', () => {
        const root = mkdtempSync(join(tmpdir(), 'pilotdeck-ui-always-on-root-'));
        const previousPilotHome = process.env.PILOT_HOME;
        try {
            const pilotHome = join(root, 'pilot-home');
            const projectRoot = join(root, 'home', '会议纪要');
            const projectId = createCollisionResistantProjectId(projectRoot);
            mkdirSync(projectRoot, { recursive: true });
            mkdirSync(join(pilotHome, 'projects', projectId), { recursive: true });
            writeFileSync(join(pilotHome, 'projects', projectId, '.cwd'), projectRoot, 'utf8');
            process.env.PILOT_HOME = pilotHome;

            expect(getAlwaysOnRoot(projectRoot)).toBe(
                join(pilotHome, 'always-on', 'projects', projectId),
            );
        } finally {
            if (previousPilotHome === undefined) {
                delete process.env.PILOT_HOME;
            } else {
                process.env.PILOT_HOME = previousPilotHome;
            }
            rmSync(root, { recursive: true, force: true });
        }
    });
});
