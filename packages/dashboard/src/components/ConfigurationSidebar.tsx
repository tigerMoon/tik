import React from 'react';

export function ConfigurationSidebar({ task, packs }: any) {
  return (
    <aside style={{ width: '340px', background: 'var(--bg-sidebar)', borderLeft: '1px solid var(--glass-border)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
      <div style={{ padding: '24px', borderBottom: '1px solid var(--glass-border)' }}>
        <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>Configuration</div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Task: #{task?.id?.slice(0, 8) || 'N/A'}</div>
      </div>

      <div className="config-section">
        <div className="config-title">
          Assigned Agents 
          <span style={{ cursor: 'pointer', color: 'var(--accent-purple)' }}>Manage</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[
            { name: 'Supervisor', role: 'Orchestrator', active: true },
            { name: 'Researcher', role: 'Information Retrieval', active: task?.currentOwner === 'researcher' },
            { name: 'Coder', role: 'Implementation', active: task?.currentOwner === 'coder' },
            { name: 'Reviewer', role: 'Quality Assurance', active: task?.currentOwner === 'reviewer' }
          ].map(agent => (
            <div key={agent.name} style={{ 
              display: 'flex', 
              alignItems: 'center', 
              padding: '12px', 
              borderRadius: '12px', 
              background: agent.active ? 'rgba(168, 85, 247, 0.08)' : 'var(--bg-card)',
              border: agent.active ? '1px solid rgba(168, 85, 247, 0.2)' : '1px solid var(--glass-border)',
              cursor: 'pointer',
              transition: 'all 0.2s ease'
            }}>
              <div style={{ 
                width: '32px', 
                height: '32px', 
                borderRadius: '8px', 
                background: agent.active ? 'var(--accent-purple)' : 'var(--text-muted)',
                marginRight: '12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '14px',
                color: 'white',
                fontWeight: 700
              }}>
                {agent.name[0]}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: agent.active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{agent.name}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{agent.role}</div>
              </div>
              <div style={{ 
                width: '20px', 
                height: '20px', 
                borderRadius: '50%', 
                border: `2px solid ${agent.active ? 'var(--accent-purple)' : 'var(--glass-border)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                {agent.active && <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--accent-purple)' }}></div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="config-section">
        <div className="config-title">Skills & Capabilities</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {[
            { name: 'Code Interpreter', active: true },
            { name: 'Web Search', active: true },
            { name: 'File System', active: true },
            { name: 'Data Visualization', active: false },
            { name: 'Image Gen', active: false },
            { name: 'GitHub Sync', active: false }
          ].map(skill => (
            <div key={skill.name} className={`resource-chip ${skill.active ? 'active' : ''}`}>
              {skill.name}
              {skill.active && <span style={{ marginLeft: '6px', fontSize: '10px' }}>✕</span>}
            </div>
          ))}
          <div className="resource-chip" style={{ borderStyle: 'dashed', color: 'var(--accent-purple)' }}>+ Add Skill</div>
        </div>
      </div>

      <div className="config-section" style={{ borderBottom: 'none' }}>
        <div className="config-title">Knowledge Bases (RAG)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {[
            { name: 'Engineering Docs', size: '12MB', status: 'Synced' },
            { name: 'API Reference', size: '2.4MB', status: 'Synced' },
            { name: 'Product Specs', size: '0.8MB', status: 'Indexing' }
          ].map(kb => (
            <div key={kb.name} className="glass-panel" style={{ padding: '12px', background: 'rgba(2, 6, 23, 0.3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>{kb.name}</div>
                <div style={{ 
                  fontSize: '0.65rem', 
                  padding: '2px 6px', 
                  borderRadius: '4px', 
                  background: kb.status === 'Synced' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                  color: kb.status === 'Synced' ? 'var(--accent-emerald)' : 'var(--accent-amber)'
                }}>{kb.status}</div>
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{kb.size} • Last updated 2h ago</div>
            </div>
          ))}
          <div style={{ 
            padding: '12px', 
            borderRadius: '12px', 
            border: '1px dashed var(--glass-border)', 
            textAlign: 'center', 
            color: 'var(--text-muted)', 
            fontSize: '0.8rem',
            cursor: 'pointer'
          }}>
            + Connect New Data Source
          </div>
        </div>
      </div>
      
      <div style={{ marginTop: 'auto', padding: '24px', background: 'rgba(168, 85, 247, 0.05)', borderTop: '1px solid var(--glass-border)' }}>
        <button style={{ 
          width: '100%', 
          padding: '12px', 
          borderRadius: '12px', 
          background: 'var(--accent-purple)', 
          color: 'white', 
          fontWeight: 700, 
          border: 'none', 
          cursor: 'pointer',
          boxShadow: 'var(--glow-purple)'
        }}>
          Apply Changes
        </button>
      </div>
    </aside>
  );
}
