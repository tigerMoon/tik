import { describe, expect, it } from 'vitest';
import type {
  ChatResponse,
  IContextBuilder,
  ILLMProvider,
  LLMCallOptions,
  LLMPlanResponse,
} from '@tik/shared';
import { PLAN_READ_ONLY_TOOL_POLICY } from '@tik/shared';
import { ExecutionKernel } from '../src/execution-kernel.js';

describe('ExecutionKernel.planTask', () => {
  it('calls providers with an explicit read-only plan tool policy', async () => {
    let observedOptions: LLMCallOptions | undefined;
    const llm: ILLMProvider = {
      name: 'test',
      async plan(_prompt, _context, options): Promise<LLMPlanResponse> {
        observedOptions = options;
        return {
          goals: ['Plan safely'],
          actions: [],
          reasoning: 'Plan-only mode.',
        };
      },
      async complete(): Promise<string> {
        throw new Error('not used');
      },
      async chat(): Promise<ChatResponse> {
        throw new Error('not used');
      },
    };

    const contextBuilder: IContextBuilder = {
      async buildContext() {
        return { files: [] } as any;
      },
      async buildFromSession() {
        throw new Error('not used');
      },
    };

    const kernel = new ExecutionKernel({
      llm,
      contextBuilder,
      ace: {} as any,
      projectPath: '/tmp/tik-plan-policy',
    });

    await kernel.planTask({
      description: 'Generate a plan without touching files',
      projectPath: '/tmp/tik-plan-policy/project',
    });

    expect(observedOptions).toMatchObject({
      cwd: '/tmp/tik-plan-policy/project',
      allowWrites: false,
      toolPolicy: PLAN_READ_ONLY_TOOL_POLICY,
    });
    expect(observedOptions?.toolPolicy?.allowedTools).not.toContain('write_file');
    expect(observedOptions?.toolPolicy?.allowedTools).not.toContain('edit_file');
    expect(observedOptions?.toolPolicy?.allowedTools).not.toContain('bash');
  });
});
