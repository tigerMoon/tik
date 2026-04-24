/**
 * Context Graph
 *
 * Graph-based context representation with typed nodes and relations.
 * 8 node types + 6 relation types for structured context traversal.
 */

import { generateId, now } from '@tik/shared';

// ─── Node Types ──────────────────────────────────────────────

export type NodeType =
  | 'spec'         // Requirement / specification
  | 'plan'         // Technical plan
  | 'task'         // Implementation task
  | 'code'         // Code entity (class, method, file)
  | 'test'         // Test case
  | 'run'          // Execution run
  | 'decision'     // Architectural decision
  | 'pattern';     // Learned pattern

export type RelationType =
  | 'implements'    // code → spec
  | 'planned_by'   // task → plan
  | 'tested_by'    // code → test
  | 'depends_on'   // any → any
  | 'evolved_from' // run → run
  | 'learned_from'; // pattern → run

// ─── Graph Models ────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  weight: number;
  metadata?: Record<string, unknown>;
}

// ─── Context Graph ───────────────────────────────────────────

export class ContextGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();
  private outEdges: Map<string, Set<string>> = new Map();
  private inEdges: Map<string, Set<string>> = new Map();

  // ── Node Operations ───────────────────────────────────────

  addNode(type: NodeType, label: string, data: Record<string, unknown> = {}): GraphNode {
    const node: GraphNode = {
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

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  queryByType(type: NodeType): GraphNode[] {
    return Array.from(this.nodes.values()).filter(n => n.type === type);
  }

  updateNode(id: string, updates: Partial<Pick<GraphNode, 'label' | 'data'>>): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (updates.label) node.label = updates.label;
    if (updates.data) node.data = { ...node.data, ...updates.data };
    node.updatedAt = now();
  }

  removeNode(id: string): void {
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

  addEdge(source: string, target: string, relation: RelationType, weight = 1.0): GraphEdge {
    if (!this.nodes.has(source) || !this.nodes.has(target)) {
      throw new Error(`Both source and target nodes must exist`);
    }
    const edge: GraphEdge = {
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

  removeEdge(id: string): void {
    const edge = this.edges.get(id);
    if (!edge) return;
    this.outEdges.get(edge.source)?.delete(id);
    this.inEdges.get(edge.target)?.delete(id);
    this.edges.delete(id);
  }

  // ── Traversal ─────────────────────────────────────────────

  /** Get nodes connected from a given node */
  getOutbound(nodeId: string, relation?: RelationType): GraphNode[] {
    const edgeIds = this.outEdges.get(nodeId) || new Set();
    const results: GraphNode[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;
      if (relation && edge.relation !== relation) continue;
      const node = this.nodes.get(edge.target);
      if (node) results.push(node);
    }
    return results;
  }

  /** Get nodes connecting to a given node */
  getInbound(nodeId: string, relation?: RelationType): GraphNode[] {
    const edgeIds = this.inEdges.get(nodeId) || new Set();
    const results: GraphNode[] = [];
    for (const edgeId of edgeIds) {
      const edge = this.edges.get(edgeId);
      if (!edge) continue;
      if (relation && edge.relation !== relation) continue;
      const node = this.nodes.get(edge.source);
      if (node) results.push(node);
    }
    return results;
  }

  /** BFS traversal from a node */
  traverse(startId: string, maxDepth = 5): GraphNode[] {
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];
    const result: GraphNode[] = [];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);

      const node = this.nodes.get(id);
      if (node) result.push(node);

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

  toJSON(): { nodes: GraphNode[]; edges: GraphEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    };
  }

  static fromJSON(data: { nodes: GraphNode[]; edges: GraphEdge[] }): ContextGraph {
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

  get nodeCount(): number { return this.nodes.size; }
  get edgeCount(): number { return this.edges.size; }
}
