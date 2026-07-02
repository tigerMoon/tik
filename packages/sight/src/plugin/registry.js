/**
 * Plugin Registry
 *
 * Central registry for SIGHT plugins.
 * Supports local/letta/degradable plugin implementations.
 */
export class PluginRegistry {
    plugins = new Map();
    activePlugin = null;
    register(plugin) {
        this.plugins.set(plugin.name, plugin);
    }
    async activate(name, config) {
        const plugin = this.plugins.get(name);
        if (!plugin) {
            throw new Error(`Plugin "${name}" not found. Available: ${Array.from(this.plugins.keys()).join(', ')}`);
        }
        if (plugin.initialize) {
            await plugin.initialize(config || {});
        }
        this.activePlugin = name;
    }
    getActive() {
        if (!this.activePlugin)
            return null;
        return this.plugins.get(this.activePlugin) || null;
    }
    get(name) {
        return this.plugins.get(name);
    }
    list() {
        return Array.from(this.plugins.keys());
    }
    async dispose() {
        for (const plugin of this.plugins.values()) {
            if (plugin.dispose) {
                await plugin.dispose();
            }
        }
        this.plugins.clear();
        this.activePlugin = null;
    }
}
//# sourceMappingURL=registry.js.map