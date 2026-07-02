/**
 * Display Utilities
 *
 * Terminal output formatting for Tik CLI.
 */
import chalk from 'chalk';
// ─── Task Display ────────────────────────────────────────────
export function displayTask(task) {
    const statusColor = getStatusColor(task.status);
    console.log('');
    console.log(chalk.bold(`Task: ${task.id}`));
    console.log(`  Status:      ${statusColor(task.status)}`);
    console.log(`  Description: ${task.description}`);
    console.log(`  Strategy:    ${task.strategy}`);
    console.log(`  Iterations:  ${task.iterations.length}/${task.maxIterations}`);
    if (task.projectPath) {
        console.log(`  Project:     ${task.projectPath}`);
    }
    // Display plan if present
    if (task.plan) {
        console.log('');
        console.log(chalk.bold('  Plan:'));
        if (task.plan.goals.length > 0) {
            console.log(chalk.dim('  Goals:'));
            for (const goal of task.plan.goals) {
                console.log(`    - ${goal}`);
            }
        }
        if (task.plan.actions.length > 0) {
            console.log(chalk.dim(`  Actions (${task.plan.actions.length}):`));
            for (const action of task.plan.actions) {
                const inputStr = typeof action.input === 'object'
                    ? JSON.stringify(action.input).slice(0, 80)
                    : String(action.input);
                console.log(`    ${chalk.cyan(action.tool.padEnd(12))} ${chalk.dim(inputStr)}`);
                if (action.reason) {
                    console.log(`    ${' '.repeat(12)} ${chalk.gray(action.reason)}`);
                }
            }
        }
        console.log(`  Risk:        ${task.plan.riskLevel}`);
    }
    console.log('');
}
export function displayTaskResult(result) {
    const statusColor = getStatusColor(result.status);
    console.log('');
    console.log(chalk.bold('═══ Task Result ═══'));
    console.log(`  Status:     ${statusColor(result.status)}`);
    console.log(`  Iterations: ${result.totalIterations}`);
    console.log(`  Duration:   ${formatDuration(result.durationMs)}`);
    console.log(`  Fitness:    ${formatFitness(result.evaluation.fitness)}`);
    console.log(`  Drift:      ${formatDrift(result.evaluation.drift)}`);
    console.log(`  Entropy:    ${formatEntropy(result.evaluation.entropy)}`);
    console.log(`  Summary:    ${result.summary}`);
    console.log('');
}
// ─── Event Display ───────────────────────────────────────────
export function displayEvent(event) {
    const time = new Date(event.timestamp).toLocaleTimeString();
    const icon = getEventIcon(event.type);
    const color = getEventColor(event.type);
    const payload = typeof event.payload === 'object' && event.payload !== null
        ? JSON.stringify(event.payload, null, 0).slice(0, 100)
        : String(event.payload);
    console.log(`${chalk.gray(time)} ${icon} ${color(event.type)} ${chalk.dim(payload)}`);
}
// ─── Evaluation Display ──────────────────────────────────────
export function displayEvaluation(eval_, iteration) {
    console.log('');
    console.log(chalk.bold(`── Iteration ${iteration} ──`));
    console.log(`  Fitness:  ${formatFitness(eval_.fitness)}`);
    console.log(`  Drift:    ${formatDrift(eval_.drift)}`);
    console.log(`  Entropy:  ${formatEntropy(eval_.entropy)}`);
    if (eval_.breakdown) {
        console.log(`  Quality:     ${formatScore(eval_.breakdown.quality)}`);
        console.log(`  Correctness: ${formatScore(eval_.breakdown.correctness)}`);
        console.log(`  Stability:   ${formatScore(eval_.breakdown.stability)}`);
        console.log(`  Complexity:  ${formatScore(eval_.breakdown.complexity)}`);
    }
    console.log(`  Converged: ${eval_.converged ? chalk.green('YES') : chalk.yellow('NO')}`);
    console.log('');
}
// ─── Fitness Bar ─────────────────────────────────────────────
export function fitnessBar(value, width = 20) {
    const filled = Math.round(value * width);
    const empty = width - filled;
    const color = value >= 0.8 ? chalk.green : value >= 0.6 ? chalk.yellow : chalk.red;
    return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty)) + ` ${(value * 100).toFixed(1)}%`;
}
// ─── Helpers ─────────────────────────────────────────────────
function getStatusColor(status) {
    switch (status) {
        case 'completed': return chalk.green;
        case 'converged': return chalk.green;
        case 'executing':
        case 'planning':
        case 'evaluating': return chalk.cyan;
        case 'failed': return chalk.red;
        case 'cancelled': return chalk.yellow;
        default: return chalk.gray;
    }
}
function getEventIcon(type) {
    if (type.includes('tool.called'))
        return '🔧';
    if (type.includes('tool.result'))
        return '✅';
    if (type.includes('tool.error'))
        return '❌';
    if (type.includes('plan'))
        return '📋';
    if (type.includes('context'))
        return '🧠';
    if (type.includes('evaluation'))
        return '📊';
    if (type.includes('convergence'))
        return '🎯';
    if (type.includes('iteration'))
        return '🔄';
    if (type.includes('task'))
        return '📌';
    if (type.includes('human'))
        return '👤';
    if (type.includes('session.started'))
        return '🔗';
    if (type.includes('session.message'))
        return '💬';
    if (type.includes('session.usage'))
        return '💸';
    if (type.includes('agent_switched'))
        return '🔀';
    if (type.includes('error'))
        return '💥';
    return '  ';
}
function getEventColor(type) {
    if (type.includes('error') || type.includes('failed'))
        return chalk.red;
    if (type.includes('completed') || type.includes('converge'))
        return chalk.green;
    if (type.includes('started') || type.includes('called'))
        return chalk.cyan;
    if (type.includes('agent_switched'))
        return chalk.magenta;
    if (type.includes('session'))
        return chalk.blue;
    return chalk.white;
}
function formatFitness(value) {
    return fitnessBar(value);
}
function formatDrift(value) {
    const color = value < 3.0 ? chalk.green : value < 5.0 ? chalk.yellow : chalk.red;
    return color(`${value.toFixed(2)}`);
}
function formatEntropy(value) {
    const color = value < 0.5 ? chalk.green : value < 1.0 ? chalk.yellow : chalk.red;
    return color(`${value.toFixed(3)}`);
}
function formatScore(value) {
    const pct = (value * 100).toFixed(1);
    const color = value >= 0.8 ? chalk.green : value >= 0.5 ? chalk.yellow : chalk.red;
    return color(`${pct}%`);
}
function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60_000)
        return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${mins}m ${secs}s`;
}
//# sourceMappingURL=display.js.map