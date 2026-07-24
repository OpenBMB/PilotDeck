import { describe, expect, it } from 'vitest';
import { createMinimapExtension } from './editorExtensions';

describe('createMinimapExtension', () => {
  it('shows the minimap for regular source files when enabled', () => {
    const extensions = createMinimapExtension({
      file: { name: 'page.tsx', path: '/project/page.tsx' },
      showDiff: false,
      minimapEnabled: true,
      isDarkMode: false,
    });

    expect(extensions).toHaveLength(1);
  });

  it('keeps the minimap disabled when the user setting is off', () => {
    const extensions = createMinimapExtension({
      file: { name: 'page.tsx', path: '/project/page.tsx' },
      showDiff: false,
      minimapEnabled: false,
      isDarkMode: false,
    });

    expect(extensions).toEqual([]);
  });
});
