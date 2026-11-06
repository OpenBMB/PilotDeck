import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Native packaging is expensive; ordinary TS/React changes are already built
// and exercised by Web Regression and the cross-platform checkpoint suite.
export function needsNativePackaging(files) {
  return files.some(file => /^(apps\/desktop\/|packages\/|resources\/|skills\/|scripts\/|\.github\/workflows\/(desktop-|release(?:-retry)?\.yml$))/.test(file)
    || /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|\.npmrc)$/.test(file)
    || /^ui\/(package\.json|vite\.config\.|shared\/releaseArtifacts\.|server\/(supervisedBootstrap|webRuntimeSupervisor|services\/(runtimeCoordination|computerUse|updateRuntime)))/.test(file));
}

const dependencyInput = file => /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|\.npmrc|ui\/package\.json)$/.test(file);
const sharedAppearance = file => /^apps\/desktop\/src\/(lightAppearance|interfacePreferences|appearance|startupPresentation|startupStyle)\./.test(file);
const routingInput = file => /^apps\/desktop\/scripts\/classify-ci-changes(?:\.test)?\.mjs$/.test(file);
const documentation = file => /^(docs\/|README[^/]*\.md$|CONTRIBUTING\.md$|AGENTS\.md$)/.test(file)
  || ['apps/desktop/README.md', 'ui/README.md', 'src/README.md'].includes(file)
  || /^\.github\/scripts\/[^/]+\.md$/.test(file);

/** Select execution boundaries, not individual tests; relevant suites stay intact. */
export function classifyCiChanges(files) {
  const changed = files.filter(file => file && !documentation(file));
  const shared = changed.some(file => dependencyInput(file) || routingInput(file) || file.startsWith('packages/'));
  const webWorkflow = changed.includes('.github/workflows/web-regression.yml');
  return {
    packaging: needsNativePackaging(changed),
    checks: shared || needsNativePackaging(changed) || changed.some(file => /^ui\/(server\/services\/(desktop|jsonReleaseProvider)|shared\/(releaseArtifacts|desktopUpdate))/.test(file)),
    checkpoints: shared || changed.some(file => /^(src\/|tests\/|packages\/|scripts\/|ui\/(server\/|shared\/))/.test(file)
      || /^ui\/src\/(components\/(chat-review\/|settings\/view\/computerUse\/)|utils\/workspaceFileMention\.)/.test(file)
      || /^apps\/desktop\/(src\/computerUse|scripts\/computer-use)/.test(file)
      || file === '.github/workflows/desktop-smoke.yml'),
    web: shared || webWorkflow || changed.some(file => /^(ui\/|src\/|tests\/|packages\/|scripts\/|skills\/|resources\/)/.test(file) || sharedAppearance(file)),
    browser: shared || webWorkflow || changed.some(file => /^ui\/(src\/|e2e\/|shared\/|vite\.config\.)/.test(file) || sharedAppearance(file)),
    docker: shared || webWorkflow || changed.some(file => /^(Dockerfile|\.dockerignore|docker-entrypoint\.sh|docker-compose[^/]*|compose[^/]*)$/.test(file)
      || /^(src\/|packages\/|scripts\/|skills\/|resources\/|ui\/(server\/|shared\/|scripts\/|vite\.config\.))/.test(file)
      || sharedAppearance(file) || file === '.github/workflows/docker-build.yml'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head || !/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Error('Expected base and head commit SHAs');
  // Include both sides of renames and compare the PR's actual merge-base.
  const files = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const scopes = classifyCiChanges(files);
  console.log(JSON.stringify(scopes));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scopes).map(([name, value]) => `${name}=${value}\n`).join(''));
}
