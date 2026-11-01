// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enCommon from '../../i18n/locales/en/common.json';
import SkillsV2 from './SkillsV2';
import { splitSkillDocument } from './skillDocument';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn() }));
vi.mock('../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('../ui/ConfirmDialog', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    editable,
  }: {
    value: string;
    onChange: (value: string) => void;
    editable: boolean;
  }) => (
    <textarea
      aria-label="Skill source"
      value={value}
      readOnly={!editable}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options: Record<string, unknown> = {}) => {
      let value: unknown = enCommon;
      for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
      return String(value || options.defaultValue || key).replace(/{{(\w+)}}/g, (_, name) =>
        String(options[name] ?? ''),
      );
    },
  }),
}));

const content =
  '---\nname: core\ndescription: "Keep this metadata"\n---\n\n# Rendered instructions\n\n- First step\n\n| Name | Value |\n| --- | --- |\n| mode | safe |\n\n```bash\necho hello\n```\n';
const builtin = {
  slug: 'core',
  name: 'Core skill',
  description: 'Built-in workflow',
  scope: 'builtin',
  readonly: true,
  skillDir: '/bundled/core',
  skillFile: '/bundled/core/SKILL.md',
  version: null,
  mtime: null,
};
const global = {
  ...builtin,
  slug: 'global-work',
  name: 'Global workflow',
  description: 'Shared across projects',
  scope: 'user',
  readonly: false,
  skillDir: '/home/skills/global-work',
};
const projectSkill = {
  ...global,
  slug: 'project-work',
  name: 'Project workflow',
  scope: 'project',
  skillDir: '/project/.pilotdeck/skills/project-work',
};
const project = { name: 'project', displayName: 'My project', fullPath: '/project' };
const response = (data: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 422,
  json: async () => data,
});
let list: {
  builtin: (typeof builtin)[];
  user: (typeof global)[];
  project: (typeof projectSkill)[];
  projectPath: string | null;
  isGeneralCwd: boolean;
};

beforeEach(() => {
  list = {
    builtin: [builtin],
    user: [],
    project: [],
    projectPath: '/project',
    isGeneralCwd: false,
  };
  mocks.confirm.mockResolvedValue(true);
  mocks.fetch.mockImplementation(async (url: string) =>
    response(url.endsWith('/list') ? list : url.endsWith('/read') ? { content } : {}),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('skills reading workbench', () => {
  it('renders Markdown and keeps a built-in source read-only', async () => {
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    expect(await screen.findByRole('heading', { name: 'Rendered instructions' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy();
    expect(within(screen.getByRole('article')).queryByText('Keep this metadata')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    const source = screen.getByRole('textbox', { name: 'Skill source' }) as HTMLTextAreaElement;
    expect(source.readOnly).toBe(true);
    expect(source.value).toBe(content);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('searches descriptions and filters scopes without requiring a selected project', async () => {
    list.user = [global];
    render(<SkillsV2 selectedProject={null} projects={[]} />);
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Global' }));
    const skillList = within(screen.getByRole('complementary', { name: 'Skill list' }));
    expect(skillList.getByRole('button', { name: /^Global workflow Shared/ })).toBeTruthy();
    expect(skillList.queryByRole('button', { name: /Core skill/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search names or descriptions…' }), {
      target: { value: 'shared across' },
    });
    expect(skillList.getByRole('button', { name: /^Global workflow Shared/ })).toBeTruthy();
    expect((skillList.getByRole('button', { name: 'Project' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('retains the draft when switching is cancelled or saving fails', async () => {
    list.project = [projectSkill];
    mocks.confirm.mockResolvedValue(false);
    mocks.fetch.mockImplementation(async (url: string) =>
      response(
        url.endsWith('/list')
          ? list
          : url.endsWith('/read')
            ? { content }
            : { error: 'Description is required' },
        !url.endsWith('/write'),
      ),
    );
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced source' }));
    const draft = content + '\nDraft changes';
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill source' }), {
      target: { value: draft },
    });
    fireEvent.click(screen.getByRole('button', { name: /Core skill Built-in workflow/ }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(
      (screen.getByRole('textbox', { name: 'Skill source' }) as HTMLTextAreaElement).value,
    ).toBe(draft);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Description is required', { selector: '.skills-inline-error' });
    expect(
      (screen.getByRole('textbox', { name: 'Skill source' }) as HTMLTextAreaElement).value,
    ).toBe(draft);
    const write = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/write'));
    expect(JSON.parse(write![1].body).content).toBe(draft);
  });

  it('does not reload an edited document when list metadata is refreshed', async () => {
    list.user = [global];
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill source' }), {
      target: { value: content + '\nDraft' },
    });
    list = { ...list, user: [{ ...global, description: 'Updated metadata' }] };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findAllByText('Updated metadata');
    expect(
      (screen.getByRole('textbox', { name: 'Skill source' }) as HTMLTextAreaElement).value,
    ).toBe(content + '\nDraft');
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/read'))).toHaveLength(1);
  });

  it('preserves the destination and create form while switching add methods', async () => {
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    await screen.findByRole('dialog', { name: 'Add skill' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add to' }), {
      target: { value: 'user' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Create skill' }));
    const create = within(screen.getByRole('tabpanel', { name: 'Create skill' }));
    fireEvent.change(create.getByLabelText('Skill identifier'), {
      target: { value: 'report-writer' },
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Import folder' }));
    expect((screen.getByRole('combobox', { name: 'Add to' }) as HTMLSelectElement).value).toBe(
      'user',
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Create skill' }));
    expect((create.getByLabelText('Skill identifier') as HTMLInputElement).value).toBe(
      'report-writer',
    );
  });

  it('restores an unsaved draft after navigating away and reopening the workbench', async () => {
    list.user = [{ ...global, skillDir: '/home/skills/navigation-draft' }];
    const first = render(<SkillsV2 selectedProject={project} projects={[project]} />);
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Advanced source' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill source' }), {
      target: { value: content + '\nPreserved draft' },
    });
    first.unmount();
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    await screen.findByRole('button', { name: 'Advanced source' });
    fireEvent.click(screen.getByRole('button', { name: 'Advanced source' }));
    const source = screen.getByRole('textbox', { name: 'Skill source' });
    expect((source as HTMLTextAreaElement).value).toBe(content + '\nPreserved draft');
    expect((source as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it('creates a project custom version without overwriting an existing skill', async () => {
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Create custom version' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Create custom version' }));
    expect((dialog.getByRole('combobox', { name: 'Add to' }) as HTMLSelectElement).value).toBe(
      'project',
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Create custom version' }));
    await waitFor(() =>
      expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/import'))).toBe(true),
    );
    const call = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/import'));
    expect(JSON.parse(call![1].body)).toMatchObject({
      scope: 'project',
      projectPath: '/project',
      mode: 'copy',
      force: false,
    });
  });

  it('previews marketplace instructions and installs the reviewed version into the selected scope', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      response(
        url.endsWith('/list')
          ? list
          : url.endsWith('/search')
            ? { results: [{ slug: 'external', name: 'External skill', score: null }] }
            : url.endsWith('/inspect')
              ? { content, version: '1.2.3' }
              : url.endsWith('/install')
                ? { installed: true, slug: 'external', scope: 'user', skill: null }
                : { content },
      ),
    );
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    await screen.findByRole('dialog', { name: 'Add skill' });
    const dialog = within(screen.getByRole('dialog', { name: 'Add skill' }));
    expect((dialog.getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(dialog.getByRole('textbox', { name: 'Search skills on ClawHub…' }), {
      target: { value: 'external' },
    });
    fireEvent.click(await dialog.findByRole('button', { name: 'Read instructions' }));
    await dialog.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.change(dialog.getByRole('combobox', { name: 'Add to' }), {
      target: { value: 'user' },
    });
    fireEvent.click(dialog.getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/install'))).toBe(true),
    );
    const call = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/install'));
    expect(JSON.parse(call![1].body)).toMatchObject({
      slug: 'external',
      version: '1.2.3',
      scope: 'user',
      projectPath: null,
      force: false,
    });
  });
});

describe('skill document metadata', () => {
  it('handles BOM, CRLF and multiline YAML while preserving the body verbatim', () => {
    const body = '\r\n# Instructions\r\n\r\nKeep **Markdown**.\r\n';
    const result = splitSkillDocument(
      '\uFEFF---\r\nname: report\r\ndescription: |\r\n  First line\r\n  Second line\r\n---\r\n' +
        body,
    );
    expect(result.body).toBe(body);
    expect(result.metadata.description).toBe('First line\nSecond line\n');
  });
  it('keeps malformed metadata and Markdown horizontal rules visible', () => {
    for (const source of ['---\nname: [broken\n---\n# Body', '---\nSome text\n---\n# Body'])
      expect(splitSkillDocument(source).body).toBe(source);
  });
});

describe('skill workbench completion flows', () => {
  it('disables editing after a failed read and restores it after retry', async () => {
    list.user = [{ ...global, skillDir: '/home/skills/retry-read' }];
    let failed = true;
    mocks.fetch.mockImplementation(async (url: string) =>
      response(
        url.endsWith('/list')
          ? list
          : url.endsWith('/read')
            ? failed
              ? { error: 'Read unavailable' }
              : { content }
            : {},
        !url.endsWith('/read') || !failed,
      ),
    );
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    await screen.findByText('Read unavailable', { selector: '.skills-inline-error' });
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('keeps the filled new-skill form when closing is cancelled', async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    const modal = within(await screen.findByRole('dialog', { name: 'Add skill' }));
    fireEvent.click(modal.getByRole('tab', { name: 'Create skill' }));
    fireEvent.change(modal.getByLabelText('Skill identifier'), {
      target: { value: 'new-workflow' },
    });
    fireEvent.click(modal.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect((modal.getByLabelText('Skill identifier') as HTMLInputElement).value).toBe(
      'new-workflow',
    );
    mocks.confirm.mockResolvedValue(true);
    fireEvent.click(modal.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('guards an unsaved draft before changing the project context', async () => {
    list.user = [{ ...global, skillDir: '/home/skills/project-switch-draft' }];
    mocks.confirm.mockResolvedValue(false);
    const other = { name: 'other', displayName: 'Other', fullPath: '/other' };
    const onProjectChange = vi.fn();
    const view = render(
      <SkillsV2
        selectedProject={project}
        projects={[project, other]}
        onProjectChange={onProjectChange}
      />,
    );
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Draft description' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Switch skill project' }), {
      target: { value: 'other' },
    });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(onProjectChange).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Switch skill project' }), {
      target: { value: 'other' },
    });
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith(other));
    view.rerender(
      <SkillsV2
        selectedProject={other}
        projects={[project, other]}
        onProjectChange={onProjectChange}
      />,
    );
    await waitFor(() =>
      expect(
        mocks.fetch.mock.calls.some(
          ([url, options]) =>
            url.endsWith('/list') && JSON.parse(options.body).projectPath === '/other',
        ),
      ).toBe(true),
    );
  });

  it('hands the reviewed skill to a conversation without submitting any input', async () => {
    const onUseSkill = vi.fn();
    render(<SkillsV2 selectedProject={project} projects={[project]} onUseSkill={onUseSkill} />);
    await screen.findByRole('heading', { name: 'Rendered instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Use in conversation' }));
    await waitFor(() =>
      expect(onUseSkill).toHaveBeenCalledWith(
        { slug: 'core', name: 'Core skill', command: '/core' },
        project,
      ),
    );
    expect(
      mocks.fetch.mock.calls.every(([url]) =>
        ['/api/skills/list', '/api/skills/read', '/api/skills/documents'].includes(url),
      ),
    ).toBe(true);
  });

  it('opens local references in the reader and assigns distinct heading anchors', async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      response(
        url.endsWith('/list')
          ? list
          : url.endsWith('/read')
            ? {
                content:
                  '# Guide\n\n## Workflow\n\n## Workflow\n\n[Reference](references/guide.md)',
              }
            : url.endsWith('/documents')
              ? { files: ['SKILL.md', 'references/guide.md'] }
              : { content: '# Reference instructions\n\nDetails' },
      ),
    );
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    await screen.findByRole('link', { name: 'Reference' });
    expect(
      screen.getAllByRole('heading', { name: 'Workflow' }).map((heading) => heading.id),
    ).toEqual(['workflow', 'workflow-1']);
    expect(await screen.findByText(/Contents/, { selector: 'summary' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Reference' }));
    await screen.findByRole('heading', { name: 'Reference instructions' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to skill' }));
    await screen.findByRole('heading', { name: 'Guide' });
  });

  it('retains partial batch results and retries only failed candidates', async () => {
    let failing = true;
    mocks.fetch.mockImplementation(async (url: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      if (url.endsWith('/import'))
        return response(
          body.slug === 'bad' && failing ? { error: 'Already exists' } : { ok: true },
          body.slug !== 'bad' || !failing,
        );
      return response(
        url.endsWith('/list')
          ? list
          : url.endsWith('/read')
            ? { content }
            : url.endsWith('/scan')
              ? {
                  folders: ['bad', 'good'].map((folderName) => ({
                    folderName,
                    hasSkillMd: true,
                    name: folderName,
                    sourcePath: `/source/${folderName}`,
                    fileCount: 1,
                    totalSize: 100,
                  })),
                }
              : {},
      );
    });
    render(<SkillsV2 selectedProject={project} projects={[project]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }));
    const modal = within(await screen.findByRole('dialog', { name: 'Add skill' }));
    fireEvent.click(modal.getByRole('tab', { name: 'Import folder' }));
    fireEvent.change(modal.getByPlaceholderText('~/code/my-skill'), {
      target: { value: '/source' },
    });
    fireEvent.click(modal.getByRole('button', { name: 'Scan' }));
    fireEvent.click(await modal.findByRole('button', { name: 'Import 2 skills' }));
    await modal.findByText('Already exists');
    expect(screen.getByRole('dialog', { name: 'Add skill' })).toBeTruthy();
    failing = false;
    fireEvent.click(modal.getByRole('button', { name: 'Retry failed items' }));
    await waitFor(() =>
      expect(modal.queryByRole('button', { name: 'Retry failed items' })).toBeNull(),
    );
    expect(
      mocks.fetch.mock.calls.filter(
        ([url, options]) => url.endsWith('/import') && JSON.parse(options.body).slug === 'good',
      ),
    ).toHaveLength(1);
    await modal.findByRole('button', { name: 'Done' });
    fireEvent.click(modal.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

it('keeps the chosen document when general context finishes loading', async () => {
  list.builtin = [
    builtin,
    { ...builtin, slug: 'other', name: 'Other skill', skillDir: '/builtin/other' },
  ];
  const view = render(<SkillsV2 selectedProject={null} projects={[]} />);
  await screen.findByRole('heading', { name: 'Rendered instructions' });
  fireEvent.click(screen.getByRole('button', { name: /Other skill Built-in workflow/ }));
  await screen.findByRole('region', { name: 'Skill details: Other skill' });
  const general = { name: 'general', displayName: 'general', fullPath: '/home/pilotdeck' };
  view.rerender(<SkillsV2 selectedProject={general} projects={[general]} />);
  await waitFor(() =>
    expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/list')).length).toBe(2),
  );
  expect(screen.getByRole('region', { name: 'Skill details: Other skill' })).toBeTruthy();
});

function pendingRequest() {
  let resolve!: (value: ReturnType<typeof response>) => void;
  const promise = new Promise<ReturnType<typeof response>>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const otherProject = { name: 'other', displayName: 'Other', fullPath: '/other' };
function ProjectSwitchHarness() {
  const [selected, setSelected] = useState(project);
  return (
    <SkillsV2
      selectedProject={selected}
      projects={[project, otherProject]}
      onProjectChange={(next) => setSelected(next ?? project)}
    />
  );
}
function mockProjectSwitch(
  pending: ReturnType<typeof pendingRequest>,
  operation: 'delete' | 'move',
) {
  const otherDefault = {
    ...projectSkill,
    slug: 'b-default',
    name: 'B default',
    skillDir: '/other/.pilotdeck/skills/b-default',
  };
  const otherChosen = {
    ...projectSkill,
    slug: 'race-work',
    name: 'B workflow',
    skillDir: '/other/.pilotdeck/skills/race-work',
  };
  const projectA = {
    ...list,
    builtin: [],
    project: [
      { ...projectSkill, slug: 'race-work', skillDir: '/project/.pilotdeck/skills/race-work' },
    ],
  };
  const projectB = {
    ...list,
    builtin: [],
    project: [otherDefault, otherChosen],
    projectPath: '/other',
  };
  mocks.fetch.mockImplementation(async (url: string, options: { body: string }) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/list')) return response(body.projectPath === '/other' ? projectB : projectA);
    if (url.endsWith('/read')) return response({ content: '# Instructions' });
    if (operation === 'delete' && url.endsWith('/delete')) return pending.promise;
    if (operation === 'move' && url.endsWith('/import')) return pending.promise;
    return response({ ok: true });
  });
}
async function chooseBWorkflow() {
  fireEvent.change(screen.getByRole('combobox', { name: 'Switch skill project' }), {
    target: { value: 'other' },
  });
  fireEvent.click(await screen.findByRole('button', { name: /B workflow Shared across projects/ }));
  await screen.findByRole('region', { name: 'Skill details: B workflow' });
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}

it.each([
  ['detail', true],
  ['menu', true],
  ['detail', false],
  ['menu', false],
] as const)(
  'ignores a late project A %s deletion completion after selecting project B (success=%s)',
  async (entry, success) => {
    const pending = pendingRequest();
    mockProjectSwitch(pending, 'delete');
    render(<ProjectSwitchHarness />);
    await screen.findByRole('region', { name: 'Skill details: Project workflow' });
    if (entry === 'detail') fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Manage Project workflow' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    }
    await waitFor(() =>
      expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/delete'))).toBe(true),
    );
    await chooseBWorkflow();
    await act(async () => {
      pending.resolve(
        response(success ? { ok: true } : { error: 'Project A deletion failed' }, success),
      );
    });
    expect(screen.getByRole('region', { name: 'Skill details: B workflow' })).toBeTruthy();
    expect(
      (screen.getByRole('combobox', { name: 'Switch skill project' }) as HTMLSelectElement).value,
    ).toBe('other');
    expect(
      mocks.fetch.mock.calls.filter(
        ([url, options]) =>
          url.endsWith('/list') && JSON.parse(options.body).projectPath === '/project',
      ),
    ).toHaveLength(1);
    expect(screen.queryByText('Project A deletion failed')).toBeNull();
    expect(screen.queryByText('Deleted', { selector: '[role="status"]' })).toBeNull();
  },
);

it('finishes an old project move without clearing the chosen skill in the new project', async () => {
  const pending = pendingRequest();
  mockProjectSwitch(pending, 'move');
  render(<ProjectSwitchHarness />);
  await screen.findByRole('region', { name: 'Skill details: Project workflow' });
  fireEvent.click(screen.getByRole('button', { name: 'Manage Project workflow' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Global skills' }));
  await waitFor(() =>
    expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/import'))).toBe(true),
  );
  await chooseBWorkflow();
  await act(async () => {
    pending.resolve(response({ ok: true }));
  });
  expect(screen.getByRole('region', { name: 'Skill details: B workflow' })).toBeTruthy();
  const deletion = mocks.fetch.mock.calls.find(([url]) => url.endsWith('/delete'));
  expect(JSON.parse(deletion![1].body)).toEqual({
    scope: 'project',
    slug: 'race-work',
    projectPath: '/project',
  });
  expect(
    mocks.fetch.mock.calls.filter(
      ([url, options]) =>
        url.endsWith('/list') && JSON.parse(options.body).projectPath === '/project',
    ),
  ).toHaveLength(1);
});

it('reads skills and supporting documents by identity when list paths belong to another worktree', async () => {
  list.builtin = [{ ...builtin, skillDir: '/old-gateway-worktree/skills/core' }];
  mocks.fetch.mockImplementation(async (url: string) =>
    response(
      url.endsWith('/list')
        ? list
        : url.endsWith('/read')
          ? { content: '# Instructions\n\n[Reference](references/guide.md)' }
          : url.endsWith('/documents')
            ? { files: ['references/guide.md'] }
            : { content: '# Supporting guide' },
    ),
  );
  render(<SkillsV2 selectedProject={project} projects={[project]} />);
  await screen.findByRole('link', { name: 'Reference' });
  fireEvent.click(screen.getByRole('link', { name: 'Reference' }));
  await screen.findByRole('heading', { name: 'Supporting guide' });
  for (const endpoint of ['/read', '/documents', '/read-document']) {
    const request = mocks.fetch.mock.calls.find(([url]) => url.endsWith(endpoint));
    expect(JSON.parse(request![1].body)).toMatchObject({
      scope: 'builtin',
      slug: 'core',
      projectPath: '/project',
    });
    expect(JSON.parse(request![1].body).skillPath).toBeUndefined();
  }
});
