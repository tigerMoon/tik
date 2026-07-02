import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
export class CodexAppServerProcess {
    options;
    spawnFactory;
    child;
    emitter = new EventEmitter();
    buffer = '';
    constructor(options = {}, spawnFactory = spawn) {
        this.options = options;
        this.spawnFactory = spawnFactory;
    }
    async start() {
        if (this.child && !this.child.killed)
            return;
        const command = this.options.command || 'codex';
        const args = this.options.args || ['app-server', '--listen', 'stdio://'];
        const child = this.spawnFactory(command, args, {
            cwd: this.options.cwd || process.cwd(),
            env: {
                ...process.env,
                ...this.options.env,
            },
            stdio: 'pipe',
        });
        this.child = child;
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => {
            this.buffer += chunk;
            let newlineIndex = this.buffer.indexOf('\n');
            while (newlineIndex !== -1) {
                const line = this.buffer.slice(0, newlineIndex).trim();
                this.buffer = this.buffer.slice(newlineIndex + 1);
                if (line) {
                    try {
                        this.emitter.emit('message', JSON.parse(line));
                    }
                    catch {
                        this.emitter.emit('stderr', `Invalid JSON from Codex App Server: ${line}`);
                    }
                }
                newlineIndex = this.buffer.indexOf('\n');
            }
        });
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk) => {
            this.emitter.emit('stderr', chunk);
        });
        child.on('close', () => {
            this.child = undefined;
        });
    }
    async stop() {
        const child = this.child;
        this.child = undefined;
        if (!child || child.killed)
            return;
        child.kill('SIGTERM');
        await new Promise((resolve) => {
            child.once('close', () => resolve());
            setTimeout(() => {
                if (!child.killed)
                    child.kill('SIGKILL');
                resolve();
            }, 3000).unref();
        });
    }
    send(message) {
        if (!this.child?.stdin.writable) {
            throw new Error('Codex App Server process is not running.');
        }
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    onMessage(listener) {
        this.emitter.on('message', listener);
        return () => this.emitter.off('message', listener);
    }
    onStderr(listener) {
        this.emitter.on('stderr', listener);
        return () => this.emitter.off('stderr', listener);
    }
}
//# sourceMappingURL=codex-app-server-process.js.map