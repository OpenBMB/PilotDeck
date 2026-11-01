import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanFileManager } from '../../../src/tool/builtin/planFile.js';
import { createWriteFileTool } from '../../../src/tool/builtin/writeFile.js';
import { createExitPlanModeTool } from '../../../src/tool/builtin/planMode.js';
import { ToolRegistry } from '../../../src/tool/registry/ToolRegistry.js';
import { ToolRuntime } from '../../../src/tool/execution/ToolRuntime.js';
import { PermissionRuntime } from '../../../src/permission/decision/PermissionRuntime.js';
import { createDefaultPermissionContext } from '../../../src/permission/index.js';
import type { PilotDeckToolRuntimeContext } from '../../../src/tool/protocol/types.js';

test('desktop general chat writes in its designated plan directory and reaches approval without opening other writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pilotdeck-plan-notification-'));
  try {
    const cwd = join(root, 'Program Files', 'PilotDeck', 'resources', 'runtime');
    mkdirSync(cwd, { recursive: true });
    const manager = createPlanFileManager({ projectRoot: cwd, pilotHome: join(root, 'home'), env: { PILOTDECK_DESKTOP: '1' } });
    const planDir = manager.getPlanDirectoryPath();
    const planPath = join(planDir, 'notification-test.md');
    const registry = new ToolRegistry();
    registry.register(createWriteFileTool());
    registry.register(createExitPlanModeTool());
    const runtime = new ToolRuntime(registry, new PermissionRuntime());
    let submittedPlan: unknown;
    const context: PilotDeckToolRuntimeContext = {
      sessionId: 'notification-test', turnId: 'plan-test', cwd, permissionMode: 'plan',
      permissionContext: createDefaultPermissionContext({ cwd, mode: 'plan', canPrompt: true, bypassAvailable: false, planDirectoryPath: planDir }),
      planDirectory: { path: planDir, resolve: file => manager.resolvePlanFilePath(file, cwd), read: file => manager.readPlanFile(file, cwd) },
      elicitation: { askUser: async request => { submittedPlan = request.metadata?.plan; return { type: 'cancelled' }; } },
    };
    const outside = await runtime.execute({ id: 'wrong', name: 'write_file', input: { file_path: join(cwd, '.pilotdeck/plans/test.md'), content: 'Test' } }, context);
    assert.equal(outside.type, 'error');
    assert.ok(JSON.stringify(outside).includes(planDir), 'denial must point to the real allowed directory');
    const write = await runtime.execute({ id: 'write', name: 'write_file', input: { file_path: planPath, content: '# Notification test\nConfirm to finish.' } }, context);
    assert.equal(write.type, 'success', JSON.stringify(write));
    assert.match(readFileSync(planPath, 'utf8'), /Confirm to finish/);
    const approval = await runtime.execute({ id: 'approve', name: 'exit_plan_mode', input: { plan_file_path: planPath } }, context);
    assert.equal(approval.type, 'success', JSON.stringify(approval));
    assert.match(String(submittedPlan), /Confirm to finish/);
    const implementation = await runtime.execute({ id: 'forbidden', name: 'write_file', input: { file_path: join(cwd, 'implementation.ts'), content: 'forbidden' } }, context);
    assert.equal(implementation.type, 'error');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
