/**
 * Plugin Registry
 *
 * Central registry for SIGHT plugins.
 * Supports local/letta/degradable plugin implementations.
 */

import type { IContextMemoryPlugin } from './types.js';

export class PluginRegistry {
  private plugins: Map<string, IContextMemoryPlugin> = new Map();
  private activePlugin: string | null = null;

  register(plugin: IContextMemoryPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  async activate(name: string, config?: Record<string, unknown>): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Plugin "${name}" not found. Available: ${Array.from(this.plugins.keys()).join(', ')}`);
    }

    if (plugin.initialize) {
      await plugin.initialize(config || {});
    }
    this.activePlugin = name;
  }

  getActive(): IContextMemoryPlugin | null {
    if (!this.activePlugin) return null;
    return this.plugins.get(this.activePlugin) || null;
  }

  get(name: string): IContextMemoryPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): string[] {
    return Array.from(this.plugins.keys());
  }

  async dispose(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.dispose) {
        await plugin.dispose();
      }
    }
    this.plugins.clear();
    this.activePlugin = null;
  }
}
