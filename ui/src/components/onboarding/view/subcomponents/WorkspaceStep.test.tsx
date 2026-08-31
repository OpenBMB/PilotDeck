// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkspaceStep from './WorkspaceStep';

vi.mock('react-i18next', async () => {
  const enOnboarding = (await import('../../../../i18n/locales/en/onboarding.json')).default as Record<string, unknown>;
  const lookupTranslation = (key: string) => {
    const value = key.split('.').reduce<unknown>(
      (current, segment) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined),
      enOnboarding,
    );
    return typeof value === 'string' ? value : key;
  };

  return {
    useTranslation: () => ({
      t: lookupTranslation,
      i18n: { language: 'en', changeLanguage: vi.fn() },
    }),
  };
});

vi.mock('../../../project-creation-wizard/components/FolderBrowserModal', () => ({
  default: () => null,
}));

const draft = {
  workspaceType: 'new' as const,
  workspacePath: '',
  githubUrl: '',
};

function renderStep(overrides: Partial<Parameters<typeof WorkspaceStep>[0]> = {}) {
  const onFinish = vi.fn();
  const onSkipChat = vi.fn();
  render(
    <WorkspaceStep
      draft={draft}
      error=""
      progress=""
      isCreating={false}
      onWorkspacePathChange={vi.fn()}
      onGithubUrlChange={vi.fn()}
      onBack={vi.fn()}
      onSkipChat={onSkipChat}
      onFinish={onFinish}
      {...overrides}
    />,
  );
  return { onFinish, onSkipChat };
}

describe('WorkspaceStep', () => {
  afterEach(() => {
    cleanup();
  });

  it('lets Start chatting skip workspace and GitHub validation', () => {
    const { onFinish, onSkipChat } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: 'Start chatting' }));

    expect(onSkipChat).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
    expect(screen.queryByText('Enter a workspace path.')).toBeNull();
  });

  it('requires Workspace only when creating a workspace', () => {
    const { onFinish } = renderStep();

    fireEvent.click(screen.getByRole('button', { name: /Create workspace/ }));

    expect(onFinish).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a workspace path.')).toBeTruthy();
  });

  it('does not require GitHub URL when creating a workspace', () => {
    const { onFinish } = renderStep({
      draft: { ...draft, workspacePath: '/tmp/pilotdeck' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Create workspace/ }));

    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
