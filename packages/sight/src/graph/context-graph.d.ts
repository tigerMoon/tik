/**
 * Context Graph
 *
 * Graph-based context representation with typed nodes and relations.
 * 8 node types + 6 relation types for structured context traversal.
 */
export type NodeType = 'spec' | 'plan' | 'task' | 'code' | 'test' | 'run' | 'decision' | 'pattern';
export type RelationType = 'implements' | 'planned_by' | 'tested_by' | 'depends_on' | 'evolved_from' | 'learned_from';
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
export declare class ContextGraph {
    private nodes;
    private edges;
    private outEdges;
    private inEdges;
    addNode(type: NodeType, label: string, data?: Record<string, unknown>): GraphNode;
    getNode(id: string): GraphNode | undefined;
    queryByType(type: NodeType): GraphNode[];
    updateNode(id: string, updates: Partial<Pick<GraphNode, 'label' | 'data'>>): void;
    removeNode(id: string): void;
    addEdge(source: string, target: string, relation: RelationType, weight?: number): GraphEdge;
    removeEdge(id: string): void;
    /** Get nodes connected from a given node */
    getOutbound(nodeId: string, relation?: RelationType): GraphNode[];
    /** Get nodes connecting to a given node */
    getInbound(nodeId: string, relation?: RelationType): GraphNode[];
    /** BFS traversal from a node */
    traverse(startId: string, maxDepth?: number): GraphNode[];
    toJSON(): {
        nodes: GraphNode[];
        edges: GraphEdge[];
    };
    static fromJSON(data: {
        nodes: GraphNode[];
        edges: GraphEdge[];
    }): ContextGraph;
    get nodeCount(): number;
    get edgeCount(): number;
}
//# sourceMappingURL=context-graph.d.ts.map