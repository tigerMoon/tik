import React from 'react';

export function ConversationHub({ task, timeline, decisions }: any) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: '0 24px 24px 24px' }}>
      <div className="system-instructions" style={{ marginTop: '0' }}>
        <div className="config-title" style={{ color: 'var(--accent-purple)' }}>System Instructions</div>
        <textarea 
          placeholder="Set context for the current conversation..." 
          defaultValue={task?.goal ? `Act as an expert assistant to achieve: ${task.goal}` : "Provide instructions to the agent..."}
          rows={3}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
          <button className="resource-chip active" style={{ fontSize: '0.7rem' }}>Save Context</button>
        </div>
      </div>
      
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 0', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div className="message-system">Session started for task #{task?.id?.slice(0, 8) || 'unknown'}</div>
        
        {timeline.map((item: any) => (
          <div key={item.id} className={`message-bubble message-${item.kind === 'summary' ? 'agent' : item.kind === 'decision' ? 'system' : 'user'}`}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '8px', gap: '8px' }}>
              <div style={{ 
                width: '24px', 
                height: '24px', 
                borderRadius: '6px', 
                background: item.kind === 'summary' ? 'var(--accent-purple)' : item.kind === 'decision' ? 'var(--accent-cyan)' : 'var(--accent-amber)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                color: 'white'
              }}>
                {item.actor?.[0].toUpperCase()}
              </div>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {item.actor}
              </span>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{new Date(item.createdAt).toLocaleTimeString()}</span>
            </div>
            <div style={{ fontSize: '0.95rem', color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{item.body}</div>
          </div>
        ))}
        
        {timeline.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            No activity yet. Set the system instructions or send a message to begin.
          </div>
        )}
      </div>

      <div style={{ marginTop: '16px' }}>
        <div style={{ 
          position: 'relative', 
          background: 'var(--bg-sidebar)', 
          borderRadius: '16px', 
          border: '1px solid var(--glass-border)',
          padding: '4px',
          boxShadow: 'var(--shadow-lg)'
        }}>
          <textarea 
            placeholder={`Message ${task?.currentOwner || 'Supervisor'}... (Ctrl+Enter to send)`}
            style={{ 
              width: '100%', 
              background: 'transparent', 
              border: 'none', 
              padding: '12px 60px 12px 16px', 
              color: 'var(--text-primary)',
              outline: 'none',
              resize: 'none',
              minHeight: '48px',
              maxHeight: '200px',
              fontSize: '0.95rem'
            }} 
            rows={1}
          />
          <button style={{ 
            position: 'absolute', 
            right: '12px', 
            top: '50%', 
            transform: 'translateY(-50%)', 
            background: 'var(--accent-purple)', 
            border: 'none', 
            borderRadius: '10px', 
            width: '36px', 
            height: '36px', 
            color: 'white', 
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: 'var(--glow-purple)'
          }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </div>
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '8px' }}>
          Assign agents and skills in the right panel to customize output.
        </div>
      </div>
    </div>
  );
}
