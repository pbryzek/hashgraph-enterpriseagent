import { useState, useRef, useEffect } from 'react';
import './AgentChat.css';

const HASHSCAN_BASE = 'https://hashscan.io/testnet/transaction';
const API_BASE = import.meta.env.VITE_API_URL || '';

const EXAMPLE_PROMPTS = [
  'Find water sustainability projects in East Africa.',
  'Search for SDG 6 clean water projects I can feature in a fan campaign.',
  'What nature-based solutions projects involve reforestation?',
];

export default function AgentChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [steps, setSteps] = useState([]);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, steps]);

  async function sendMessage(text = input) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setInput('');
    setLoading(true);
    setSteps([]);

    const userMsg = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);

    // Build chat history from existing messages (exclude the one we just added)
    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${API_BASE}/api/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, chatHistory: history }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            handleEvent(event);
          } catch {
            // malformed chunk; ignore
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
        setSteps((prev) => [...prev, event.step]);
        break;
      case 'done':
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: event.output, txIds: event.txIds || [] },
        ]);
        break;
      case 'error':
        setMessages((prev) => [
          ...prev,
          { role: 'error', content: event.error },
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

  return (
    <div className="chat-container">
      {messages.length === 0 && (
        <div className="examples">
          <p className="examples-label">Try an example:</p>
          {EXAMPLE_PROMPTS.map((p) => (
            <button key={p} className="example-chip" onClick={() => sendMessage(p)}>
              {p}
            </button>
          ))}
        </div>
      )}

      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`message message--${m.role}`}>
            <p className="message-content">{m.content}</p>
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
        ))}

        {loading && steps.length > 0 && (
          <div className="message message--status">
            {steps.map((s, i) => (
              <p key={i} className="step">{s}</p>
            ))}
            <span className="spinner" />
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
          placeholder="Ask the CarbonSustain agent…"
          disabled={loading}
        />
        <button
          className="send-btn"
          onClick={() => sendMessage()}
          disabled={loading || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
