# Tik Runtime Contract

> 状态机 + 事件契约 + 控制契约

## 1. Task State Machine

```
           ┌─────────────────────────────────────────┐
           │              cancelled                   │
           └──────────▲──────▲──────▲────────────────┘
                      │      │      │
  pending → planning → executing → evaluating → converged
                │               ↗       │
                │       ┌──────┘        │
                │       │               ↓
                └───────┼────────── failed
                        │
           planning ────┼──→ paused
           executing ───┤      │
           evaluating ──┘      └──→ executing
```

### Transitions

| From | To | Trigger |
|------|----|---------|
| pending | planning | kernel.submitTask / kernel.runTask |
| planning | executing | plan generated |
| executing | evaluating | all tools executed |
| evaluating | executing | not converged, next iteration |
| evaluating | converged | convergence criteria met |
| evaluating | failed | max iterations reached |
| planning | failed | LLM error |
| executing | failed | unrecoverable tool error |
| planning/executing/evaluating | cancelled | ControlCommand: stop |
| planning/executing/evaluating | paused | ControlCommand: pause |
| paused | executing | ControlCommand: resume |
| paused | cancelled | ControlCommand: stop |

### Terminal States

- converged
- completed
- failed
- cancelled

Terminal state semantics:

- `converged`: evaluation-threshold success. ACE/convergence metrics reached the configured stop condition.
- `completed`: evidence-sufficient success. Tik has enough task/workspace evidence to stop successfully even if a numeric convergence threshold was not reached, such as exploration, diagnosis, or document-only workflows.
- `failed`: runtime or task failure that cannot be safely recovered automatically.
- `cancelled`: user-initiated cancellation.

## 2. Event Contract

All state changes MUST be expressed as events. EventBus is the single source of truth.

### Event Structure

```typescript
interface AgentEvent<T = unknown> {
  id: string;           // Unique event ID
  type: EventType;      // Event type enum
  taskId: string;       // Associated task
  payload: T;           // Type-specific data
  timestamp: number;    // Unix ms
  metadata?: Record<string, unknown>;
}
```

### Required Events

#### Task Lifecycle
| Event | When | Payload |
|-------|------|---------|
| TASK_CREATED | task created | Task object |
| TASK_STARTED | status → planning/executing/evaluating | { status, previousStatus } |
| TASK_COMPLETED | status → converged | { status } |
| TASK_FAILED | status → failed | { status } |
| TASK_CANCELLED | status → cancelled | { status } |
| TASK_PAUSED | status → paused | { status } |
| TASK_RESUMED | paused → executing | { status } |

#### Iteration Lifecycle
| Event | When | Payload |
|-------|------|---------|
| ITERATION_STARTED | begin iteration | { iteration, maxIterations, strategy } |
| ITERATION_COMPLETED | end iteration | { iteration, converged, stableCount, fitness, durationMs } |

#### Planning Phase
| Event | When | Payload |
|-------|------|---------|
| PLAN_STARTED | before LLM call | { iteration } |
| PLAN_GENERATED | plan ready | { iteration, goals, actionCount } |
| PLAN_UPDATED | plan modified by human | { iteration, reason } |

#### Execution Phase
| Event | When | Payload |
|-------|------|---------|
| EXECUTION_STARTED | before tool execution | { iteration, actionCount } |
| TOOL_CALLED | tool invoked | { toolName, toolType, input } |
| TOOL_RESULT | tool succeeded | { toolName, output, durationMs, success } |
| TOOL_ERROR | tool failed | { toolName, error, durationMs, success: false } |

#### Evaluation Phase
| Event | When | Payload |
|-------|------|---------|
| EVALUATION_STARTED | before ACE evaluation | { iteration } |
| EVALUATED | evaluation complete | { iteration, fitness, drift, entropy } |
| FITNESS_CALCULATED | fitness details | { iteration, score, components } |
| DRIFT_DETECTED | drift details | { iteration, magnitude, trend, dimensions } |
| ENTROPY_CALCULATED | entropy details | { iteration, delta, budgetRemaining } |
| CONVERGED | convergence achieved | { iteration, fitness, totalDuration } |

#### Human Control
| Event | When | Payload |
|-------|------|---------|
| CONTROL_RECEIVED | any control command | ControlCommand object |
| CONSTRAINT_INJECTED | constraint added | { constraint } |
| STRATEGY_CHANGED | strategy changed | { strategy } |

#### System
| Event | When | Payload |
|-------|------|---------|
| WARNING | non-fatal issue | { message } |
| ERROR | fatal issue | { message, stack? } |

### Event Ordering Guarantee

Within a single iteration, events MUST be emitted in this order:

```
ITERATION_STARTED
  → CONTEXT_BUILT
  → PLAN_STARTED
  → PLAN_GENERATED
  → EXECUTION_STARTED
    → TOOL_CALLED → TOOL_RESULT/TOOL_ERROR  (per tool)
  → EVALUATION_STARTED
    → FITNESS_CALCULATED
    → DRIFT_DETECTED
    → ENTROPY_CALCULATED
  → EVALUATED
ITERATION_COMPLETED
```

## 3. Control Contract

### Control Commands

```typescript
type ControlCommand =
  | { type: 'stop' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'inject_constraint'; constraint: string }
  | { type: 'change_strategy'; strategy: ConvergenceStrategy }
  | { type: 'modify_plan'; modifications: Partial<Plan> };
```

### Command Behavior

| Command | Immediate Effect | Event |
|---------|-----------------|-------|
| stop | aborted=true, cancel all tools, status→cancelled | CONTROL_RECEIVED → TASK_CANCELLED |
| pause | paused=true, loop waits, status→paused | CONTROL_RECEIVED → TASK_PAUSED |
| resume | paused=false, loop continues, status→executing | CONTROL_RECEIVED → TASK_RESUMED |
| inject_constraint | added to constraint list | CONTROL_RECEIVED → CONSTRAINT_INJECTED |
| change_strategy | update convergence gate thresholds | CONTROL_RECEIVED → STRATEGY_CHANGED |
| modify_plan | set pendingPlanPatch for next iteration | CONTROL_RECEIVED → PLAN_UPDATED |

### API Endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /api/tasks | CreateTaskInput | Task |
| GET | /api/tasks | — | Task[] |
| GET | /api/tasks/:id | — | Task |
| POST | /api/tasks/:id/control | ControlCommand | { ok: true } |
| GET | /api/tasks/:id/events | — | SSE stream |
| GET | /api/health | — | { status, uptime } |

### SSE Event Format

```
data: {"id":"...","type":"tool.called","taskId":"...","payload":{...},"timestamp":...}

data: {"id":"...","type":"evaluation.completed","taskId":"...","payload":{...},"timestamp":...}
```

## 4. Convergence Contract

### Default Thresholds (incremental)

| Criterion | Threshold | Operator |
|-----------|-----------|----------|
| fitness | 0.80 | >= |
| drift | 3.0 | < |
| entropy | 0.5 | < |
| critical_gates | true | === |
| stable_count | 2 | >= |

### Strategy Variants

| Strategy | fitness | drift | entropy | stable |
|----------|---------|-------|---------|--------|
| incremental | 0.80 | 3.0 | 0.5 | 2 |
| aggressive | 0.70 | 4.0 | 0.7 | 1 |
| defensive | 0.85 | 2.0 | 0.3 | 3 |

### Fitness Formula

```
components = geometric_mean(quality, correctness, stability, complexity)
drift_penalty = drift >= 5.0 ? 0.6 : drift >= 3.0 ? 0.8 : 1.0
entropy_penalty = delta >= 1.0 ? 0.5 : delta >= 0.5 ? 0.7 : 1.0
constraint_penalty = min(soft_failures * 0.05, 0.50)
fitness = components * drift_penalty * entropy_penalty * (1 - constraint_penalty)
```
