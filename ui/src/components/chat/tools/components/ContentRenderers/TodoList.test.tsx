// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import TodoList from './TodoList';

afterEach(() => {
  cleanup();
});

describe('TodoList', () => {
  it('renders only status badges and omits priority badges', () => {
    render(
      <TodoList
        todos={[
          { id: 'a', content: 'Keep visible status', status: 'in_progress', priority: 'low' },
          { id: 'b', content: 'Hide priority badges', status: 'pending', priority: 'high' },
          { id: 'c', content: 'Finished work', status: 'completed', priority: 'medium' },
        ]}
      />
    );

    expect(screen.getByText('in progress')).toBeTruthy();
    expect(screen.getByText('pending')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.queryByText('low')).toBeNull();
    expect(screen.queryByText('high')).toBeNull();
    expect(screen.queryByText('medium')).toBeNull();
  });
});
