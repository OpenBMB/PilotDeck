import { test } from '@playwright/test';
import { memoryScheduleCases, verifyMemoryScheduleSettings } from './memory-schedule-settings.smoke.mjs';

for (const fixture of memoryScheduleCases) {
  test(`memory and scheduling controls: ${fixture.join('/')}`, async ({ browser, baseURL }, info) => {
    test.setTimeout(90000);
    await verifyMemoryScheduleSettings({ browser, base: baseURL, output: info.outputPath('settings'), cases: [fixture] });
  });
}
