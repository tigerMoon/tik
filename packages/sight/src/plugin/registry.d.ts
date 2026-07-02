/**
 * Plugin Registry
 *
 * Central registry for SIGHT plugins.
 * Supports local/letta/degradable plugin implementations.
 */
import type { IContextMemoryPlugin } from './types.js';
export declare class PluginRegistry {
    private plugins;
    private activePlugin;
    register(plugin: IContextMemoryPlugin): void;
    activate(name: string, config?: Record<string, unknown>): Promise<void>;
    getActive(): IContextMemoryPlugin | null;
    get(name: string): IContextMemoryPlugin | undefined;
    list(): string[];
    dispose(): Promise<void>;
}
//# sourceMappingURL=registry.d.ts.map