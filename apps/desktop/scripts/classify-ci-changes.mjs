import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Native packaging is expensive; ordinary TS/React changes are already built
// and exercised by Web Regression and the cross-platform checkpoint suite.
export function needsNativePackaging(files) {
  return files.some(file => /^(apps\/desktop\/|packages\/|resources\/|skills\/|scripts\/|\.github\/workflows\/desktop-|\.github\/workflows\/release)/.test(file)
    || /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json)$/.test(file)
    || /^ui\/(package\.json|vite\.config\.|server\/(supervisedBootstrap|webRuntimeSupervisor|services\/(runtimeCoordination|computerUse|updateRuntime)))/.test(file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Error('Expected base and head commit SHAs');
  const files = execFileSync('git', ['diff', '--name-only', base, head], { encoding: 'utf8' }).trim().split(/\r?\n/);
  const packaging = needsNativePackaging(files);
  console.log(`Native packaging required: ${packaging}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `packaging=${packaging}\n`);
}
