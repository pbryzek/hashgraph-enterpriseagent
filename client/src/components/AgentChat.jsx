import { useState, useRef, useEffect, Component } from 'react';
import ReactMarkdown from 'react-markdown';
import './AgentChat.css';

const HASHSCAN_BASE = 'https://hashscan.io/testnet/transaction';
const API_BASE = import.meta.env.VITE_API_URL || '';

const RESEARCH_PROMPTS = [
  'Find women\'s sports teams in the San Francisco Bay Area for a Nature Backers campaign.',
  'What are the top women\'s sports organizations in Los Angeles I should target?',
  'Identify women\'s college sports programs in Texas with strong sustainability alignment.',
];

const CAMPAIGN_PROMPTS = [
  'Find water sustainability projects in East Africa.',
  'Search for SDG 6 clean water projects I can feature in a fan campaign.',
  'What nature-based solutions projects involve reforestation?',
];

// ── Error boundary ─────────────────────────────────────────────────────────────
class MessageErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { crashed: false };
  }
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  render() {
    if (this.state.crashed) {
      return (
        <div className="message message--error">
          <p className="message-content">Could not render this message.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Safe markdown renderer ────────────────────────────────────────────────────
function SafeMarkdown({ content }) {
  if (!content || typeof content !== 'string') return null;
  return <ReactMarkdown>{content}</ReactMarkdown>;
}

// ── Single message bubble ─────────────────────────────────────────────────────
function MessageBubble({ m }) {
  return (
    <MessageErrorBoundary>
      <div className={`message message--${m.role}`}>
        {m.role === 'assistant' ? (
          <div className="message-content markdown">
            <SafeMarkdown content={m.content} />
          </div>
        ) : (
          <p className="message-content">{m.content ?? ''}</p>
        )}
        {m.txIds?.map((id) => (
          <a
            key={id}
            className="hashscan-link"
            href={`${HASHSCAN_BASE}/${id}`}
            target="_blank"
            rel="noreferrer"
          >
            View tx {id} on Hashscan ↗
          </a>
        ))}
      </div>
    </MessageErrorBoundary>
  );
}

// ── Status / thinking indicator ───────────────────────────────────────────────
function StatusBubble({ steps }) {
  const latest = steps[steps.length - 1] ?? 'Agent thinking…';
  return (
    <div className="message message--status">
      <p className="step">{latest}</p>
      <span className="spinner" />
    </div>
  );
}

// ── Campaign approval card ────────────────────────────────────────────────────
function ApprovalCard({ preview, onApprove, onCancel }) {
  const start = preview.startDate ? new Date(preview.startDate).toLocaleString() : 'now + 1 min';
  const end   = preview.endDate   ? new Date(preview.endDate).toLocaleString()   : 'start + 1 hr';

  return (
    <div className="approval-card">
      <div className="approval-card__header">
        <span className="approval-card__icon">📋</span>
        <span className="approval-card__title">Campaign Preview — Awaiting Approval</span>
      </div>
      <div className="approval-card__body">
        <div className="approval-row">
          <span className="approval-label">Name</span>
          <span className="approval-value">{preview.name}</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Voting Style</span>
          <span className="approval-value">{preview.votingStyle ?? 'STORY_FEATURE'}</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Opens</span>
          <span className="approval-value">{start}</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Closes</span>
          <span className="approval-value">{end}</span>
        </div>
        {preview.emailSubject && (
          <div className="approval-row">
            <span className="approval-label">Email Subject</span>
            <span className="approval-value">{preview.emailSubject}</span>
          </div>
        )}
        {preview.departmentIds?.length > 0 && (
          <div className="approval-row">
            <span className="approval-label">Departments</span>
            <span className="approval-value">IDs: {preview.departmentIds.join(', ')}</span>
          </div>
        )}
      </div>
      <div className="approval-card__actions">
        <button className="approval-btn approval-btn--approve" onClick={onApprove}>
          ✅ Approve — Create Campaign
        </button>
        <button className="approval-btn approval-btn--cancel" onClick={onCancel}>
          ✕ Cancel
        </button>
      </div>
    </div>
  );
}

// ── Main chat component ───────────────────────────────────────────────────────
export default function AgentChat() {
  const [messages, setMessages]           = useState([]);
  const [input, setInput]                 = useState('');
  const [loading, setLoading]             = useState(false);
  const [steps, setSteps]                 = useState([]);
  const [phase, setPhase]                 = useState('research');
  const [showTransition, setShowTransition] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, steps, pendingApproval]);

  async function sendMessage(text = input) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setInput('');
    setLoading(true);
    setSteps([]);
    setShowTransition(false);
    setPendingApproval(null);

    const userMsg = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${API_BASE}/api/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, chatHistory: history, phase }),
      });

      if (!res.ok) {
        throw new Error(`Server error ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            handleEvent(event);
          } catch {
            // malformed SSE chunk — skip
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'error', content: `Connection error: ${err.message}` },
      ]);
    } finally {
      setLoading(false);
      setSteps([]);
    }
  }

  function handleEvent(event) {
    switch (event.type) {
      case 'tool_start':
      case 'llm_start':
      case 'status':
        if (event.step) setSteps((prev) => [...prev, event.step]);
        break;
      case 'tool_end':
        break;
      case 'approval_request':
        if (event.campaignPreview) {
          setPendingApproval(event.campaignPreview);
        }
        break;
      case 'done': {
        const output = typeof event.output === 'string' ? event.output.trim() : '';
        if (output) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: output, txIds: event.txIds || [] },
          ]);
        }
        if (event.phase === 'research') setShowTransition(true);
        // If needsApproval flag is set but approval_request wasn't sent, fall back
        if (event.needsApproval && event.campaignPreview && !pendingApproval) {
          setPendingApproval(event.campaignPreview);
        }
        break;
      }
      case 'error':
        setMessages((prev) => [
          ...prev,
          { role: 'error', content: event.error ?? 'An unknown error occurred.' },
        ]);
        break;
      default:
        break;
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function handleApprove() {
    const preview = pendingApproval;
    setPendingApproval(null);
    sendMessage(`APPROVE - please create the campaign as described in the preview (name: "${preview?.name}")`);
  }

  function handleCancelApproval() {
    setPendingApproval(null);
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: 'Campaign creation cancelled. Let me know if you\'d like to adjust anything.', txIds: [] },
    ]);
  }

  const examplePrompts = phase === 'research' ? RESEARCH_PROMPTS : CAMPAIGN_PROMPTS;

  function handleTransitionToCampaign() {
    setPhase('campaign');
    setShowTransition(false);
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content:
          'Switching to campaign creation mode. Which team or event from the recommendations above would you like to feature? I\'ll help you find matching sustainability projects and create the campaign.',
        txIds: [],
      },
    ]);
  }

  return (
    <div className="chat-container">
      <div className="phase-bar">
        <span className={`phase-badge ${phase === 'research' ? 'phase-badge--active' : ''}`}>
          1 · Sports Research
        </span>
        <span className="phase-arrow">→</span>
        <span className={`phase-badge ${phase === 'campaign' ? 'phase-badge--active' : ''}`}>
          2 · Campaign Creation
        </span>
        {phase === 'campaign' && (
          <button
            className="phase-reset"
            onClick={() => { setPhase('research'); setShowTransition(false); setPendingApproval(null); }}
          >
            ← Back to Research
          </button>
        )}
      </div>

      {messages.length === 0 && (
        <div className="examples">
          <p className="examples-label">
            {phase === 'research'
              ? 'Find women\'s sports partners for a Nature Backers campaign:'
              : 'Try an example:'}
          </p>
          {examplePrompts.map((p) => (
            <button key={p} className="example-chip" onClick={() => sendMessage(p)}>
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="messages">
        {messages.map((m, i) => (
          <MessageBubble key={i} m={m} />
        ))}

        {loading && <StatusBubble steps={steps} />}

        {pendingApproval && !loading && (
          <ApprovalCard
            preview={pendingApproval}
            onApprove={handleApprove}
            onCancel={handleCancelApproval}
          />
        )}

        {showTransition && !loading && !pendingApproval && (
          <div className="transition-banner">
            <p>Ready to build a campaign around one of these organizations?</p>
            <button className="transition-btn" onClick={handleTransitionToCampaign}>
              Create a Nature Backers Campaign →
            </button>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="input-row">
        <textarea
          className="input-box"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            phase === 'research'
              ? 'Ask about women\'s sports organizations in a city or region…'
              : 'Ask the CarbonSustain campaign agent…'
          }
          disabled={loading}
        />
        <button
          className="send-btn"
          onClick={() => sendMessage()}
          disabled={loading || !input.trim()}
        >
          {loading ? 'Thinking…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
