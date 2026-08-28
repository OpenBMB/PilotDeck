// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types/app';
import WorkspacePickerBar from './WorkspacePickerBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('lucide-react', () => ({
  Check: () => null,
  ChevronDown: () => null,
  Folder: () => null,
  Plus: () => null,
  Search: () => null,
  X: () => null,
}));

const general: Project = {
  name: 'general',
  displayName: 'general',
  fullPath: '/workspace/general',
  sessions: [],
};

const office: Project = {
  name: 'office',
  displayName: 'office',
  fullPath: '/workspace/office',
  sessions: [],
};

afterEach(() => {
  cleanup();
});

describe('WorkspacePickerBar', () => {
  it('shows the unset label until a workspace is chosen', () => {
    render(
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={null}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /选择工作空间|Select workspace/ })).toBeTruthy();
  });

  it('lists existing projects, supports search, and exposes create/none actions', () => {
    const onSelectProject = vi.fn();
    const onSelectNone = vi.fn();
    const onCreateProject = vi.fn();

    render(
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={null}
        onSelectProject={onSelectProject}
        onSelectNone={onSelectNone}
        onCreateProject={onCreateProject}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /选择工作空间|Select workspace/ }));
    expect(screen.getByPlaceholderText(/搜索项目|Search projects/)).toBeTruthy();
    expect(screen.getByText('office')).toBeTruthy();
    expect(screen.queryByText('general')).toBeNull();

    fireEvent.click(screen.getByText('office'));
    expect(onSelectProject).toHaveBeenCalledWith(office);

    fireEvent.click(screen.getByRole('button', { name: /选择工作空间|Select workspace/ }));
    fireEvent.click(screen.getByText(/新建项目|New project/));
    expect(onCreateProject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /选择工作空间|Select workspace/ }));
    fireEvent.click(screen.getByText(/不在项目中工作|Work without a project/));
    expect(onSelectNone).toHaveBeenCalledTimes(1);
  });

  it('falls down the selected project name', () => {
    render(
      <WorkspacePickerBar
        projects={[general, office]}
        selectedProject={office}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /office/ })).toBeTruthy();
  });

  it('lists projects in the same lastActivity order as the sidebar', () => {
    const older: Project = {
      name: 'Users-wukai-test0806',
      displayName: 'test0806',
      fullPath: '/tmp/test0806',
      lastActivity: 1787215786943,
      sessions: [],
    };
    const newer: Project = {
      name: 'Users-wukai-test0807',
      displayName: 'test0807',
      fullPath: '/tmp/test0807',
      lastActivity: 1787570906592,
      sessions: [],
    };
    const desktop: Project = {
      name: 'Desktop',
      displayName: 'Desktop',
      fullPath: '/tmp/Desktop',
      lastActivity: 1788000000000,
      sessions: [],
    };

    render(
      <WorkspacePickerBar
        projects={[general, older, newer, desktop]}
        selectedProject={null}
        onSelectProject={vi.fn()}
        onSelectNone={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /选择工作空间|Select workspace/ }));
    const labels = screen
      .getAllByRole('option')
      .map((node) => node.textContent?.trim());
    expect(labels).toEqual(['Desktop', 'test0807', 'test0806']);
  });
});
