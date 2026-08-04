// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import MessageRowV2 from './MessageRowV2';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

afterEach(cleanup);

describe('MessageRowV2 generated file presentation', () => {
  it('uses the artifact card as the only file navigation affordance', () => {
    const fileName = '今日热点-2026-08-0803.docx';
    const filePath = `reports/${fileName}`;
    const message: ChatMessage = {
      id: 'assistant-file-result',
      entryId: 'assistant-file-result',
      type: 'assistant',
      content: `已完成今日热点总结并生成文件：[${fileName}](${fileName})`,
      timestamp: '2026-08-03T08:00:00.000Z',
      artifacts: [{
        id: 'artifact-1',
        name: fileName,
        path: filePath,
        operation: 'created',
        source: 'workspace_diff',
        status: 'complete',
        size: 1024,
        sha256: 'sha256',
        createdAt: '2026-08-03T08:00:00.000Z',
      }],
    };

    const { container } = render(
      <MessageRowV2
        message={message}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={{
          name: 'office',
          displayName: 'office',
          fullPath: '/workspace/office',
        }}
        createDiff={() => []}
        onFileOpen={vi.fn()}
        showAssistantActions={false}
      />,
    );

    expect(screen.queryByRole('link', { name: fileName })).toBeNull();
    expect(screen.getByText(`已完成今日热点总结并生成文件：${fileName}`)).toBeTruthy();
    const card = container.querySelector(`[data-file-artifact="${filePath}"]`);
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain(fileName);
  });
});
