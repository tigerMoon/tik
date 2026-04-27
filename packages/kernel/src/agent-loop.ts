/**
 * Agent Loop (Phase 2 - Session-Based)
 *
 * The unified execution loop for both single-agent and multi-agent modes.
 * Uses AgentSession for multi-turn LLM continuity and agent role collaboration.
 *
 * Architecture (from roadmap_2.md):
 *   Task → Session → AgentLoop → single/multi agent → EventBus
 *
 * Key constraints:
 *   - Task.status is the external lifecycle (driven by ExecutionKernel)
 *   - Session.loopState is internal control only
 *   - EventBus remains SSOT
 *   - Multi-agent roles share one taskId, one sessionId, one event stream
 *
 * Execution flow per step:
 *   1. Build context (SIGHT)
 *   2. LLM call with message history + context
 *   3. Record assistant response to messages
 *   4. Execute tool calls, record results to messages
 *   5. Evaluate (if appropriate for current agent/mode)
 *   6. Switch agent (multi mode, after evaluation)
 */

import type {
  Task,
  TaskResult,
  Plan,
  Iteration,
  EvaluationSnapshot,
  AgentContext,
  IEventBus,
  ILLMProvider,
  IContextBuilder,
  ControlCommand,
  ConvergenceStrategy,
  ChatMessage,
  LLMToolDef,
  LLMCallOptions,
  ProviderRuntimeEvent,
  AgentSession,
  AgentRole,
  ExecutionMode,
  AgentRuntime,
  RuntimeContextEnvelope,
  ToolResultRef,
  SessionCompactMemory,
} from '@tik/shared';
import {
  EventType,
  generateId,
  now,
  formatDuration,
} from '@tik/shared';
import type { ToolScheduler } from './tool-scheduler.js';
import {
  assistantSuggestsImplementationComplete,
  assistantSuggestsNoCodeChangeNeeded,
  classifyTaskIntent,
  hasWriteLikeAction,
  dedupeToolCalls,
  enoughEvidenceToConclude,
  getToolCallSignature,
  isVerificationProbeBatch,
  isRedundantReadBatch,
  isReadLikeTool,
  normalizeToolCall,
  shouldMarkTaskCompleted,
  shouldForceImplementationAction,
  sessionMemorySuggestsImplementation,
  shouldShiftFromExplorationToImplementation,
  type RuntimeToolCall,
} from './agent/tool-call-policy.js';
import type { AgentSpec } from './agent/agent-spec.js';

// ─── Injected Interfaces (Phase 2.8) ───────────────────────

/** Renders RuntimeContextEnvelope into a formatted string for LLM */
export interface IContextRenderer {
  render(envelope: RuntimeContextEnvelope): string;
}

/** Stores large tool results externally, returns preview reference */
export interface IToolResultStore {
  shouldStore(output: string): boolean;
  store(taskId: string, toolCallId: string, toolName: string, output: string, isError?: boolean): Promise<ToolResultRef>;
}

// ─── ACE Evaluator Interface (injected) ─────────────────────

export interface IACEEngine {
  evaluateIteration(taskId: string, iteration: number): Promise<EvaluationSnapshot>;
  checkConvergence(
    evaluation: EvaluationSnapshot,
    stableCount: number,
    strategy: ConvergenceStrategy,
  ): boolean;
}

// ─── System Prompts ─────────────────────────────────────────

const SYSTEM_PROMPTS: Record<AgentRole, string> = {
  planner: `You are the Planner agent in a multi-agent coding system.
Your job is to analyze the task, understand the codebase, and create a detailed plan.
Break down the task into concrete steps. Identify files that need changes.
Use read tools (read_file, glob, grep) to explore. Prefer structured search tools over shell search.
If the context includes likely target paths, treat them as high-probability path completions and inspect them before widening the search.
Do NOT claim a module/path is missing until you have checked the hinted candidates.
Do NOT write or edit files.
Output your plan as structured text when done.`,

  coder: `You are the Coder agent in a coding system.
Your job is to implement changes according to the plan.
Use tools to read, write, and edit files. Run commands as needed.
Prefer read_file, glob, and grep for repository exploration. Use bash for search only when structured tools are insufficient.
If the context includes likely target paths, start there first and treat them as path completions for vague user phrases.
Avoid broad repo-wide find/grep loops once you already have likely target paths.
If a likely target path is a directory, inspect inside it with glob/grep before attempting read_file.
Follow the plan from the planner. Make precise, minimal changes.
When all changes are complete, summarize what you did.`,

  reviewer: `You are the Reviewer agent in a coding system.
Your job is to review the changes made by the coder.
Use read tools to inspect modified files. Run tests if available.
Prefer checking hinted paths and changed files before widening the search.
Check for correctness, regressions, and code quality.
Report issues or confirm the changes are acceptable.`,
};

// ─── Agent Loop ──────────────────────────────────────────────

/** Callback for streaming text chunks from LLM */
export type StreamChunkHandler = (chunk: string, meta: { taskId: string; agent: string }) => void;

export class AgentLoop {
  private eventBus: IEventBus;
  private toolScheduler: ToolScheduler;
  private contextBuilder: IContextBuilder;
  private llmProvider: ILLMProvider;
  private aceEngine: IACEEngine;
  private onPhaseChange?: (status: string) => void;
  private contextRenderer?: IContextRenderer;
  private toolResultStore?: IToolResultStore;
  private onStreamChunk?: StreamChunkHandler;

  // Control state (mapped to session.loopState)
  private injectedConstraints: string[] = [];
  private currentStrategy: ConvergenceStrategy | null = null;
  private pendingPlanPatch: Partial<Plan> | null = null;

  constructor(
    eventBus: IEventBus,
    toolScheduler: ToolScheduler,
    contextBuilder: IContextBuilder,
    llmProvider: ILLMProvider,
    aceEngine: IACEEngine,
    onPhaseChange?: (status: string) => void,
    contextRenderer?: IContextRenderer,
    toolResultStore?: IToolResultStore,
    onStreamChunk?: StreamChunkHandler,
  ) {
    this.eventBus = eventBus;
    this.toolScheduler = toolScheduler;
    this.contextBuilder = contextBuilder;
    this.llmProvider = llmProvider;
    this.aceEngine = aceEngine;
    this.onPhaseChange = onPhaseChange;
    this.contextRenderer = contextRenderer;
    this.toolResultStore = toolResultStore;
    this.onStreamChunk = onStreamChunk;
  }

  /**
   * Run the agent loop.
   *
   * If a session is provided, uses session-based multi-turn execution.
   * If not, falls back to legacy per-iteration mode (Phase 1 compat).
   */
  async run(task: Task, session?: AgentSession): Promise<TaskResult> {
    if (session) {
      return this.runSessionBased(task, session);
    }
    return this.runLegacy(task);
  }

  // ─── Session-Based Execution (Phase 2) ────────────────────

  private async runSessionBased(task: Task, session: AgentSession): Promise<TaskResult> {
    const startTime = now();
    let stableCount = 0;
    let lastFitness = 0;
    let converged = false;
    let completed = false;
    let lastEvaluation: EvaluationSnapshot | undefined;
    let currentIteration = 0;

    // Accumulate executed actions for the current iteration
    let iterationActions: Array<{ tool: string; input: unknown; output: unknown; success: boolean; error?: string; durationMs: number }> = [];
    let likelyTargetPaths: string[] = [];

    // Multi-agent: planner (once) + (coder->reviewer) * iterations
    // Iteration 1: planner -> coder -> reviewer (3 steps)
    // Iteration 2+: coder -> reviewer (2 steps each)
    const maxSteps = session.mode === 'multi'
      ? 3 + (task.maxIterations - 1) * 2  // planner once, then coder->reviewer loop
      : task.maxIterations;  // single mode: 1 step per iteration

    try {
      while (session.loopState !== 'stopped' && session.step < maxSteps) {
        if (!await this.waitForSessionRunState(session)) break;

        session.step++;
        const actingAgent = session.currentAgent;
        const agent = session.agents[actingAgent];
        if (!agent) {
          // Shouldn't happen, but safety
          session.loopState = 'stopped';
          break;
        }

        // Calculate iteration number based on agent flow
        // Multi: step 1-3 = iter 1 (planner->coder->reviewer), step 4-5 = iter 2 (coder->reviewer), etc.
        // Single: step N = iter N
        const iterationNumber = session.mode === 'multi'
          ? (session.step <= 3 ? 1 : Math.floor((session.step - 3) / 2) + 2)
          : session.step;

        // Only increment currentIteration when we start a new iteration
        if (session.mode === 'single' || session.step === 1 || (session.step > 3 && (session.step - 3) % 2 === 1)) {
          currentIteration = iterationNumber;
        }

        const strategy = this.currentStrategy || task.strategy;

        this.emitEvent(EventType.ITERATION_STARTED, task.id, {
          iteration: iterationNumber,
          step: session.step,
          agent: actingAgent,
          mode: session.mode,
          maxIterations: task.maxIterations,
          strategy,
        });

        const stepStart = now();

        // ── 1. Build Context (SIGHT) ──────────────────────
        // Use session-aware context building if available (Phase 2.8+)
        let contextStr: string;
        if (this.contextBuilder.buildFromSession) {
          const envelope = await this.contextBuilder.buildFromSession(task, session, { agent: actingAgent });
          likelyTargetPaths = this.extractLikelyTargetPaths(envelope, task.projectPath || process.cwd());
          // Use renderer if available, otherwise fallback to JSON
          contextStr = this.contextRenderer
            ? this.contextRenderer.render(envelope)
            : this.buildContextString(task, envelope.execution, strategy);
        } else {
          likelyTargetPaths = [];
          const context = await this.contextBuilder.buildContext(task.id, iterationNumber, {
            agent: actingAgent,
            environmentPackId: task.environmentPackSnapshot?.id,
            environmentPackSelection: task.environmentPackSelection,
          });
          contextStr = this.buildContextString(task, context, strategy);
        }

        this.emitEvent(EventType.CONTEXT_BUILT, task.id, {
          iteration: iterationNumber,
          tokensUsed: Math.ceil(contextStr.length / 4),
          agent: actingAgent,
        });

        if (!await this.waitForSessionRunState(session)) break;

        // ── 2. LLM Call with inner tool loop ─────────────
        this.onPhaseChange?.(actingAgent === 'planner' ? 'planning' : 'executing');
        this.emitEvent(EventType.PLAN_STARTED, task.id, {
          iteration: iterationNumber,
          agent: actingAgent,
        });

        // Get tool definitions (planner gets read-only tools, coder gets all)
        const toolDefs = this.constrainToolDefsForSession(
          this.getToolDefs(actingAgent, this.getAgentSpec(agent)),
          session,
          actingAgent,
        );

        // Inner tool loop: LLM → tools → LLM → tools → ... until no more tool calls
        // This does NOT consume step budget — one step = one complete agent turn
        const MAX_TOOL_ROUNDS = 20; // Safety limit per step
        const successfulReadSignatures = new Set<string>();
        let implementationHintInjected = false;
        let implementationActionForced = false;
        let forcedSummaryAttempted = false;
        let lastResponse = await this.callLLM(agent, session, contextStr, toolDefs);
        this.emitUsageEvent(task.id, session, actingAgent, iterationNumber, lastResponse.usage);

        for (let toolRound = 0; toolRound < MAX_TOOL_ROUNDS; toolRound++) {
          // Record assistant message WITH tool_use blocks preserved
          // This is critical for API fidelity — Claude needs to see its own
          // tool_use blocks in the history to match with tool_result messages
          this.pushMessage(session, {
            role: 'assistant',
            name: actingAgent,
            content: lastResponse.content,
            toolCalls: lastResponse.toolCalls,
          });

          this.emitEvent(EventType.SESSION_MESSAGE, task.id, {
            sessionId: session.sessionId,
            role: 'assistant',
            agent: actingAgent,
            contentLength: lastResponse.content.length,
            hasToolCalls: !!lastResponse.toolCalls?.length,
          });

          if (lastResponse.executedActions?.length) {
            iterationActions.push(...lastResponse.executedActions.map((action: {
              tool: string;
              input: unknown;
              output?: unknown;
              success: boolean;
            }) => ({
              tool: action.tool,
              input: action.input,
              output: action.output,
              success: action.success,
            })));
          }

          // No tool calls → agent turn is done
          if (!lastResponse.toolCalls?.length) break;

          const normalizedToolCalls = dedupeToolCalls(
            lastResponse.toolCalls.map((call: RuntimeToolCall) => normalizeToolCall(call)),
          );

          if (shouldForceImplementationAction(task.description, session.compactMemory || session.contextSummary, normalizedToolCalls)) {
            this.enterStrictImplementationMode(session);
            this.emitEvent(EventType.WARNING, task.id, {
              message: implementationActionForced
                ? 'Implementation mode is active and the assistant is still requesting only read-only probes. It must now either edit code or explicitly conclude that no code changes are needed.'
                : 'Implementation mode is active. Redirecting the assistant from read-only verification to concrete code changes or an explicit no-change conclusion.',
              iteration: iterationNumber,
              agent: actingAgent,
            });

            this.recordPolicyDeniedToolCalls(
              task,
              session,
              normalizedToolCalls,
              implementationActionForced
                ? 'Read-only verification probes are denied in implementation mode because pending work still requires code changes. Use edit_file/write_file next, or stop calling tools and explain why no code changes are needed.'
                : 'Read-only verification probes are denied in implementation mode because the relevant implementation files have already been identified. Use edit_file/write_file next, or stop calling tools and explain why no code changes are needed.',
            );

            this.pushMessage(session, {
              role: 'system',
              content: implementationActionForced
                ? 'Implementation mode is active and pending work still requires code changes. The previous read-only probes were denied. Your next response must either call edit_file/write_file with a concrete change, or stop calling tools and clearly explain why no code changes are needed.'
                : 'Implementation mode is active and pending work still requires code changes. The previous read-only probes were denied. Your next response must either call edit_file/write_file with a concrete change, or stop calling tools and clearly explain why no code changes are needed.',
            });

            implementationActionForced = true;
            const implementationToolDefs = this.getImplementationToolDefs(toolDefs);
            lastResponse = await this.callLLM(agent, session, contextStr, implementationToolDefs);
            this.emitUsageEvent(task.id, session, actingAgent, iterationNumber, lastResponse.usage);
            continue;
          }

          if (enoughEvidenceToConclude(session.compactMemory || session.contextSummary, lastResponse.content, normalizedToolCalls)) {
            if (forcedSummaryAttempted) {
              completed = true;
              this.emitEvent(EventType.WARNING, task.id, {
                message: 'Stopping extra verification because the assistant already concluded the implementation status and only proposed more local probes.',
                iteration: iterationNumber,
                agent: actingAgent,
              });
              break;
            }

            forcedSummaryAttempted = true;
            this.emitEvent(EventType.WARNING, task.id, {
              message: 'Enough evidence has been collected. Forcing a final summary instead of more local verification probes.',
              iteration: iterationNumber,
              agent: actingAgent,
            });

            this.pushMessage(session, {
              role: 'system',
              content: 'You already have enough evidence to conclude the current implementation status. Do not run more local verification probes. Summarize the finding clearly, state whether code changes are needed, and stop calling tools.',
            });

            lastResponse = await this.callLLM(agent, session, contextStr, toolDefs);
            this.emitUsageEvent(task.id, session, actingAgent, iterationNumber, lastResponse.usage);
            continue;
          }

          if (isRedundantReadBatch(normalizedToolCalls, successfulReadSignatures)) {
            if (classifyTaskIntent(task.description) === 'implementation') {
              this.enterStrictImplementationMode(session);
              this.emitEvent(EventType.WARNING, task.id, {
                message: 'Stopping repeated read-only exploration and switching to implementation mode. The assistant must now edit code or explicitly conclude that no code changes are needed.',
                iteration: iterationNumber,
                agent: actingAgent,
              });

              this.pushMessage(session, {
                role: 'system',
                content: 'You are repeating the same successful read-only exploration on an implementation task. Stop searching. Your next response must either call edit_file/write_file with a concrete change, or stop calling tools and clearly explain why no code changes are needed.',
              });

              implementationActionForced = true;
              const implementationToolDefs = this.getImplementationToolDefs(toolDefs);
              lastResponse = await this.callLLM(agent, session, contextStr, implementationToolDefs);
              this.emitUsageEvent(task.id, session, actingAgent, iterationNumber, lastResponse.usage);
              continue;
            }

            completed = true;
            this.emitEvent(EventType.WARNING, task.id, {
              message: 'Stopping repeated read-only exploration because the same successful file searches were requested again.',
              iteration: iterationNumber,
              agent: actingAgent,
            });

            this.pushMessage(session, {
              role: 'system',
              content: 'You are repeating the same successful read-only exploration. Stop searching and summarize or take the next concrete action.',
            });
            break;
          }

          // Execute tool calls
          const actions = await this.handleToolCalls(task, session, normalizedToolCalls, likelyTargetPaths);
          iterationActions.push(...actions);

          normalizedToolCalls.forEach((call, index) => {
            const action = actions[index];
            if (!action?.success) return;
            if (!isReadLikeTool(call.name)) return;
            successfulReadSignatures.add(getToolCallSignature(call));
          });

          this.updateContextSummary(session, actingAgent, lastResponse.content, iterationActions);

          if (
            !implementationHintInjected
            && (
              shouldShiftFromExplorationToImplementation(normalizedToolCalls, actions)
              || sessionMemorySuggestsImplementation(session.compactMemory || session.contextSummary)
            )
          ) {
            implementationHintInjected = true;
            this.emitEvent(EventType.WARNING, task.id, {
              message: 'Key cache/query implementation files have been identified. Prioritize concrete implementation or verification instead of further broad exploration.',
              iteration: iterationNumber,
              agent: actingAgent,
            });

            this.pushMessage(session, {
              role: 'system',
              content: 'You have already identified the key cache and query/service implementation files. Stop broad exploration. Prioritize concrete implementation, focused verification, or a direct summary of the required code changes.',
            });
          }

          // Check if session was stopped during tool execution
          if (session.loopState !== 'running') break;

          // Call LLM again with tool results in message history
          lastResponse = await this.callLLM(agent, session, contextStr, toolDefs);
          this.emitUsageEvent(task.id, session, actingAgent, iterationNumber, lastResponse.usage);
        }

        const response = lastResponse;

        if (!await this.waitForSessionRunState(session)) break;

        // Agent turn complete — update session memory before completion
        // evaluation so that explicit no-change conclusions can clear pending
        // work and participate in completion semantics immediately.
        this.updateContextSummary(session, actingAgent, response.content, iterationActions);
        const summary = session.compactMemory || session.contextSummary;

        if (
          classifyTaskIntent(task.description) === 'implementation'
          && session.compactMemory?.implementationReady
          && !session.compactMemory?.implementationStrict
          && !hasWriteLikeAction(iterationActions)
        ) {
          this.enterStrictImplementationMode(session);
          this.emitEvent(EventType.WARNING, task.id, {
            message: 'Implementation files are identified but this iteration still made no code changes. The next iteration will require a concrete patch or an explicit no-change conclusion.',
            iteration: iterationNumber,
            agent: actingAgent,
          });
        }

        const completionEligible = shouldMarkTaskCompleted(
          task.description,
          summary,
          response.content,
          iterationActions,
        );

        if (!completionEligible) {
          completed = false;
        } else if (!response.toolCalls?.length && !converged) {
          completed = true;
        }

        this.emitEvent(EventType.PLAN_GENERATED, task.id, {
          iteration: iterationNumber,
          agent: actingAgent,
          goals: [response.content.split('\n')[0] || 'Execute step'],
          actionCount: iterationActions.length,
        });

        // ── 4. Evaluate (if appropriate) ──────────────────
        if (this.shouldEvaluate(session, actingAgent)) {
          if (!await this.waitForSessionRunState(session)) break;
          this.onPhaseChange?.('evaluating');
          this.emitEvent(EventType.EVALUATION_STARTED, task.id, {
            iteration: iterationNumber,
          });

          const evaluation = await this.aceEngine.evaluateIteration(task.id, iterationNumber);

          this.emitEvent(EventType.EVALUATED, task.id, {
            iteration: iterationNumber,
            fitness: evaluation.fitness,
            drift: evaluation.drift,
            entropy: evaluation.entropy,
          });

          // Check convergence
          const fitnessDelta = Math.abs(evaluation.fitness - lastFitness);
          if (fitnessDelta < 0.02) {
            stableCount++;
          } else {
            stableCount = 0;
          }

          converged = this.aceEngine.checkConvergence(evaluation, stableCount, strategy);
          lastFitness = evaluation.fitness;
          lastEvaluation = evaluation;
          session.lastEvaluation = evaluation;

          // Record iteration
          const iteration: Iteration = {
            number: iterationNumber,
            plan: {
              goals: [response.content.split('\n')[0] || 'Execute step'],
              actions: iterationActions.map(a => ({ tool: a.tool, input: a.input, reason: '' })),
              riskLevel: 'medium',
              complexity: iterationActions.length,
            },
            executedActions: iterationActions,
            evaluation,
            durationMs: now() - stepStart,
            timestamp: stepStart,
          };
          task.iterations.push(iteration);

          // Reset actions for next iteration
          iterationActions = [];

          this.emitEvent(EventType.ITERATION_COMPLETED, task.id, {
            iteration: iterationNumber,
            converged,
            stableCount,
            fitness: evaluation.fitness,
            durationMs: iteration.durationMs,
          });

          if (converged) {
            this.emitEvent(EventType.CONVERGED, task.id, {
              iteration: iterationNumber,
              fitness: evaluation.fitness,
              totalDuration: formatDuration(now() - startTime),
            });

            // Inject strategy feedback into messages for context
            this.pushMessage(session, {
              role: 'system',
              content: `Evaluation: Converged. Fitness: ${evaluation.fitness.toFixed(3)}. Task complete.`,
            });

            session.loopState = 'stopped';
            break;
          }

          if (this.isDelegateProvider()) {
            session.loopState = 'stopped';
            break;
          }

          // Inject evaluation feedback into messages
          this.pushMessage(session, {
            role: 'system',
            content: `Evaluation feedback: fitness=${evaluation.fitness.toFixed(3)}, drift=${evaluation.drift.toFixed(2)}, entropy=${evaluation.entropy.toFixed(3)}. Continue improving.`,
          });

          if (completed) {
            session.loopState = 'stopped';
            break;
          }
        }

        // ── 5. Switch agent (multi mode, after evaluation) ──
        if (session.mode === 'multi') {
          const nextRole = this.nextAgent(actingAgent);
          if (nextRole !== actingAgent) {
            session.currentAgent = nextRole;
            this.emitEvent(EventType.AGENT_SWITCHED, task.id, {
              sessionId: session.sessionId,
              from: actingAgent,
              to: nextRole,
              step: session.step,
            });
          }
        }
      }

      const finalStatus = converged
        ? 'converged' as const
        : completed
          ? 'completed' as const
          : session.loopState === 'stopped'
            ? 'cancelled' as const
            : 'failed' as const;

      return {
        taskId: task.id,
        status: finalStatus,
        totalIterations: task.iterations.length,
        evaluation: lastEvaluation || {
          fitness: 0, drift: 0, entropy: 0, converged: false, stableCount: 0,
        },
        durationMs: now() - startTime,
        summary: converged
          ? `Converged after ${task.iterations.length} iterations (fitness: ${lastFitness.toFixed(3)})`
          : completed
            ? `Completed ${session.step} steps in ${session.mode} mode with sufficient evidence to conclude`
          : `Completed ${session.step} steps in ${session.mode} mode`,
      };
    } catch (err) {
      return {
        taskId: task.id,
        status: 'failed',
        totalIterations: task.iterations.length,
        evaluation: lastEvaluation || {
          fitness: 0, drift: 0, entropy: 0, converged: false, stableCount: 0,
        },
        durationMs: now() - startTime,
        summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ─── LLM Call (with retry) ─────────────────────────────────

  private static readonly LLM_MAX_RETRIES = 3;
  private static readonly LLM_RETRY_DELAYS = [1000, 3000, 8000]; // ms

  private async callLLM(
    agent: AgentRuntime,
    session: AgentSession,
    contextStr: string,
    toolDefs: LLMToolDef[],
  ) {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= AgentLoop.LLM_MAX_RETRIES; attempt++) {
      try {
        return await this.callLLMOnce(agent, session, contextStr, toolDefs);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isRetryable = this.isRetryableError(lastError);

        if (!isRetryable || attempt >= AgentLoop.LLM_MAX_RETRIES) {
          throw lastError;
        }

        const delay = AgentLoop.LLM_RETRY_DELAYS[attempt] || 8000;
        this.emitEvent(EventType.WARNING, session.taskId, {
          message: `LLM call failed (attempt ${attempt + 1}/${AgentLoop.LLM_MAX_RETRIES + 1}), retrying in ${delay}ms: ${lastError.message.slice(0, 200)}`,
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error('LLM call failed after retries');
  }

  private async callLLMOnce(
    agent: AgentRuntime,
    session: AgentSession,
    contextStr: string,
    toolDefs: LLMToolDef[],
  ) {
    const getProviderToolType = (toolName: string): 'read' | 'write' | 'exec' => {
      if (toolName === 'read_file' || toolName === 'grep' || toolName === 'glob' || toolName.startsWith('git_')) {
        return 'read';
      }
      if (toolName === 'write_file' || toolName === 'edit_file') {
        return 'write';
      }
      return 'exec';
    };

    const emitProviderRuntimeEvent = (event: ProviderRuntimeEvent) => {
      if (event.type === 'tool.called') {
        this.emitEvent(EventType.TOOL_CALLED, session.taskId, {
          toolName: event.toolName,
          toolType: getProviderToolType(event.toolName),
          input: event.input,
          provider: agent.llm.name,
          nativeProviderTool: true,
        });
        return;
      }

      this.emitEvent(
        event.success ? EventType.TOOL_RESULT : EventType.TOOL_ERROR,
        session.taskId,
        {
          toolName: event.toolName,
          output: event.output,
          durationMs: event.durationMs || 0,
          success: event.success,
          error: event.error,
          provider: agent.llm.name,
          nativeProviderTool: true,
        },
      );
    };

    // Build streaming options
    const llmOptions: LLMCallOptions | undefined = this.onStreamChunk
      ? {
          providerSessionId: `${session.taskId}:${session.sessionId}:${session.currentAgent}`,
          onTextChunk: (text: string) => {
            this.onStreamChunk!(text, { taskId: session.taskId, agent: session.currentAgent });
          },
          onProviderEvent: emitProviderRuntimeEvent,
        }
      : {
          providerSessionId: `${session.taskId}:${session.sessionId}:${session.currentAgent}`,
          onProviderEvent: emitProviderRuntimeEvent,
        };

    // Use AgentRuntime.runTurn() if available (Phase 2.7)
    if ('runTurn' in agent && typeof agent.runTurn === 'function') {
      return agent.runTurn({
        messages: session.messages,
        context: contextStr,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        options: llmOptions,
      });
    }

    // Fallback for legacy AgentRuntime interface
    if (agent.llm.chatWithContext) {
      return agent.llm.chatWithContext(
        session.messages,
        agent.systemPrompt,
        contextStr,
        toolDefs.length > 0 ? toolDefs : undefined,
        llmOptions,
      );
    }

    const messagesWithSystem: ChatMessage[] = [
      { role: 'system', content: `${agent.systemPrompt}\n\n${contextStr}` },
      ...session.messages.filter(m => m.role !== 'system'),
    ];
    return agent.llm.chat(
      messagesWithSystem,
      toolDefs.length > 0 ? toolDefs : undefined,
    );
  }

  private emitUsageEvent(
    taskId: string,
    session: AgentSession,
    agent: AgentRole,
    iteration: number,
    usage: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number; cacheCreateTokens?: number },
  ): void {
    this.emitEvent('session.usage' as EventType, taskId, {
      sessionId: session.sessionId,
      agent,
      iteration,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      cacheRead: usage.cacheReadTokens || 0,
      cacheCreate: usage.cacheCreateTokens || 0,
    });
  }

  /** Determine if an LLM error is retryable */
  private isRetryableError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    // Retry on: rate limits, server errors, timeouts, overloaded
    if (msg.includes('429') || msg.includes('rate limit')) return true;
    if (msg.includes('500') || msg.includes('502') || msg.includes('503')) return true;
    if (msg.includes('529') || msg.includes('overloaded')) return true;
    if (msg.includes('timeout') || msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused') || msg.includes('network')) return true;
    // Don't retry on: auth errors, bad requests (schema errors), etc.
    return false;
  }

  // ─── Tool Call Handling ───────────────────────────────────

  private async handleToolCalls(
    task: Task,
    session: AgentSession,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    likelyTargetPaths: string[],
  ) {
    const toolContext = {
      cwd: task.projectPath || process.cwd(),
      taskId: task.id,
      likelyTargetPaths,
      implementationReady: sessionMemorySuggestsImplementation(session.compactMemory || session.contextSummary),
    };

    // Classify tools: EXEC tools must be sequential, READ+WRITE can be parallel
    // LLM decided these tools are independent (same response), so safe to parallelize
    const execToolNames = new Set<string>();
    const allTools = this.toolScheduler['registry'].list();
    for (const t of allTools) {
      if (t.type === 'exec') execToolNames.add(t.name);
    }

    // Split into groups: non-EXEC → parallel batch, EXEC → sequential
    type CallGroup = { parallel: boolean; calls: typeof toolCalls };
    const groups: CallGroup[] = [];

    for (const call of toolCalls) {
      const isExec = execToolNames.has(call.name);
      const lastGroup = groups[groups.length - 1];

      if (!isExec) {
        // READ and WRITE tools can be parallelized
        if (lastGroup?.parallel) {
          lastGroup.calls.push(call);
        } else {
          groups.push({ parallel: true, calls: [call] });
        }
      } else {
        // EXEC tools must be sequential (side effects)
        groups.push({ parallel: false, calls: [call] });
      }
    }

    const executedActions: Array<{
      tool: string;
      input: unknown;
      output: unknown;
      success: boolean;
      error?: string;
      durationMs: number;
    }> = [];

    // Execute each group
    for (const group of groups) {
      if (group.parallel && group.calls.length > 1) {
        // Execute READ tools in parallel
        const results = await Promise.all(
          group.calls.map(async (call) => {
            const start = now();
            const result = await this.toolScheduler.execute(call.name, call.arguments, toolContext);
            return { call, result, durationMs: now() - start };
          }),
        );

        // Record all results in order
        for (const { call, result, durationMs } of results) {
          this.recordToolResult(task, session, call, result, durationMs);
          executedActions.push({
            tool: call.name, input: call.arguments,
            output: result.output, success: result.success,
            error: result.error, durationMs,
          });
        }
      } else {
        // Execute sequentially (WRITE/EXEC tools, or single READ)
        for (const call of group.calls) {
          const start = now();
          const result = await this.toolScheduler.execute(call.name, call.arguments, toolContext);
          const durationMs = now() - start;

          this.recordToolResult(task, session, call, result, durationMs);
          executedActions.push({
            tool: call.name, input: call.arguments,
            output: result.output, success: result.success,
            error: result.error, durationMs,
          });
        }
      }
    }

    return executedActions;
  }

  /** Record a single tool result to session messages and events */
  private async recordToolResult(
    task: Task,
    session: AgentSession,
    call: { id: string; name: string; arguments: Record<string, unknown> },
    result: { success: boolean; output: unknown; error?: string },
    _durationMs: number,
  ): Promise<void> {
    const resultStr = typeof result.output === 'string'
      ? result.output
      : JSON.stringify(result.output);

    let messageContent: string;
    if (this.toolResultStore && this.toolResultStore.shouldStore(resultStr)) {
      const ref = await this.toolResultStore.store(task.id, call.id, call.name, resultStr, !result.success);
      messageContent = `[Tool output stored: ${ref.byteSize} bytes${ref.truncated ? ', truncated preview' : ''}]\n${ref.preview}`;
    } else {
      messageContent = result.success
        ? resultStr.slice(0, 10000)
        : `Error: ${result.error || 'Unknown error'}`;
    }

    this.pushMessage(session, {
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: messageContent,
    });

    this.emitEvent(EventType.SESSION_MESSAGE, task.id, {
      sessionId: session.sessionId,
      role: 'tool',
      tool: call.name,
      success: result.success,
    });
  }

  private recordPolicyDeniedToolCalls(
    task: Task,
    session: AgentSession,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    reason: string,
  ): void {
    for (const call of toolCalls) {
      this.emitEvent(EventType.TOOL_ERROR, task.id, {
        toolName: call.name,
        output: null,
        durationMs: 0,
        success: false,
        error: reason,
        policyDenied: true,
      });

      this.pushMessage(session, {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: `Error: ${reason}`,
      });

      this.emitEvent(EventType.SESSION_MESSAGE, task.id, {
        sessionId: session.sessionId,
        role: 'tool',
        tool: call.name,
        success: false,
      });
    }
  }

  private getImplementationToolDefs(toolDefs: LLMToolDef[]): LLMToolDef[] {
    const writeOnly = toolDefs.filter((tool) => tool.name === 'edit_file' || tool.name === 'write_file');
    return writeOnly.length > 0 ? writeOnly : toolDefs;
  }

  private constrainToolDefsForSession(
    toolDefs: LLMToolDef[],
    session: AgentSession,
    role: AgentRole,
  ): LLMToolDef[] {
    if (role !== 'coder') return toolDefs;
    if (!session.compactMemory?.implementationStrict) return toolDefs;
    return this.getImplementationToolDefs(toolDefs);
  }

  private enterStrictImplementationMode(session: AgentSession): void {
    const previous = session.compactMemory;
    if (!previous) return;
    if (previous.implementationStrict) return;

    session.compactMemory = {
      ...previous,
      implementationReady: true,
      implementationStrict: true,
      currentFocus: 'implementation',
    };
    session.contextSummary = this.renderCompactMemory(session.compactMemory as SessionCompactMemory);
  }

  // ─── Agent Switching ──────────────────────────────────────

  private nextAgent(current: AgentRole): AgentRole {
    switch (current) {
      case 'planner': return 'coder';
      case 'coder': return 'reviewer';
      case 'reviewer': return 'coder';
    }
  }

  private isDelegateProvider(): boolean {
    return this.llmProvider.name === 'codex-delegate';
  }

  private shouldEvaluate(session: AgentSession, actingAgent: AgentRole): boolean {
    if (session.mode === 'single') return true;
    // In multi mode, evaluate after reviewer
    return actingAgent === 'reviewer';
  }

  // ─── Tool Definitions ─────────────────────────────────────

  /**
   * Convert a Zod schema (or raw object) to a valid JSON Schema
   * that LLM providers (Claude/OpenAI) require.
   */
  private toJsonSchema(schema: any): Record<string, unknown> {
    // If it already looks like a JSON Schema (has "type" field), use it
    if (schema && typeof schema === 'object' && 'type' in schema) {
      return schema;
    }

    // If it's a Zod schema, extract properties from its shape
    if (schema && typeof schema === 'object' && '_def' in schema) {
      try {
        const def = schema._def;
        // ZodObject
        if (def.typeName === 'ZodObject' && schema.shape) {
          const properties: Record<string, any> = {};
          const required: string[] = [];

          for (const [key, value] of Object.entries(schema.shape)) {
            const fieldDef = (value as any)?._def;
            if (!fieldDef) continue;

            let prop: Record<string, any> = { type: 'string' };

            // Unwrap ZodOptional
            let innerDef = fieldDef;
            let isOptional = false;
            if (innerDef.typeName === 'ZodOptional') {
              isOptional = true;
              innerDef = innerDef.innerType?._def || innerDef;
            }

            // Map Zod types to JSON Schema
            switch (innerDef.typeName) {
              case 'ZodString': prop = { type: 'string' }; break;
              case 'ZodNumber': prop = { type: 'number' }; break;
              case 'ZodBoolean': prop = { type: 'boolean' }; break;
              case 'ZodArray': prop = { type: 'array' }; break;
              default: prop = { type: 'string' }; break;
            }

            // Add description if available
            if (innerDef.description) {
              prop.description = innerDef.description;
            } else if (fieldDef.description) {
              prop.description = fieldDef.description;
            }

            properties[key] = prop;
            if (!isOptional) required.push(key);
          }

          const result: Record<string, unknown> = {
            type: 'object',
            properties,
          };
          if (required.length > 0) result.required = required;
          return result;
        }
      } catch {
        // Fall through to default
      }
    }

    // Fallback: empty object schema
    return { type: 'object', properties: {} };
  }

  private getAgentSpec(agent: AgentRuntime | undefined): AgentSpec | undefined {
    if (!agent || typeof agent !== 'object') return undefined;
    if (!('spec' in agent)) return undefined;
    return (agent as { spec?: AgentSpec }).spec;
  }

  private getToolDefs(role: AgentRole, spec?: AgentSpec): LLMToolDef[] {
    const allTools = this.toolScheduler['registry'].list();
    const filteredTools = spec?.allowedTools?.length
      ? allTools.filter((tool) => spec.allowedTools!.includes(tool.name))
      : allTools;
    const preferredOrder = new Map((spec?.preferredTools || []).map((toolName, index) => [toolName, index]));
    const orderedTools = filteredTools.slice().sort((left, right) => {
      const leftRank = preferredOrder.has(left.name) ? preferredOrder.get(left.name)! : Number.MAX_SAFE_INTEGER;
      const rightRank = preferredOrder.has(right.name) ? preferredOrder.get(right.name)! : Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.name.localeCompare(right.name);
    });

    const mapTool = (t: any): LLMToolDef => {
      let description = t.description;

      if (t.name === 'bash') {
        description += ' Use only when structured tools are insufficient. Avoid broad `find` or repo-wide search if likely target paths are already available in context.';
      } else if (t.name === 'glob') {
        description += ' Preferred for narrowing candidate files or modules before using shell search.';
      } else if (t.name === 'grep') {
        description += ' Preferred for locating symbols or features inside likely target paths.';
      } else if (t.name === 'read_file') {
        description += ' Preferred for validating likely target files before widening exploration.';
      }

      return {
        name: t.name,
        description,
        inputSchema: this.toJsonSchema(t.inputSchema),
      };
    };

    if (role === 'planner') {
      return orderedTools.filter(t => t.type === 'read').map(mapTool);
    }

    if (role === 'reviewer') {
      return orderedTools.filter(t => t.type === 'read' || t.type === 'exec').map(mapTool);
    }

    return orderedTools.map(mapTool);
  }

  // ─── Context Building ─────────────────────────────────────

  private buildContextString(
    task: Task,
    context: AgentContext,
    strategy: ConvergenceStrategy,
  ): string {
    const constraintText = this.injectedConstraints.length > 0
      ? `\nInjected Constraints:\n${this.injectedConstraints.map(c => `- ${c}`).join('\n')}`
      : '';

    return [
      `Task: ${task.description}`,
      `Strategy: ${strategy}`,
      `Project: ${task.projectPath || 'unknown'}`,
      constraintText,
      '',
      `Context:\n${JSON.stringify(context, null, 2).slice(0, 20000)}`,
    ].join('\n');
  }

  private extractLikelyTargetPaths(envelope: RuntimeContextEnvelope, projectPath: string): string[] {
    const candidates = (envelope.execution.repo as { candidates?: Array<{ path: string }> } | undefined)?.candidates || [];
    const resolved = candidates
      .map((candidate) => candidate?.path)
      .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
      .map((candidate) => {
        if (candidate.startsWith('/')) return candidate;
        return `${projectPath.replace(/\/+$/, '')}/${candidate.replace(/^\/+/, '')}`;
      });

    return Array.from(new Set(resolved)).slice(0, 5);
  }

  // ─── Message Management ───────────────────────────────────

  private pushMessage(session: AgentSession, message: ChatMessage): void {
    session.messages.push(message);
  }

  // ─── Session Memory ───────────────────────────────────────

  /**
   * Update session.contextSummary with structured session memory.
   * Rule-based extraction — no LLM calls.
   * Tracks: goal, key files, recent actions, decisions, blockers.
   */
  private updateContextSummary(
    session: AgentSession,
    agent: AgentRole,
    responseContent: string,
    actions: Array<{ tool: string; input: unknown; output?: unknown; success: boolean; error?: string }>,
  ): void {
    const previous = session.compactMemory || {};
    const prevFiles = previous.keyFiles || [];
    const prevPending = previous.pendingWork || [];
    const prevBlockers = previous.blockers || [];

    const files = actions.flatMap((action) => this.extractRelevantPaths(action));

    const failures = actions
      .filter(a => !a.success)
      .map(a => `${a.tool}: ${a.error || 'failed'}`);

    const allFiles = [...new Set([...prevFiles, ...files])].slice(-10);
    const loweredFiles = allFiles.map(f => f.toLowerCase());
    const hasCacheSignal = loweredFiles.some(f => f.includes('cache'));
    const hasQueryOrServiceSignal = loweredFiles.some(
      f => f.includes('query') || f.includes('service'),
    );
    const implementationReady = hasCacheSignal && hasQueryOrServiceSignal;
    const wroteCode = hasWriteLikeAction(actions);
    const explicitNoChange = assistantSuggestsNoCodeChangeNeeded(responseContent);

    const actionSummary = actions.slice(-5).map(a => `${a.tool}(${a.success ? 'ok' : 'fail'})`).join(', ');
    const recentActions = actionSummary
      ? [...(previous.recentActions || []), actionSummary].slice(-5)
      : (previous.recentActions || []);

    const pendingWork: string[] = [];
    if (explicitNoChange) {
      // Clear implementation-style pending work when the assistant has concluded
      // that existing code already satisfies the requested behavior.
    } else if (wroteCode) {
      pendingWork.push('Verify the implemented change and summarize the affected flow');
    } else if (implementationReady) {
      pendingWork.push('Implement the missing cache usage in the identified query/service flow');
    } else if (allFiles.length > 0) {
      pendingWork.push('Read the most relevant query/service implementation and cache integration points');
    }
    if (agent === 'reviewer') {
      pendingWork.push('Verify correctness and regressions in the changed flow');
    }
    const mergedPending = explicitNoChange
      ? []
      : [...new Set([...prevPending, ...pendingWork])].slice(-3);
    const mergedBlockers = [...new Set([...prevBlockers, ...failures])].slice(-3);
    const currentWork = explicitNoChange
      ? 'Explain why no code changes are required and cite the supporting implementation files'
      : wroteCode
        ? 'Summarize the implemented changes and note any follow-up verification'
        : implementationReady
          ? 'Implement the missing cache usage in the identified query/service flow'
          : 'Identify the exact query/service and cache integration points';

    const goal = agent === 'planner' && responseContent.length > 10
      ? responseContent.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 150) || previous.goal
      : previous.goal;

    const compactMemory: SessionCompactMemory = {
      goal,
      currentAgent: agent,
      step: session.step,
      keyFiles: allFiles,
      recentActions,
      pendingWork: mergedPending,
      currentWork,
      blockers: mergedBlockers,
      implementationReady,
      implementationStrict: !!previous.implementationStrict,
      currentFocus: implementationReady
          ? 'implementation'
          : 'exploration',
    };

    session.compactMemory = compactMemory;
    session.contextSummary = this.renderCompactMemory(compactMemory);
  }

  private renderCompactMemory(memory: SessionCompactMemory): string {
    const lines = ['Conversation summary:'];
    if (memory.goal) lines.push(`- Goal: ${memory.goal}`);
    if (memory.currentAgent) lines.push(`- Current agent: ${memory.currentAgent}`);
    if (typeof memory.step === 'number') lines.push(`- Step: ${memory.step}`);
    if (memory.keyFiles?.length) lines.push(`- Key files: ${memory.keyFiles.join(', ')}`);
    if (memory.recentActions?.length) lines.push(`- Recent actions: ${memory.recentActions.join(', ')}`);
    if (memory.pendingWork?.length) lines.push(`- Pending work: ${memory.pendingWork.join(' | ')}`);
    if (memory.currentWork) lines.push(`- Current work: ${memory.currentWork}`);
    if (memory.blockers?.length) lines.push(`- Blockers: ${memory.blockers.join(' | ')}`);
    if (typeof memory.implementationReady === 'boolean') {
      lines.push(`- Implementation ready: ${memory.implementationReady ? 'yes' : 'no'}`);
    }
    if (typeof memory.implementationStrict === 'boolean') {
      lines.push(`- Implementation strict: ${memory.implementationStrict ? 'yes' : 'no'}`);
    }
    if (memory.currentFocus) lines.push(`- Current focus: ${memory.currentFocus}`);
    return lines.join('\n');
  }

  private extractRelevantPaths(action: {
    tool: string;
    input: unknown;
    output?: unknown;
    success: boolean;
  }): string[] {
    if (!action.success) return [];

    const directPath = (() => {
      const input = action.input as Record<string, unknown> | undefined;
      const value = input?.path || input?.file_path;
      return typeof value === 'string' ? [value] : [];
    })();

    const fromArrayOutput = Array.isArray(action.output)
      ? action.output.filter((value): value is string => typeof value === 'string')
      : [];

    const fromStructuredStdout = (() => {
      if (!action.output || typeof action.output !== 'object') return [];
      const stdout = (action.output as { stdout?: unknown }).stdout;
      if (typeof stdout !== 'string') return [];
      return this.extractPathsFromText(stdout);
    })();

    const fromStringOutput = typeof action.output === 'string'
      ? this.extractPathsFromText(action.output)
      : [];

    return [...new Set([
      ...directPath,
      ...fromArrayOutput,
      ...fromStructuredStdout,
      ...fromStringOutput,
    ])].slice(0, 20);
  }

  private extractPathsFromText(text: string): string[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) =>
        line.length > 0
        && (
          line.includes('.java')
          || line.includes('.kt')
          || line.includes('.xml')
          || line.includes('.yml')
          || line.includes('.yaml')
        )
        && (line.includes('/') || line.includes('\\'))
      )
      .slice(0, 20);
  }

  // ─── Control Methods ──────────────────────────────────────

  handleControl(command: ControlCommand, session?: AgentSession): void {
    switch (command.type) {
      case 'stop':
        if (session) session.loopState = 'stopped';
        this.toolScheduler.cancelAll();
        break;
      case 'pause':
        if (session) session.loopState = 'paused';
        break;
      case 'resume':
        if (session) session.loopState = 'running';
        break;
      case 'inject_constraint':
        this.injectedConstraints.push(command.constraint);
        break;
      case 'change_strategy':
        this.currentStrategy = command.strategy;
        break;
      case 'modify_plan':
        this.pendingPlanPatch = command.modifications;
        break;
    }
  }

  private async waitForSessionRunState(session?: AgentSession): Promise<boolean> {
    if (!session) {
      return true;
    }

    while (session.loopState === 'paused') {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return session.loopState === 'running';
  }

  // ─── Legacy Mode (Phase 1 Compatibility) ──────────────────

  private async runLegacy(task: Task): Promise<TaskResult> {
    const startTime = now();
    let currentIteration = 0;
    let stableCount = 0;
    let lastFitness = 0;
    let converged = false;
    let lastEvaluation: EvaluationSnapshot | undefined;
    let aborted = false;
    let paused = false;

    // Legacy handleControl bindings
    const originalHandleControl = this.handleControl.bind(this);
    this.handleControl = (command: ControlCommand) => {
      switch (command.type) {
        case 'stop':
          aborted = true;
          this.toolScheduler.cancelAll();
          break;
        case 'pause':
          paused = true;
          break;
        case 'resume':
          paused = false;
          break;
        case 'inject_constraint':
          this.injectedConstraints.push(command.constraint);
          break;
        case 'change_strategy':
          this.currentStrategy = command.strategy;
          break;
        case 'modify_plan':
          this.pendingPlanPatch = command.modifications;
          break;
      }
    };

    try {
      while (!converged && currentIteration < task.maxIterations && !aborted) {
        while (paused && !aborted) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (aborted) break;

        currentIteration++;
        const strategy = this.currentStrategy || task.strategy;

        this.emitEvent(EventType.ITERATION_STARTED, task.id, {
          iteration: currentIteration,
          maxIterations: task.maxIterations,
          strategy,
        });

        const iterationStart = now();

        // Step 1: Build Context
        const context = await this.contextBuilder.buildContext(task.id, currentIteration, {
          agent: 'planner',
          environmentPackId: task.environmentPackSnapshot?.id,
          environmentPackSelection: task.environmentPackSelection,
        });
        this.emitEvent(EventType.CONTEXT_BUILT, task.id, {
          iteration: currentIteration,
          tokensUsed: context.meta.tokensUsed,
        });

        // Step 2: Generate Plan
        this.onPhaseChange?.('planning');
        this.emitEvent(EventType.PLAN_STARTED, task.id, { iteration: currentIteration });

        let plan = await this.generatePlan(task, context, currentIteration);

        if (this.pendingPlanPatch) {
          if (this.pendingPlanPatch.actions) plan.actions = this.pendingPlanPatch.actions;
          if (this.pendingPlanPatch.goals) plan.goals = this.pendingPlanPatch.goals;
          this.pendingPlanPatch = null;
          this.emitEvent(EventType.PLAN_UPDATED, task.id, {
            iteration: currentIteration,
            reason: 'human_modification',
          });
        }

        this.emitEvent(EventType.PLAN_GENERATED, task.id, {
          iteration: currentIteration,
          goals: plan.goals,
          actionCount: plan.actions.length,
        });

        // Step 3: Execute Plan
        this.onPhaseChange?.('executing');
        this.emitEvent(EventType.EXECUTION_STARTED, task.id, {
          iteration: currentIteration,
          actionCount: plan.actions.length,
        });

        const executedActions = await this.executePlan(task, plan);

        const failCount = executedActions.filter(a => !a.success).length;
        const successCount = executedActions.filter(a => a.success).length;
        if (executedActions.length > 0 && successCount === 0) {
          this.emitEvent(EventType.WARNING, task.id, {
            message: `All ${failCount} actions failed in iteration ${currentIteration}`,
          });
        }

        // Step 4: Evaluate
        this.onPhaseChange?.('evaluating');
        this.emitEvent(EventType.EVALUATION_STARTED, task.id, { iteration: currentIteration });

        const evaluation = await this.aceEngine.evaluateIteration(task.id, currentIteration);

        this.emitEvent(EventType.EVALUATED, task.id, {
          iteration: currentIteration,
          fitness: evaluation.fitness,
          drift: evaluation.drift,
          entropy: evaluation.entropy,
        });

        // Step 5: Check Convergence
        const fitnessDelta = Math.abs(evaluation.fitness - lastFitness);
        if (fitnessDelta < 0.02) stableCount++;
        else stableCount = 0;

        converged = this.aceEngine.checkConvergence(evaluation, stableCount, strategy);
        lastFitness = evaluation.fitness;
        lastEvaluation = evaluation;

        const iteration: Iteration = {
          number: currentIteration,
          plan,
          executedActions,
          evaluation,
          durationMs: now() - iterationStart,
          timestamp: iterationStart,
        };
        task.iterations.push(iteration);

        this.emitEvent(EventType.ITERATION_COMPLETED, task.id, {
          iteration: currentIteration,
          converged,
          stableCount,
          fitness: evaluation.fitness,
          durationMs: iteration.durationMs,
        });

        if (converged) {
          this.emitEvent(EventType.CONVERGED, task.id, {
            iteration: currentIteration,
            fitness: evaluation.fitness,
            totalDuration: formatDuration(now() - startTime),
          });
        }
      }

      const finalStatus = converged ? 'converged' as const : aborted ? 'cancelled' as const : 'failed' as const;

      return {
        taskId: task.id,
        status: finalStatus,
        totalIterations: currentIteration,
        evaluation: lastEvaluation || {
          fitness: 0, drift: 0, entropy: 0, converged: false, stableCount: 0,
        },
        durationMs: now() - startTime,
        summary: converged
          ? `Converged after ${currentIteration} iterations (fitness: ${lastFitness.toFixed(3)})`
          : `Failed to converge after ${currentIteration} iterations`,
      };
    } catch (err) {
      return {
        taskId: task.id,
        status: 'failed',
        totalIterations: currentIteration,
        evaluation: lastEvaluation || {
          fitness: 0, drift: 0, entropy: 0, converged: false, stableCount: 0,
        },
        durationMs: now() - startTime,
        summary: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      this.handleControl = originalHandleControl;
    }
  }

  // ─── Legacy Plan Generation ───────────────────────────────

  private async generatePlan(
    task: Task,
    context: AgentContext,
    iteration: number,
  ): Promise<Plan> {
    const strategy = this.currentStrategy || task.strategy;
    const constraintText = this.injectedConstraints.length > 0
      ? `\n\nInjected Constraints:\n${this.injectedConstraints.map(c => `- ${c}`).join('\n')}`
      : '';

    const prompt = [
      `Task: ${task.description}`,
      `Iteration: ${iteration}/${task.maxIterations}`,
      `Strategy: ${strategy}`,
      constraintText,
      '',
      'Generate a plan with specific tool actions.',
    ].join('\n');

    const contextStr = JSON.stringify(context, null, 2);
    const response = await this.llmProvider.plan(prompt, contextStr);

    return {
      goals: response.goals,
      actions: response.actions.map(a => ({
        tool: a.tool,
        input: a.input,
        reason: a.reason,
      })),
      riskLevel: 'medium',
      complexity: response.actions.length,
    };
  }

  private async executePlan(task: Task, plan: Plan) {
    const context = {
      cwd: task.projectPath || process.cwd(),
      taskId: task.id,
    };

    const actions = plan.actions.map((a) => ({
      toolName: a.tool,
      input: a.input,
      dependsOn: a.dependsOn,
    }));

    const results = await this.toolScheduler.executeBatch(actions, context);

    return results.map((r, i) => ({
      tool: plan.actions[i].tool,
      input: plan.actions[i].input,
      output: r.output,
      success: r.success,
      error: r.error,
      durationMs: r.durationMs,
    }));
  }

  // ─── Event Emission ───────────────────────────────────────

  private emitEvent(type: EventType, taskId: string, payload: unknown): void {
    this.eventBus.emit({ id: generateId(), type, taskId, payload, timestamp: now() });
  }
}
