import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '../../src/contexts/ThemeContext';
import { ConfirmProvider } from '../../src/components/ui/ConfirmDialog';
import EditorSidebar from '../../src/components/code-editor/view/EditorSidebar';
import '../../src/i18n/config';
import '../../src/index.css';

function makeTabs(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `fixture-${index}`,
    fileStack: [{
      name: index === 0 ? 'index.html' : index === 1 ? 'pelican_cruise.html' : `很长的文件名_pvz_balance_result_${index}.txt`,
      path: `/fixture/project-${index}/result.txt`,
      projectName: 'editor-tabs-fixture',
      diffInfo: null,
    }],
    dirty: false,
  }));
}

function Fixture() {
  const [tabs, setTabs] = useState(() => makeTabs(3));
  const [active, setActive] = useState('fixture-2');
  const [expanded, setExpanded] = useState(false);
  const resizeHandleRef = useRef(null);
  const closeTabs = (ids) => {
    const remaining = tabs.filter(tab => !ids.includes(tab.id));
    setTabs(remaining);
    if (ids.includes(active)) setActive(remaining.at(-1)?.id ?? null);
  };
  window.editorTabsFixture = {
    setCount(count) { setTabs(makeTabs(count)); setActive(`fixture-${count - 1}`); },
  };
  return (
    <div style={{ height: '100vh', padding: 20, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: '0 0 40px' }}>File editor tab layout regression</div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden', border: '1px solid #e5e5e5' }}>
        <EditorSidebar
          editorTabs={tabs} activeEditorTabId={active}
          isMobile={false} editorExpanded={expanded} editorWidth={600} hasManualWidth={false}
          resizeHandleRef={resizeHandleRef} onResizeStart={() => {}}
          onTabSelect={setActive} onTabClose={id => closeTabs([id])} onTabsClose={closeTabs}
          onTabDirtyChange={(id, dirty) => setTabs(previous => previous.some(tab => tab.id === id && tab.dirty !== dirty)
            ? previous.map(tab => tab.id === id ? { ...tab, dirty } : tab) : previous)}
          onToggleEditorExpand={() => setExpanded(value => !value)}
          workspaceMode={new URLSearchParams(location.search).get('legacy') !== 'true'}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ThemeProvider><ConfirmProvider><Fixture /></ConfirmProvider></ThemeProvider>);
