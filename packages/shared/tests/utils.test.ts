import { describe, it, expect } from 'vitest';
import {
  generateId,
  generateTaskId,
  formatDuration,
  clamp,
  truncate,
} from '@tik/shared';

describe('utils', () => {
  it('generateId returns unique strings', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('generateTaskId has task- prefix', () => {
    const id = generateTaskId();
    expect(id).toMatch(/^task-/);
  });

  it('formatDuration formats correctly', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('clamp restricts range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('truncate with ellipsis', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world foo', 10)).toBe('hello w...');
  });
});
