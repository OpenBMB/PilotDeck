import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import router from './commands.js';

async function postRoute(routePath, body = {}) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route?.methods?.post,
  );
  if (!layer) {
    throw new Error(`POST ${routePath} handler not found`);
  }

  let statusCode = 200;
  let payload;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };

  await layer.route.stack[0].handle({ body }, response);
  return { statusCode, payload };
}

describe('commands route skill discovery', () => {
  it('uses PILOT_HOME for user commands and skill commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pilotdeck-command-list-'));
    const previousHome = process.env.HOME;
    const previousPilotHome = process.env.PILOT_HOME;

    try {
      const defaultHome = join(root, 'default-home');
      const pilotHome = join(root, 'pilot-home');
      const defaultSkill = join(defaultHome, '.pilotdeck', 'skills', 'home_only_repro');
      const pilotSkill = join(pilotHome, 'skills', 'pilot_only_repro');
      const pilotCommandDir = join(pilotHome, 'commands');
      mkdirSync(defaultSkill, { recursive: true });
      mkdirSync(pilotSkill, { recursive: true });
      mkdirSync(pilotCommandDir, { recursive: true });
      writeFileSync(join(defaultSkill, 'SKILL.md'), '# Home only repro\n', 'utf8');
      writeFileSync(join(pilotSkill, 'SKILL.md'), '# Pilot only repro\n', 'utf8');
      writeFileSync(join(pilotCommandDir, 'pilot_command_repro.md'), 'Pilot command\n', 'utf8');

      process.env.HOME = defaultHome;
      process.env.PILOT_HOME = pilotHome;

      const { statusCode, payload } = await postRoute('/list');
      const customNames = payload.custom.map((cmd) => cmd.name);

      expect(statusCode).toBe(200);
      expect(customNames).toContain('/pilot_only_repro');
      expect(customNames).toContain('/pilot_command_repro');
      expect(customNames).not.toContain('/home_only_repro');

      const pilotSkillCommand = payload.custom.find((cmd) => cmd.name === '/pilot_only_repro');
      const loadedSkill = await postRoute('/load', {
        commandPath: pilotSkillCommand.path,
      });

      expect(loadedSkill.statusCode).toBe(200);
      expect(loadedSkill.payload.content.trim()).toBe('# Pilot only repro');

      const skillExecution = await postRoute('/execute', {
        commandName: '/pilot_only_repro',
        commandPath: pilotSkillCommand.path,
        context: {},
      });

      expect(skillExecution.statusCode).toBe(200);
      expect(skillExecution.payload.content).toBe('/pilot_only_repro');
      expect(skillExecution.payload.metadata).toEqual({ type: 'skill', passthrough: true });

      const pilotCommand = payload.custom.find((cmd) => cmd.name === '/pilot_command_repro');
      const commandExecution = await postRoute('/execute', {
        commandName: '/pilot_command_repro',
        commandPath: pilotCommand.path,
        context: {},
      });

      expect(commandExecution.statusCode).toBe(200);
      expect(commandExecution.payload.content.trim()).toBe('Pilot command');
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }

      if (previousPilotHome === undefined) {
        delete process.env.PILOT_HOME;
      } else {
        process.env.PILOT_HOME = previousPilotHome;
      }

      rmSync(root, { recursive: true, force: true });
    }
  });
});
