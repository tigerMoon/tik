/**
 * Mock LLM Provider
 *
 * Placeholder LLM provider for development/testing.
 * In production, replace with Claude/OpenAI API integration.
 */

import type { ILLMProvider, LLMPlanResponse, ChatMessage, ChatResponse, LLMToolDef, LLMCallOptions } from '@tik/shared';

const CREATION_STYLE_VERBS = [
  '设计一个',
  '做一个',
  '创建一个',
  '生成一个',
  '搭一个',
  '写一个',
  'build ',
  'create ',
  'make ',
];

const CREATION_STYLE_ARTIFACT_HINTS = [
  '页面',
  '网页',
  'h5',
  'html',
  '游戏',
  'demo',
  'app',
  '应用',
  '组件',
  '网站',
  'landing page',
  'tool',
  '工具',
  '脚本',
  'script',
  'bot',
];

export class MockLLMProvider implements ILLMProvider {
  name = 'mock';

  async plan(prompt: string, _context: string): Promise<LLMPlanResponse> {
    const taskText = extractLineValue(prompt, 'Task:') || prompt;
    const syntheticMessages: ChatMessage[] = [{ role: 'user', content: taskText }];

    if (isHighRiskApprovalRequest(syntheticMessages)) {
      return {
        goals: ['Perform the requested high-risk action with operator approval'],
        actions: [
          {
            tool: 'bash',
            input: { command: 'echo publish dry-run' },
            reason: 'Run a publish-style dry run that should pause for operator approval first.',
          },
        ],
        reasoning: 'This task looks like a publish/deploy request, so the mock runtime should exercise the approval gate.',
      };
    }

    if (isImplementationRequest(syntheticMessages)) {
      return {
        goals: ['Implement the requested feature'],
        actions: [
          {
            tool: 'read_file',
            input: { path: 'package.json' },
            reason: 'Understand project structure before applying the mock implementation.',
          },
          {
            tool: 'write_file',
            input: buildMockWriteArguments(syntheticMessages),
            reason: 'Create the mock implementation artifact for the requested task.',
          },
        ],
        reasoning: 'This task looks like implementation work, so the mock plan should produce a tangible artifact.',
      };
    }

    return {
      goals: ['Inspect the current project'],
      actions: [
        {
          tool: 'read_file',
          input: { path: 'package.json' },
          reason: 'Understand project structure',
        },
      ],
      reasoning: 'Starting with a simple read so the pipeline has baseline output for non-implementation tasks.',
    };
  }

  async complete(prompt: string, _options?: LLMCallOptions): Promise<string> {
    if (prompt.includes('Return ONLY the final markdown body for the target spec document.')) {
      return buildMockSpecDocument(prompt);
    }
    if (prompt.includes('Return ONLY the final markdown body for the target plan document.')) {
      return buildMockPlanDocument(prompt);
    }
    return `[Mock LLM Response] Processed: ${prompt.slice(0, 50)}...`;
  }

  async chat(_messages: ChatMessage[], _tools?: LLMToolDef[]): Promise<ChatResponse> {
    return {
      content: '[Mock Chat Response]',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };
  }

  async chatWithContext(
    messages: ChatMessage[],
    _systemPrompt: string,
    _context: string,
    _tools?: LLMToolDef[],
  ): Promise<ChatResponse> {
    const availableTools = new Set((_tools || []).map((tool) => tool.name));
    const toolMessages = messages.filter((message) => message.role === 'tool');
    const hasToolResults = toolMessages.length > 0;
    const hasReadResult = toolMessages.some((message) => message.name === 'read_file');
    const hasWriteResult = toolMessages.some((message) => message.name === 'write_file' || message.name === 'edit_file');
    const hasExecResult = toolMessages.some((message) => message.name === 'bash');
    const implementationRequested = isImplementationRequest(messages);
    const highRiskRequest = isHighRiskApprovalRequest(messages);

    if (hasWriteResult) {
      return {
        content: '[Mock] Implementation complete. I applied the requested code change and no further code changes are needed.',
        usage: { promptTokens: 220, completionTokens: 90, totalTokens: 310 },
      };
    }

    if (hasExecResult) {
      return {
        content: '[Mock] High-risk action completed. I recorded the result and the task can now proceed.',
        usage: { promptTokens: 220, completionTokens: 90, totalTokens: 310 },
      };
    }

    if (highRiskRequest && availableTools.has('bash') && !hasToolResults) {
      return {
        content: '[Mock] Preparing a high-risk publish-style action that should require operator approval first.',
        toolCalls: [
          {
            id: 'mock-tc-risk-1',
            name: 'bash',
            arguments: {
              command: 'echo publish dry-run',
            },
          },
        ],
        usage: { promptTokens: 170, completionTokens: 70, totalTokens: 240 },
      };
    }

    if (
      implementationRequested
      && canWrite(availableTools)
      && (hasReadResult || !availableTools.has('read_file'))
    ) {
      return {
        content: '[Mock] Applying the requested implementation patch.',
        toolCalls: [
          {
            id: 'mock-tc-2',
            name: availableTools.has('write_file') ? 'write_file' : 'edit_file',
            arguments: buildMockWriteArguments(messages),
          },
        ],
        usage: { promptTokens: 190, completionTokens: 75, totalTokens: 265 },
      };
    }

    if (hasToolResults) {
      return {
        content: implementationRequested
          ? '[Mock] I inspected the current files and identified the next code change to make.'
          : '[Mock] Analysis complete. No code changes are needed.',
        usage: { promptTokens: 200, completionTokens: 80, totalTokens: 280 },
      };
    }

    return {
      content: '[Mock] Planning actions...',
      toolCalls: [
        { id: 'mock-tc-1', name: 'read_file', arguments: { path: 'package.json' } },
      ],
      usage: { promptTokens: 150, completionTokens: 60, totalTokens: 210 },
    };
  }
}

function buildMockSpecDocument(prompt: string): string {
  const demand = extractLineValue(prompt, 'Demand:') || 'Implement the requested workspace feature.';
  return [
    '# Goal',
    '',
    `Deliver the requested capability for the current workspace project. Demand: ${demand}`,
    '',
    '# Scope',
    '',
    'Update the target project only and keep the change constrained to the requested behavior.',
    '',
    '# In Scope',
    '',
    '- Adjust the identified behavior in the target code path.',
    '- Capture the expected outcome in project-local documentation.',
    '- Prepare the follow-up implementation plan in the same feature directory.',
    '',
    '# Out of Scope',
    '',
    '- Cross-project refactors that were not explicitly requested.',
    '- Infrastructure or release process changes.',
    '',
    '# API/Contract Impact',
    '',
    'No external contract change is assumed unless the implementation path proves otherwise during planning.',
    '',
    '# Risks',
    '',
    '- The demand may still need clarification if downstream implementation reveals hidden constraints.',
    '- Existing behavior should remain stable outside the requested path.',
    '',
    '# Acceptance Criteria',
    '',
    '- The behavior described in the demand is represented in the spec.',
    '- The plan phase can continue using this spec without placeholder content.',
  ].join('\n');
}

function buildMockPlanDocument(prompt: string): string {
  const demand = extractLineValue(prompt, 'Demand:') || 'Implement the requested workspace feature.';
  const specPath = extractLineValue(prompt, 'Resolved spec path:') || 'feature spec';
  return [
    '# Architecture Changes',
    '',
    `Use ${specPath} as the governing spec and keep implementation scoped to the requested behavior: ${demand}`,
    '',
    '# Implementation Steps',
    '',
    '1. Inspect the current source path referenced by the spec and identify the behavior to adjust.',
    '2. Update the implementation with the smallest safe change that satisfies the requested behavior.',
    '3. Add or update tests covering the requested path and one nearby regression guard.',
    '',
    '# Validation',
    '',
    '- Run the project test command or the nearest targeted test suite for the touched files.',
    '- Verify the requested behavior and one unchanged baseline behavior.',
    '',
    '# Risks',
    '',
    '- Hidden assumptions in the original demand may require a follow-up clarify step.',
    '- Touching tests may expose unrelated baseline issues in the project.',
    '',
    '# Rollout Notes',
    '',
    'Keep rollout local to the target project, and preserve the feature directory so ACE can continue from this plan artifact.',
  ].join('\n');
}

function extractLineValue(prompt: string, prefix: string): string | undefined {
  return prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

function isImplementationRequest(messages: ChatMessage[]): boolean {
  const lowered = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n')
    .toLowerCase();

  return (
    lowered.includes('实现')
    || lowered.includes('新增')
    || lowered.includes('修改')
    || lowered.includes('修复')
    || lowered.includes('设计')
    || lowered.includes('创建')
    || lowered.includes('生成')
    || lowered.includes('build')
    || lowered.includes('create')
    || lowered.includes('make ')
    || lowered.includes('implement')
    || lowered.includes('add ')
    || lowered.includes('fix ')
    || isCreationStyleImplementation(lowered)
  );
}

function canWrite(availableTools: Set<string>): boolean {
  return availableTools.has('write_file') || availableTools.has('edit_file');
}

function isHighRiskApprovalRequest(messages: ChatMessage[]): boolean {
  const lowered = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n')
    .toLowerCase();

  return (
    lowered.includes('发布')
    || lowered.includes('上线')
    || lowered.includes('deploy')
    || lowered.includes('publish')
    || lowered.includes('release')
  );
}

function buildMockWriteArguments(messages: ChatMessage[]): Record<string, unknown> {
  const taskText = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
  const path = inferMockWritePath(taskText);
  const content = buildMockImplementationContent(taskText);
  return { path, content };
}

function inferMockWritePath(taskText: string): string {
  const lowered = taskText.toLowerCase();
  if (lowered.includes('h5') || lowered.includes('html') || lowered.includes('页面') || lowered.includes('game')) {
    return 'src/mock-app.html';
  }
  return 'src/mock-output.ts';
}

function buildMockImplementationContent(taskText: string): string {
  const normalizedTask = taskText.replace(/^task:\s*/i, '').trim();
  if (
    normalizedTask.includes('贪吃蛇')
    || normalizedTask.toLowerCase().includes('snake')
    || normalizedTask.toLowerCase().includes('game')
  ) {
    return buildMockSnakeGameHtml(normalizedTask || '贪吃蛇小游戏');
  }

  if (
    normalizedTask.toLowerCase().includes('h5')
    || normalizedTask.includes('页面')
    || normalizedTask.toLowerCase().includes('html')
  ) {
    return [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '  <title>Mock Workbench Output</title>',
      '</head>',
      '<body>',
      `  <main>Mock implementation for: ${escapeHtml(normalizedTask || 'workbench task')}</main>`,
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  return [
    '// Mock implementation generated by Tik',
    `export const mockTaskSummary = ${JSON.stringify(normalizedTask || 'workbench task')};`,
    '',
  ].join('\n');
}

function isCreationStyleImplementation(lowered: string): boolean {
  return CREATION_STYLE_VERBS.some((verb) => lowered.includes(verb))
    && CREATION_STYLE_ARTIFACT_HINTS.some((hint) => lowered.includes(hint));
}

function buildMockSnakeGameHtml(taskTitle: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    `  <title>${escapeHtml(taskTitle)}</title>`,
    '  <style>',
    '    :root { color-scheme: dark; }',
    '    * { box-sizing: border-box; }',
    '    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: "Segoe UI", sans-serif; background: radial-gradient(circle at top, #16324f, #030712 62%); color: #e2e8f0; }',
    '    .shell { width: min(92vw, 860px); padding: 28px; border-radius: 28px; border: 1px solid rgba(148, 163, 184, 0.18); background: rgba(2, 6, 23, 0.78); backdrop-filter: blur(16px); box-shadow: 0 28px 80px rgba(15, 23, 42, 0.48); }',
    '    .hero { display: flex; justify-content: space-between; gap: 20px; align-items: end; flex-wrap: wrap; margin-bottom: 20px; }',
    '    h1 { margin: 0; font-size: clamp(28px, 4vw, 42px); }',
    '    p { margin: 8px 0 0; color: #cbd5e1; }',
    '    .hud { display: flex; gap: 12px; flex-wrap: wrap; }',
    '    .chip { min-width: 110px; padding: 10px 14px; border-radius: 16px; background: rgba(15, 23, 42, 0.88); border: 1px solid rgba(59, 130, 246, 0.24); }',
    '    .chip span { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; }',
    '    .chip strong { display: block; margin-top: 6px; font-size: 24px; color: #f8fafc; }',
    '    .board-wrap { display: grid; grid-template-columns: minmax(280px, 1fr) 220px; gap: 18px; align-items: start; }',
    '    canvas { width: 100%; max-width: 520px; aspect-ratio: 1 / 1; background: linear-gradient(180deg, #07111f, #020617); border-radius: 24px; border: 1px solid rgba(56, 189, 248, 0.25); box-shadow: inset 0 0 0 1px rgba(30, 41, 59, 0.8); }',
    '    .panel { padding: 18px; border-radius: 22px; background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(51, 65, 85, 0.95); }',
    '    .panel h2 { margin: 0 0 12px; font-size: 16px; }',
    '    .panel ul { margin: 0; padding-left: 18px; color: #cbd5e1; line-height: 1.6; }',
    '    .button-row { display: flex; gap: 10px; margin-top: 14px; }',
    '    button { border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 600; cursor: pointer; }',
    '    button.primary { background: linear-gradient(135deg, #22c55e, #16a34a); color: #04130a; }',
    '    button.secondary { background: rgba(30, 41, 59, 0.96); color: #e2e8f0; border: 1px solid rgba(100, 116, 139, 0.4); }',
    '    .footer { margin-top: 14px; font-size: 13px; color: #94a3b8; }',
    '    @media (max-width: 840px) { .board-wrap { grid-template-columns: 1fr; } canvas { max-width: none; } }',
    '  </style>',
    '</head>',
    '<body>',
    '  <main class="shell">',
    '    <section class="hero">',
    '      <div>',
    `        <h1>${escapeHtml(taskTitle)}</h1>`,
    '        <p>方向键或 WASD 控制，吃到食物会成长。撞墙或撞到自己会结束。</p>',
    '      </div>',
    '      <div class="hud">',
    '        <div class="chip"><span>Score</span><strong id="score">0</strong></div>',
    '        <div class="chip"><span>Best</span><strong id="best">0</strong></div>',
    '      </div>',
    '    </section>',
    '    <section class="board-wrap">',
    '      <canvas id="board" width="520" height="520" aria-label="Snake game board"></canvas>',
    '      <aside class="panel">',
    '        <h2>玩法</h2>',
    '        <ul>',
    '          <li>方向键或 WASD 控制蛇移动</li>',
    '          <li>每吃一个果实得 10 分，速度会逐渐提升</li>',
    '          <li>点击重新开始可以立刻再来一局</li>',
    '        </ul>',
    '        <div class="button-row">',
    '          <button id="restart" class="primary" type="button">重新开始</button>',
    '          <button id="pause" class="secondary" type="button">暂停</button>',
    '        </div>',
    '        <div class="footer" id="status">游戏开始，祝你好运。</div>',
    '      </aside>',
    '    </section>',
    '  </main>',
    '  <script>',
    '    const board = document.getElementById("board");',
    '    const ctx = board.getContext("2d");',
    '    const scoreNode = document.getElementById("score");',
    '    const bestNode = document.getElementById("best");',
    '    const statusNode = document.getElementById("status");',
    '    const restartButton = document.getElementById("restart");',
    '    const pauseButton = document.getElementById("pause");',
    '    const gridSize = 20;',
    '    const tileSize = board.width / gridSize;',
    '    const bestKey = "tik-mock-snake-best-score";',
    '    const directions = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };',
    '    let snake = [];',
    '    let direction = [1, 0];',
    '    let nextDirection = [1, 0];',
    '    let food = { x: 10, y: 10 };',
    '    let score = 0;',
    '    let loop = null;',
    '    let speed = 160;',
    '    let paused = false;',
    '',
    '    function syncBestScore() {',
    '      const best = Number(window.localStorage.getItem(bestKey) || 0);',
    '      bestNode.textContent = String(best);',
    '      if (score > best) {',
    '        window.localStorage.setItem(bestKey, String(score));',
    '        bestNode.textContent = String(score);',
    '      }',
    '    }',
    '',
    '    function randomFood() {',
    '      while (true) {',
    '        const candidate = { x: Math.floor(Math.random() * gridSize), y: Math.floor(Math.random() * gridSize) };',
    '        if (!snake.some((segment) => segment.x === candidate.x && segment.y === candidate.y)) return candidate;',
    '      }',
    '    }',
    '',
    '    function drawCell(x, y, color, radius = 8) {',
    '      ctx.fillStyle = color;',
    '      const padding = 2;',
    '      const px = x * tileSize + padding;',
    '      const py = y * tileSize + padding;',
    '      const size = tileSize - padding * 2;',
    '      ctx.beginPath();',
    '      ctx.roundRect(px, py, size, size, radius);',
    '      ctx.fill();',
    '    }',
    '',
    '    function render() {',
    '      ctx.clearRect(0, 0, board.width, board.height);',
    '      ctx.fillStyle = "#020617";',
    '      ctx.fillRect(0, 0, board.width, board.height);',
    '      for (let x = 0; x < gridSize; x += 1) {',
    '        for (let y = 0; y < gridSize; y += 1) {',
    '          ctx.fillStyle = (x + y) % 2 === 0 ? "rgba(15, 23, 42, 0.9)" : "rgba(8, 15, 28, 0.9)";',
    '          ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);',
    '        }',
    '      }',
    '      drawCell(food.x, food.y, "#f97316", 999);',
    '      snake.forEach((segment, index) => drawCell(segment.x, segment.y, index === 0 ? "#38bdf8" : "#22c55e", index === 0 ? 12 : 8));',
    '    }',
    '',
    '    function endGame() {',
    '      window.clearInterval(loop);',
    '      loop = null;',
    '      syncBestScore();',
    '      statusNode.textContent = `游戏结束，最终得分 ${score}。点击重新开始再来一局。`;',
    '      pauseButton.textContent = "暂停";',
    '      paused = false;',
    '    }',
    '',
    '    function tick() {',
    '      direction = nextDirection;',
    '      const head = { x: snake[0].x + direction[0], y: snake[0].y + direction[1] };',
    '      if (head.x < 0 || head.y < 0 || head.x >= gridSize || head.y >= gridSize || snake.some((segment) => segment.x === head.x && segment.y === head.y)) {',
    '        endGame();',
    '        render();',
    '        return;',
    '      }',
    '      snake.unshift(head);',
    '      if (head.x === food.x && head.y === food.y) {',
    '        score += 10;',
    '        speed = Math.max(70, speed - 6);',
    '        food = randomFood();',
    '        scoreNode.textContent = String(score);',
    '        syncBestScore();',
    '        statusNode.textContent = "吃到果实了，速度稍微提高。";',
    '        window.clearInterval(loop);',
    '        loop = window.setInterval(tick, speed);',
    '      } else {',
    '        snake.pop();',
    '      }',
    '      render();',
    '    }',
    '',
    '    function resetGame() {',
    '      snake = [',
    '        { x: 5, y: 10 },',
    '        { x: 4, y: 10 },',
    '        { x: 3, y: 10 },',
    '      ];',
    '      direction = [1, 0];',
    '      nextDirection = [1, 0];',
    '      food = randomFood();',
    '      score = 0;',
    '      speed = 160;',
    '      paused = false;',
    '      scoreNode.textContent = "0";',
    '      syncBestScore();',
    '      statusNode.textContent = "游戏开始，祝你好运。";',
    '      pauseButton.textContent = "暂停";',
    '      window.clearInterval(loop);',
    '      loop = window.setInterval(tick, speed);',
    '      render();',
    '    }',
    '',
    '    window.addEventListener("keydown", (event) => {',
    '      const next = directions[event.key];',
    '      if (!next) return;',
    '      event.preventDefault();',
    '      if (next[0] === -direction[0] && next[1] === -direction[1]) return;',
    '      nextDirection = next;',
    '    });',
    '',
    '    restartButton.addEventListener("click", resetGame);',
    '    pauseButton.addEventListener("click", () => {',
    '      if (!loop && !paused) {',
    '        resetGame();',
    '        return;',
    '      }',
    '      if (paused) {',
    '        loop = window.setInterval(tick, speed);',
    '        paused = false;',
    '        pauseButton.textContent = "暂停";',
    '        statusNode.textContent = "继续前进。";',
    '      } else {',
    '        window.clearInterval(loop);',
    '        loop = null;',
    '        paused = true;',
    '        pauseButton.textContent = "继续";',
    '        statusNode.textContent = "已暂停，点击继续恢复游戏。";',
    '      }',
    '    });',
    '',
    '    syncBestScore();',
    '    resetGame();',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
