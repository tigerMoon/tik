import { describe, expect, it } from 'vitest';
import {
  classifyTaskIntent,
  assistantSuggestsImplementationComplete,
  assistantSuggestsNoCodeChangeNeeded,
  dedupeToolCalls,
  enoughEvidenceToConclude,
  getToolCallSignature,
  hasMeaningfulPendingWork,
  isVerificationProbeBatch,
  isRedundantReadBatch,
  normalizeToolCall,
  sessionMemorySuggestsImplementation,
  shouldMarkTaskCompleted,
  shouldShiftFromExplorationToImplementation,
} from '../src/agent/tool-call-policy.js';

describe('tool-call policy', () => {
  it('normalizes simple bash cat into read_file', () => {
    const normalized = normalizeToolCall({
      id: '1',
      name: 'bash',
      arguments: { command: 'cat /tmp/demo.txt' },
    });

    expect(normalized).toEqual({
      id: '1',
      name: 'read_file',
      arguments: { path: '/tmp/demo.txt' },
    });
  });

  it('does not normalize complex bash commands', () => {
    const normalized = normalizeToolCall({
      id: '1',
      name: 'bash',
      arguments: { command: 'cat /tmp/demo.txt | head -20' },
    });

    expect(normalized.name).toBe('bash');
  });

  it('normalizes bash cat with flags into read_file', () => {
    const normalized = normalizeToolCall({
      id: '1',
      name: 'bash',
      arguments: { command: 'cat -A /tmp/demo.txt' },
    });

    expect(normalized).toEqual({
      id: '1',
      name: 'read_file',
      arguments: { path: '/tmp/demo.txt' },
    });
  });

  it('normalizes simple bash find into glob', () => {
    const normalized = normalizeToolCall({
      id: '1',
      name: 'bash',
      arguments: { command: 'find catalog-suite-one-api/src/main/java -type f -name "*Ticket*.java"' },
    });

    expect(normalized).toEqual({
      id: '1',
      name: 'glob',
      arguments: { pattern: 'catalog-suite-one-api/src/main/java/**/*Ticket*.java' },
    });
  });

  it('dedupes repeated identical tool calls', () => {
    const deduped = dedupeToolCalls([
      { id: '1', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: '2', name: 'read_file', arguments: { path: 'a.ts' } },
      { id: '3', name: 'grep', arguments: { pattern: 'cache', path: 'src' } },
    ]);

    expect(deduped).toHaveLength(2);
  });

  it('detects redundant read-only batches after successful reads', () => {
    const call = { id: '1', name: 'read_file', arguments: { path: 'src/a.ts' } };
    const successful = new Set([getToolCallSignature(call)]);

    expect(isRedundantReadBatch([call], successful)).toBe(true);
  });

  it('does not mark non-read tools as redundant reads', () => {
    const call = { id: '1', name: 'edit_file', arguments: { path: 'src/a.ts', old_string: 'a', new_string: 'b' } };
    const successful = new Set([getToolCallSignature(call)]);

    expect(isRedundantReadBatch([call], successful)).toBe(false);
  });

  it('shifts from exploration to implementation after cache and service files are identified', () => {
    const calls = [
      { id: '1', name: 'read_file', arguments: { path: '/repo/one-api/src/main/java/com/demo/AccountCacheManager.java' } },
      { id: '2', name: 'read_file', arguments: { path: '/repo/one-api/src/main/java/com/demo/CatalogQueryServiceImpl.java' } },
    ];
    const actions = [
      {
        tool: 'read_file',
        input: { path: '/repo/one-api/src/main/java/com/demo/AccountCacheManager.java' },
        output: 'public class AccountCacheManager {}',
        success: true,
      },
      {
        tool: 'read_file',
        input: { path: '/repo/one-api/src/main/java/com/demo/CatalogQueryServiceImpl.java' },
        output: 'package com.demo.service; public class CatalogQueryServiceImpl {}',
        success: true,
      },
    ];

    expect(shouldShiftFromExplorationToImplementation(calls, actions)).toBe(true);
  });

  it('does not shift when only cache files were read', () => {
    const calls = [
      { id: '1', name: 'read_file', arguments: { path: '/repo/src/cache/QueryCacheManager.java' } },
    ];
    const actions = [
      {
        tool: 'read_file',
        input: { path: '/repo/src/cache/QueryCacheManager.java' },
        output: 'public class QueryCacheManager {}',
        success: true,
      },
    ];

    expect(shouldShiftFromExplorationToImplementation(calls, actions)).toBe(false);
  });

  it('detects implementation readiness from session memory summary', () => {
    const summary = [
      'Goal: add cache support',
      'Key files: /repo/AccountCacheManager.java, /repo/CatalogQueryServiceImpl.java',
      'Implementation ready: yes',
      'Current focus: implementation',
    ].join('\n');

    expect(sessionMemorySuggestsImplementation(summary)).toBe(true);
  });

  it('detects implementation readiness from structured compact memory', () => {
    expect(sessionMemorySuggestsImplementation({
      goal: 'verify cache support',
      keyFiles: [
        '/repo/AccountCacheManager.java',
        '/repo/CatalogQueryServiceImpl.java',
      ],
      implementationReady: true,
      implementationStrict: true,
      currentFocus: 'implementation',
    })).toBe(true);
  });

  it('detects when assistant text already concludes implementation exists', () => {
    expect(
      assistantSuggestsImplementationComplete('我已经查看了代码，发现缓存功能已经实现。让我检查一下是否有遗漏的部分：'),
    ).toBe(true);
    expect(
      assistantSuggestsImplementationComplete('The cache layer has already been implemented; I will check if anything is missing.'),
    ).toBe(true);
  });

  it('detects verification probe batches', () => {
    expect(
      isVerificationProbeBatch([
        { id: '1', name: 'bash', arguments: { command: 'cd repo && rg "cacheManager" src' } },
        { id: '2', name: 'read_file', arguments: { path: 'src/App.java' } },
      ]),
    ).toBe(true);

    expect(
      isVerificationProbeBatch([
        { id: '1', name: 'edit_file', arguments: { path: 'src/App.java', old_string: 'a', new_string: 'b' } },
      ]),
    ).toBe(false);
  });

  it('detects enough evidence to conclude when memory, assistant, and probes line up', () => {
    const summary = [
      'Conversation summary:',
      '- Goal: verify cache support',
      '- Key files: /repo/AccountCacheManager.java, /repo/CatalogQueryServiceImpl.java',
      '- Pending work: Conclude whether anything is missing',
      '- Current work: Conclude implementation status',
      '- Implementation ready: yes',
      '- Current focus: implementation',
    ].join('\n');

    const assistant = '我已经查看了代码，发现缓存功能已经实现。让我检查一下是否有遗漏的部分：';
    const calls = [
      { id: '1', name: 'bash', arguments: { command: 'cd repo && rg "cache" src' } },
    ];

    expect(enoughEvidenceToConclude(summary, assistant, calls)).toBe(true);
  });

  it('detects enough evidence with structured compact memory', () => {
    const assistant = 'The cache layer has already been implemented; I will check if anything is missing.';
    const calls = [
      { id: '1', name: 'bash', arguments: { command: 'cd repo && rg "cache" src' } },
    ];

    expect(enoughEvidenceToConclude({
      goal: 'verify cache support',
      keyFiles: ['/repo/AccountCacheManager.java', '/repo/CatalogQueryServiceImpl.java'],
      pendingWork: ['Conclude whether anything is missing'],
      currentWork: 'Conclude implementation status',
      implementationReady: true,
      currentFocus: 'implementation',
    }, assistant, calls)).toBe(true);
  });

  it('classifies implementation intent for cache requests', () => {
    expect(classifyTaskIntent('我想针对票务业务的查询接口做缓存')).toBe('implementation');
  });

  it('classifies build-style creation tasks as implementation work', () => {
    expect(classifyTaskIntent('设计一个贪吃蛇的游戏: H5 页面，可以玩耍')).toBe('implementation');
    expect(classifyTaskIntent('做一个 landing page demo')).toBe('implementation');
  });

  it('does not mark implementation tasks completed after read-only analysis', () => {
    expect(shouldMarkTaskCompleted(
      '我想针对票务业务的查询接口做缓存，one-api目录',
      {
        goal: 'add cache',
        keyFiles: ['/repo/AccountCacheManager.java', '/repo/CatalogQueryServiceImpl.java'],
        pendingWork: ['Implement the missing cache usage in the identified query/service flow'],
        currentWork: 'Implement the missing cache usage in the identified query/service flow',
        implementationReady: true,
        currentFocus: 'implementation',
      },
      '我已经定位到了关键实现文件，接下来需要修改代码接入缓存。',
      [
        {
          tool: 'read_file',
          input: { path: '/repo/CatalogQueryServiceImpl.java' },
          output: 'class CatalogQueryServiceImpl {}',
          success: true,
        },
      ],
    )).toBe(false);
  });

  it('allows implementation tasks to complete when assistant explicitly concludes no code change is needed', () => {
    const assistant = '缓存功能已经实现，无需改代码。我会总结依据并结束。';
    expect(assistantSuggestsNoCodeChangeNeeded(assistant)).toBe(true);
    expect(hasMeaningfulPendingWork({
      pendingWork: [],
      currentWork: 'Explain why no code changes are required and cite the supporting implementation files',
      implementationReady: true,
    })).toBe(false);
    expect(shouldMarkTaskCompleted(
      '我想针对票务业务的查询接口做缓存，one-api目录',
      {
        goal: 'add cache',
        keyFiles: ['/repo/AccountCacheManager.java', '/repo/CatalogQueryServiceImpl.java'],
        pendingWork: [],
        currentWork: 'Explain why no code changes are required and cite the supporting implementation files',
        implementationReady: true,
        currentFocus: 'implementation',
      },
      assistant,
      [
        {
          tool: 'read_file',
          input: { path: '/repo/CatalogQueryServiceImpl.java' },
          output: 'class CatalogQueryServiceImpl {}',
          success: true,
        },
      ],
    )).toBe(true);
  });
});
