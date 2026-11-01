// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectId, createCollisionResistantProjectId } from '../utils/pilotPaths.js';
import { resolveRegisteredProject } from './projectRegistration.js';

const cleanups = [];
afterEach(async () => { for (const root of cleanups.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'registration'));
  cleanups.push(root);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace-with-dashes');
  await fs.mkdir(workspace);
  const register = async (workspace, id = createProjectId(workspace), marker = true) => {
    const storage = path.join(home, 'projects', id);
    await fs.mkdir(storage, { recursive: true });
    if (marker) await fs.writeFile(path.join(storage, '.cwd'), workspace);
    return { id, storage };
  };
  return { root, home, workspace, register };
}

describe('registered project resolution', () => {
  it('rejects absolute and dash injection, empty values and path components', async () => {
    const f = await fixture();
    for (const name of ['', undefined, {}, '/etc', f.workspace, '-etc', '..', '../home', 'foo\\bar', 'x\0y']) {
      await expect(resolveRegisteredProject(name, f.home)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    }
    expect(await resolveRegisteredProject('general', f.home)).toBe(f.home);
    expect(await resolveRegisteredProject(f.home, f.home)).toBe(f.home);
  });
  it('supports current and collision IDs and revalidates markers on every access', async () => {
    const f = await fixture();
    const { id, storage } = await f.register(f.workspace);
    expect(await resolveRegisteredProject(id, f.home)).toBe(f.workspace);
    expect(await resolveRegisteredProject(f.workspace, f.home)).toBe(f.workspace);
    const other = path.join(f.root, 'other');
    await fs.mkdir(other);
    await fs.writeFile(path.join(storage, '.cwd'), other);
    await expect(resolveRegisteredProject(f.workspace, f.home)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(await resolveRegisteredProject(id, f.home)).toBe(other);
    await fs.rm(storage, { recursive: true });
    await expect(resolveRegisteredProject(id, f.home)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    const collision = await f.register(f.workspace, createCollisionResistantProjectId(f.workspace));
    expect(await resolveRegisteredProject(collision.id, f.home)).toBe(f.workspace);
    await expect(resolveRegisteredProject(collision.id, path.join(f.root, 'other-home'))).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
  it('decodes legacy IDs only with real registration and rejects invalid present markers', async () => {
    const f = await fixture();
    const legacy = path.join(await fs.realpath(f.root), 'legacy');
    await fs.mkdir(legacy);
    const { id, storage } = await f.register(legacy, createProjectId(legacy), false);
    expect(await resolveRegisteredProject(id, f.home)).toBe(legacy);
    for (const marker of ['', 'relative']) {
      await fs.writeFile(path.join(storage, '.cwd'), marker);
      await expect(resolveRegisteredProject(id, f.home)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    }
    await fs.rm(storage, { recursive: true });
    await fs.symlink(legacy, storage);
    await expect(resolveRegisteredProject(id, f.home)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
  it('resolves registered identities after the workspace is removed', async () => {
    const f = await fixture();
    const { id } = await f.register(f.workspace);
    await fs.rm(f.workspace, { recursive: true });
    expect(await resolveRegisteredProject(id, f.home)).toBe(f.workspace);
    expect(await resolveRegisteredProject(f.workspace, f.home)).toBe(f.workspace);
  });
});
