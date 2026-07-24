// @vitest-environment jsdom
import { createRef, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeEditorTab } from '../types/types';
import EditorSidebar from './EditorSidebar';

const mocks = vi.hoisted(() => ({
  codeEditorProps: [] as Array<{
    isSidebar?: boolean;
    compactHeader?: boolean;
    headerPrefix?: ReactNode;
  }>,
  tabBarProps: [] as Array<{ reserveToolbarSpace?: boolean }>,
}));

vi.mock('./CodeEditor', () => ({
  default: (props: {
    isSidebar?: boolean;
    compactHeader?: boolean;
    headerPrefix?: ReactNode;
  }) => {
    mocks.codeEditorProps.push(props);
    return <div data-testid="code-editor">{props.headerPrefix}</div>;
  },
}));

vi.mock('./subcomponents/CodeEditorTabBar', () => ({
  default: (props: { reserveToolbarSpace?: boolean }) => {
    mocks.tabBarProps.push(props);
    return <div data-testid="editor-tab-bar" />;
  },
}));

const editorTabs: CodeEditorTab[] = [{
  id: 'editor-tab-0',
  fileStack: [{
    name: 'report.pdf',
    path: '/workspace/PilotDeck/report.pdf',
    projectName: 'pilotdeck',
    diffInfo: null,
  }],
  dirty: false,
}];

function renderSidebar(workspaceMode: boolean) {
  return render(
    <EditorSidebar
      editorTabs={editorTabs}
      activeEditorTabId="editor-tab-0"
      isMobile
      editorExpanded={false}
      editorWidth={600}
      hasManualWidth={false}
      resizeHandleRef={createRef<HTMLDivElement>()}
      onResizeStart={vi.fn()}
      onTabSelect={vi.fn()}
      onTabClose={vi.fn()}
      onTabsClose={vi.fn()}
      onTabDirtyChange={vi.fn()}
      onToggleEditorExpand={vi.fn()}
      workspaceMode={workspaceMode}
    />,
  );
}

afterEach(() => {
  cleanup();
  mocks.codeEditorProps.length = 0;
  mocks.tabBarProps.length = 0;
});

describe('EditorSidebar workspace embedding', () => {
  it('keeps the mobile editor embedded inside the Files workspace', () => {
    renderSidebar(true);

    expect(mocks.codeEditorProps.at(-1)?.isSidebar).toBe(true);
    expect(mocks.codeEditorProps.at(-1)?.compactHeader).toBe(true);
    expect(mocks.tabBarProps.at(-1)?.reserveToolbarSpace).toBe(true);
  });

  it('retains the legacy full-screen mobile editor outside workspace mode', () => {
    renderSidebar(false);

    expect(mocks.codeEditorProps.at(-1)?.isSidebar).toBe(false);
    expect(mocks.codeEditorProps.at(-1)?.compactHeader).toBe(false);
    expect(mocks.tabBarProps.at(-1)?.reserveToolbarSpace).toBe(false);
  });
});
