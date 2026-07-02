/**
 * Context Graph
 *
 * Graph-based context representation with typed nodes and relations.
 * 8 node types + 6 relation types for structured context traversal.
 */
import { generateId, now } from '@tik/shared';
// ─── Context Graph ───────────────────────────────────────────
export class ContextGraph {
    nodes = new Map();
    edges = new Map();
    outEdges = new Map();
    inEdges = new Map();
    // ── Node Operations ───────────────────────────────────────
    addNode(type, label, data = {}) {
        const node = {
            id: generateId(),
            type,
            label,
            data,
            createdAt: now(),
            updatedAt: now(),
        };
        this.nodes.set(node.id, node);
        this.outEdges.set(node.id, new Set());
        this.inEdges.set(node.id, new Set());
        return node;
    }
    getNode(id) {
        return this.nodes.get(id);
    }
    queryByType(type) {
        return Array.from(this.nodes.values()).filter(n => n.type === type);
    }
    updateNode(id, updates) {
        const node = this.nodes.get(id);
        if (!node)
            return;
        if (updates.label)
            node.label = updates.label;
        if (updates.data)
            node.data = { ...node.data, ...updates.data };
        node.updatedAt = now();
    }
    removeNode(id) {
        // Remove all connected edges
        const out = this.outEdges.get(id) || new Set();
        const inE = this.inEdges.get(id) || new Set();
        for (const edgeId of [...out, ...inE]) {
            this.removeEdge(edgeId);
        }
        this.nodes.delete(id);
        this.outEdges.delete(id);
        this.inEdges.delete(id);
    }
    // ── Edge Operations ───────────────────────────────────────
    addEdge(source, target, relation, weight = 1.0) {
        if (!this.nodes.has(source) || !this.nodes.has(target)) {
            throw new Error(`Both source and target nodes must exist`);
        }
        const edge = {
            id: generateId(),
            source,
            target,
            relation,
            weight,
        };
        this.edges.set(edge.id, edge);
        this.outEdges.get(source)?.add(edge.id);
        this.inEdges.get(target)?.add(edge.id);
        return edge;
    }
    removeEdge(id) {
        const edge = this.edges.get(id);
        if (!edge)
            return;
        this.outEdges.get(edge.source)?.delete(id);
        this.inEdges.get(edge.target)?.delete(id);
        this.edges.delete(id);
    }
    // ── Traversal ─────────────────────────────────────────────
    /** Get nodes connected from a given node */
    getOutbound(nodeId, relation) {
        const edgeIds = this.outEdges.get(nodeId) || new Set();
        const results = [];
        for (const edgeId of edgeIds) {
            const edge = this.edges.get(edgeId);
            if (!edge)
                continue;
            if (relation && edge.relation !== relation)
                continue;
            const node = this.nodes.get(edge.target);
            if (node)
                results.push(node);
        }
        return results;
    }
    /** Get nodes connecting to a given node */
    getInbound(nodeId, relation) {
        const edgeIds = this.inEdges.get(nodeId) || new Set();
        const results = [];
        for (const edgeId of edgeIds) {
            const edge = this.edges.get(edgeId);
            if (!edge)
                continue;
            if (relation && edge.relation !== relation)
                continue;
            const node = this.nodes.get(edge.source);
            if (node)
                results.push(node);
        }
        return results;
    }
    /** BFS traversal from a node */
    traverse(startId, maxDepth = 5) {
        const visited = new Set();
        const queue = [{ id: startId, depth: 0 }];
        const result = [];
        while (queue.length > 0) {
            const { id, depth } = queue.shift();
            if (visited.has(id) || depth > maxDepth)
                continue;
            visited.add(id);
            const node = this.nodes.get(id);
            if (node)
                result.push(node);
            const outbound = this.getOutbound(id);
            for (const next of outbound) {
                if (!visited.has(next.id)) {
                    queue.push({ id: next.id, depth: depth + 1 });
                }
            }
        }
        return result;
    }
    // ── Serialization ─────────────────────────────────────────
    toJSON() {
        return {
            nodes: Array.from(this.nodes.values()),
            edges: Array.from(this.edges.values()),
        };
    }
    static fromJSON(data) {
        const graph = new ContextGraph();
        for (const node of data.nodes) {
            graph.nodes.set(node.id, node);
            graph.outEdges.set(node.id, new Set());
            graph.inEdges.set(node.id, new Set());
        }
        for (const edge of data.edges) {
            graph.edges.set(edge.id, edge);
            graph.outEdges.get(edge.source)?.add(edge.id);
            graph.inEdges.get(edge.target)?.add(edge.id);
        }
        return graph;
    }
    // ── Stats ─────────────────────────────────────────────────
    get nodeCount() { return this.nodes.size; }
    get edgeCount() { return this.edges.size; }
}
//# sourceMappingURL=context-graph.js.map