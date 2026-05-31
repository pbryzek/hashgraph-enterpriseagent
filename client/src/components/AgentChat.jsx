import { useState, useRef, useEffect, Component } from 'react';
import ReactMarkdown from 'react-markdown';
import { useHashPack, USDC_TOKEN_ID } from '../hooks/HashPackContext.jsx';
import './AgentChat.css';

const API_BASE = import.meta.env.VITE_API_URL || '';
const NETWORK = import.meta.env.VITE_HEDERA_NETWORK || 'testnet';
const HASHSCAN_BASE = `https://hashscan.io/${NETWORK}/transaction`;

/**
 * Normalise a Hedera Transaction ID for Hashscan URLs.
 * shard.realm.num@seconds.nanos -> shard.realm.num-seconds-nanos
 */
function formatHashscanId(id) {
  if (!id || typeof id !== 'string') return id;
  const [acc, time] = id.split('@');
  if (!time) return id.replace('@', '-'); 
  return `${acc}-${time.replace('.', '-')}`;
}

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
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noreferrer">{children}</a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
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
            href={`${HASHSCAN_BASE}/${formatHashscanId(id)}`}
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
    <div className="approval-card" style={{ borderLeft: '4px solid #eab308' }}>
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

// ── HashPack payment card ─────────────────────────────────────────────────────
function HashPackPaymentCard({ payment, onDone }) {
  console.log('[HashPackPaymentCard] Rendering for campaign:', payment.campaignName);
  const { accountId, connect, ready, error: walletError, connectorRef, sendHbar } = useHashPack();
  const [signing, setSigning]           = useState(false);
  const [isHung, setIsHung]             = useState(false);
  const [waitingForTxId, setWaiting]    = useState(false);
  const [isConfirmed, setIsConfirmed]   = useState(false);
  const [txId, setTxId]                 = useState(null);
  const [err, setErr]                   = useState(null);
  const doneCalledRef      = useRef(false);
  const manualConfirmedRef = useRef(false);
  const signedAtRef        = useRef(null); // epoch-seconds when Sign was clicked

  // Query the mirror node for the latest successful transfer from accountId → toAccount
  // after `afterTs` (epoch-seconds). Retries up to 10 times with 3s gaps.
  async function pollMirrorForTx(fromAccount, toAccount, afterTs, onResult) {
    const host = NETWORK === 'mainnet'
      ? 'mainnet-public.mirrornode.hedera.com'
      : 'testnet.mirrornode.hedera.com';
    // Mirror node requires seconds.nanoseconds format; drop the type filter (unsupported param name)
    const tsParam = `${afterTs}.000000000`;
    const url = `https://${host}/api/v1/transactions?account.id=${fromAccount}&order=desc&limit=10&timestamp=gte:${tsParam}`;

    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      if (doneCalledRef.current) return; // executeWithSigner already resolved

      try {
        const res = await fetch(url);
        if (!res.ok) { console.warn(`[pollMirrorForTx] ${res.status} from mirror node (attempt ${attempt + 1})`); continue; }
        const { transactions = [] } = await res.json();

        for (const tx of transactions) {
          if (tx.result !== 'SUCCESS') continue;
          const match = tx.transfers?.find(t => t.account === toAccount && t.amount > 0);
          if (match) { onResult(tx.transaction_id); return; }
        }
      } catch (e) { console.warn(`[pollMirrorForTx] fetch error (attempt ${attempt + 1}):`, e.message); }
    }

    // Not found after ~30 seconds — proceed without a link
    if (!doneCalledRef.current) onResult(null);
  }

  async function handleSign() {
    setSigning(true);
    setErr(null);
    setIsHung(false);
    setWaiting(false);
    setIsConfirmed(false);
    setTxId(null);
    doneCalledRef.current      = false;
    manualConfirmedRef.current = false;
    signedAtRef.current        = Math.floor(Date.now() / 1000) - 5; // 5s buffer

    let timer = null;

    try {
      const sendPromise = sendHbar(payment.amount, payment.toAccount);

      // Single authoritative place where onDone is called — guarantees the real txId.
      // Fires both when wallet responds before timeout AND after (hung case).
      sendPromise
        .then((result) => {
          clearTimeout(timer);
          const actualId = result?.transactionId?.toString() ?? null;
          if (actualId) setTxId(actualId);
          setIsConfirmed(true);
          setIsHung(false);
          setWaiting(false);
          setSigning(false);
          if (!doneCalledRef.current) {
            doneCalledRef.current = true;
            onDone?.({ txId: actualId, amount: payment.amount, toAccount: payment.toAccount });
          }
        })
        .catch((e) => {
          clearTimeout(timer);
          if (manualConfirmedRef.current && !doneCalledRef.current) {
            // User said they signed but wallet errored — dismiss without a link
            doneCalledRef.current = true;
            setIsConfirmed(true);
            setWaiting(false);
            onDone?.({ txId: null, amount: payment.amount, toAccount: payment.toAccount });
          } else if (!manualConfirmedRef.current) {
            setErr(e?.message ?? 'Transaction failed');
            setSigning(false);
            setIsHung(false);
            setWaiting(false);
          }
        });

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          setIsHung(true);
          reject(new Error('TIMEOUT'));
        }, 45000);
      });

      const result = await Promise.race([sendPromise, timeoutPromise]);
      clearTimeout(timer);

      // sendPromise won before timeout — background .then() above handles onDone
      const id = result?.transactionId?.toString() ?? null;
      if (id) setTxId(id);
      setIsConfirmed(true);
      setSigning(false);
      // doneCalledRef prevents a double onDone call if .then() fires first
    } catch (e) {
      clearTimeout(timer);
      if (e.message !== 'TIMEOUT') {
        setErr(e.message);
        setSigning(false);
      }
      // TIMEOUT: background .then()/.catch() handles onDone when wallet responds
    }
  }

  // Normalise txId for Hashscan URL
  const hashscanTxId = formatHashscanId(txId);

  return (
    <div className="approval-card" style={{ borderLeft: '4px solid #16a34a' }}>
      <div className="approval-card__header">
        <span className="approval-card__icon">💚</span>
        <span className="approval-card__title">HBAR Donation — Sign with HashPack</span>
      </div>

      <div className="approval-card__body">
        <div className="approval-row">
          <span className="approval-label">Campaign</span>
          <span className="approval-value">{payment.campaignName}</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Amount</span>
          <span className="approval-value">{payment.amount} HBAR</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">To</span>
          <span className="approval-value" style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>
            {payment.toAccount}
          </span>
        </div>
        {accountId && (
          <div className="approval-row">
            <span className="approval-label">From</span>
            <span className="approval-value" style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>
              {accountId}
            </span>
          </div>
        )}
      </div>

      {isConfirmed ? (
        <div style={{ padding: '12px 16px', color: '#16a34a', fontSize: '0.85rem' }}>
          ✅ Sent!&nbsp;
          <a
            href={`https://hashscan.io/${NETWORK}/transaction/${hashscanTxId}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#7c3aed' }}
          >
            View on Hashscan ↗
          </a>
        </div>
      ) : (
        <div className="approval-card__actions">
          {walletError && (
            <p style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: 8 }}>
              Wallet error: {walletError}
            </p>
          )}

          {!accountId ? (
            <button
              className="approval-btn approval-btn--approve"
              onClick={connect}
              disabled={!ready}
            >
              {!ready ? 'Initializing wallet…' : '🔗 Connect HashPack to sign'}
            </button>
          ) : (
            <>
              {!isHung && (
                <button
                  className="approval-btn approval-btn--approve"
                  onClick={handleSign}
                  disabled={signing}
                >
                  {signing ? 'Waiting for HashPack…' : `Sign & Send ${payment.amount} HBAR`}
                </button>
              )}

              {signing && !isHung && (
                <p style={{ fontSize: '0.73rem', color: '#6b7280', margin: '6px 0 0' }}>
                  No popup? Open HashPack → click the <strong>DAPPS</strong> tab → approve the pending request.
                </p>
              )}

              {isHung && (
                <div style={{ marginTop: 12, padding: '12px', backgroundColor: '#fff7ed', borderRadius: 8, border: '1px solid #ffedd5' }}>
                  <p style={{ fontSize: '0.82rem', color: '#9a3412', margin: '0 0 8px 0', lineHeight: 1.4 }}>
                    <strong>HashPack hasn't responded yet.</strong><br/>
                    If you approved in the wallet, click below — we'll fetch the transaction link automatically.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="approval-btn approval-btn--approve"
                      style={{ padding: '6px 12px', fontSize: '0.75rem', flex: 1 }}
                      onClick={() => {
                        manualConfirmedRef.current = true;
                        setIsHung(false);
                        setWaiting(true);

                        pollMirrorForTx(accountId, payment.toAccount, signedAtRef.current, (foundTxId) => {
                          if (!doneCalledRef.current) {
                            doneCalledRef.current = true;
                            if (foundTxId) setTxId(foundTxId);
                            setIsConfirmed(true);
                            setWaiting(false);
                            onDone?.({ txId: foundTxId, amount: payment.amount, toAccount: payment.toAccount });
                          }
                        });
                      }}
                    >
                      ✅ I've signed — get tx link
                    </button>
                    <button
                      className="approval-btn"
                      style={{ padding: '6px 12px', fontSize: '0.75rem', backgroundColor: '#f3f4f6' }}
                      onClick={() => { setSigning(false); setIsHung(false); }}
                    >
                      Retry
                    </button>
                  </div>
                  {accountId && (
                    <div style={{ marginTop: 8, fontSize: '0.75rem' }}>
                      <a
                        href={`https://hashscan.io/${NETWORK}/account/${accountId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: '#7c3aed', textDecoration: 'underline' }}
                      >
                        View account on HashScan ↗
                      </a>
                    </div>
                  )}
                </div>
              )}

              {waitingForTxId && !isConfirmed && (
                <div style={{ padding: '10px 0 4px', fontSize: '0.82rem', color: '#6b7280', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="spinner" style={{ borderColor: '#d1d5db', borderTopColor: '#6b7280' }} />
                  Looking up your transaction on the Hedera mirror node…
                </div>
              )}
            </>
          )}

          {err && (
            <p style={{ color: '#ef4444', fontSize: '0.78rem', margin: '8px 0 0' }}>❌ {err}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── HashPack USDC payment card ────────────────────────────────────────────────
function HashPackUsdcPaymentCard({ payment, onDone }) {
  const { accountId, connect, ready, error: walletError, sendUsdc } = useHashPack();
  const [signing, setSigning]         = useState(false);
  const [isHung, setIsHung]           = useState(false);
  const [waitingForTxId, setWaiting]  = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [txId, setTxId]               = useState(null);
  const [err, setErr]                 = useState(null);
  const doneCalledRef      = useRef(false);
  const manualConfirmedRef = useRef(false);
  const signedAtRef        = useRef(null);

  async function pollMirrorForUsdcTx(fromAccount, toAccount, afterTs, onResult) {
    const host = NETWORK === 'mainnet'
      ? 'mainnet-public.mirrornode.hedera.com'
      : 'testnet.mirrornode.hedera.com';
    const tsParam = `${afterTs}.000000000`;
    const url = `https://${host}/api/v1/transactions?account.id=${fromAccount}&order=desc&limit=10&timestamp=gte:${tsParam}`;

    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 3000));
      if (doneCalledRef.current) return;
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const { transactions = [] } = await res.json();
        for (const tx of transactions) {
          if (tx.result !== 'SUCCESS') continue;
          const match = tx.token_transfers?.find(
            t => t.token_id === USDC_TOKEN_ID && t.account === toAccount && t.amount > 0
          );
          if (match) { onResult(tx.transaction_id); return; }
        }
      } catch { /* retry */ }
    }
    if (!doneCalledRef.current) onResult(null);
  }

  async function handleSign() {
    setSigning(true);
    setErr(null);
    setIsHung(false);
    setWaiting(false);
    setIsConfirmed(false);
    setTxId(null);
    doneCalledRef.current      = false;
    manualConfirmedRef.current = false;
    signedAtRef.current        = Math.floor(Date.now() / 1000) - 5;

    let timer = null;

    try {
      const sendPromise = sendUsdc(payment.amount, payment.toAccount);

      sendPromise
        .then((result) => {
          clearTimeout(timer);
          const actualId = result?.transactionId?.toString() ?? null;
          if (actualId) setTxId(actualId);
          setIsConfirmed(true);
          setIsHung(false);
          setWaiting(false);
          setSigning(false);
          if (!doneCalledRef.current) {
            doneCalledRef.current = true;
            onDone?.({ txId: actualId, amount: payment.amount, toAccount: payment.toAccount });
          }
        })
        .catch((e) => {
          clearTimeout(timer);
          if (manualConfirmedRef.current && !doneCalledRef.current) {
            doneCalledRef.current = true;
            setIsConfirmed(true);
            setWaiting(false);
            onDone?.({ txId: null, amount: payment.amount, toAccount: payment.toAccount });
          } else if (!manualConfirmedRef.current) {
            setErr(e?.message ?? 'Transaction failed');
            setSigning(false);
            setIsHung(false);
            setWaiting(false);
          }
        });

      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => { setIsHung(true); reject(new Error('TIMEOUT')); }, 45000);
      });

      const result = await Promise.race([sendPromise, timeoutPromise]);
      clearTimeout(timer);
      const id = result?.transactionId?.toString() ?? null;
      if (id) setTxId(id);
      setIsConfirmed(true);
      setSigning(false);
    } catch (e) {
      clearTimeout(timer);
      if (e.message !== 'TIMEOUT') { setErr(e.message); setSigning(false); }
    }
  }

  const hashscanTxId = formatHashscanId(txId);

  return (
    <div className="approval-card" style={{ borderLeft: '4px solid #2563eb' }}>
      <div className="approval-card__header">
        <span className="approval-card__icon">💵</span>
        <span className="approval-card__title">USDC Donation — Sign with HashPack</span>
      </div>

      {/* Token association notice */}
      <div style={{ margin: '0 0 8px', padding: '10px 16px', backgroundColor: '#eff6ff', borderRadius: 6, fontSize: '0.78rem', color: '#1e40af', lineHeight: 1.5 }}>
        <strong>Before signing:</strong> You must associate USDC token <code style={{ fontFamily: 'monospace' }}>{USDC_TOKEN_ID}</code> with your HashPack wallet.
        Get test USDC from the{' '}
        <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer" style={{ color: '#2563eb', textDecoration: 'underline' }}>Circle Faucet ↗</a>
        {' '}(association happens automatically when you claim).
      </div>

      <div className="approval-card__body">
        <div className="approval-row">
          <span className="approval-label">Campaign</span>
          <span className="approval-value">{payment.campaignName}</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Amount</span>
          <span className="approval-value">{payment.amount} USDC</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Token</span>
          <span className="approval-value" style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{USDC_TOKEN_ID}</span>
        </div>
        <div className="approval-row">
          <span className="approval-label">To</span>
          <span className="approval-value" style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{payment.toAccount}</span>
        </div>
        {accountId && (
          <div className="approval-row">
            <span className="approval-label">From</span>
            <span className="approval-value" style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>{accountId}</span>
          </div>
        )}
      </div>

      {isConfirmed ? (
        <div style={{ padding: '12px 16px', color: '#16a34a', fontSize: '0.85rem' }}>
          ✅ Sent!&nbsp;
          {txId && (
            <a
              href={`https://hashscan.io/${NETWORK}/transaction/${hashscanTxId}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: '#7c3aed' }}
            >
              View on Hashscan ↗
            </a>
          )}
        </div>
      ) : (
        <div className="approval-card__actions">
          {walletError && (
            <p style={{ color: '#ef4444', fontSize: '0.75rem', marginBottom: 8 }}>
              Wallet error: {walletError}
            </p>
          )}

          {!accountId ? (
            <button className="approval-btn approval-btn--approve" onClick={connect} disabled={!ready}>
              {!ready ? 'Initializing wallet…' : '🔗 Connect HashPack to sign'}
            </button>
          ) : (
            <>
              {!isHung && (
                <button
                  className="approval-btn approval-btn--approve"
                  style={{ backgroundColor: '#2563eb' }}
                  onClick={handleSign}
                  disabled={signing}
                >
                  {signing ? 'Waiting for HashPack…' : `Sign & Send ${payment.amount} USDC`}
                </button>
              )}

              {signing && !isHung && (
                <p style={{ fontSize: '0.73rem', color: '#6b7280', margin: '6px 0 0' }}>
                  No popup? Open HashPack → click the <strong>DAPPS</strong> tab → approve the pending request.
                </p>
              )}

              {isHung && (
                <div style={{ marginTop: 12, padding: '12px', backgroundColor: '#eff6ff', borderRadius: 8, border: '1px solid #bfdbfe' }}>
                  <p style={{ fontSize: '0.82rem', color: '#1e3a8a', margin: '0 0 8px 0', lineHeight: 1.4 }}>
                    <strong>HashPack hasn't responded yet.</strong><br/>
                    If you approved in the wallet, click below — we'll fetch the transaction link automatically.
                  </p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="approval-btn approval-btn--approve"
                      style={{ padding: '6px 12px', fontSize: '0.75rem', flex: 1, backgroundColor: '#2563eb' }}
                      onClick={() => {
                        manualConfirmedRef.current = true;
                        setIsHung(false);
                        setWaiting(true);
                        pollMirrorForUsdcTx(accountId, payment.toAccount, signedAtRef.current, (foundTxId) => {
                          if (!doneCalledRef.current) {
                            doneCalledRef.current = true;
                            if (foundTxId) setTxId(foundTxId);
                            setIsConfirmed(true);
                            setWaiting(false);
                            onDone?.({ txId: foundTxId, amount: payment.amount, toAccount: payment.toAccount });
                          }
                        });
                      }}
                    >
                      ✅ I've signed — get tx link
                    </button>
                    <button
                      className="approval-btn"
                      style={{ padding: '6px 12px', fontSize: '0.75rem', backgroundColor: '#f3f4f6' }}
                      onClick={() => { setSigning(false); setIsHung(false); }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              )}

              {waitingForTxId && !isConfirmed && (
                <div style={{ padding: '10px 0 4px', fontSize: '0.82rem', color: '#6b7280', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="spinner" style={{ borderColor: '#d1d5db', borderTopColor: '#6b7280' }} />
                  Looking up your USDC transaction on the Hedera mirror node…
                </div>
              )}
            </>
          )}

          {err && <p style={{ color: '#ef4444', fontSize: '0.78rem', margin: '8px 0 0' }}>❌ {err}</p>}
        </div>
      )}
    </div>
  );
}

// ── Inline user registration card (shown before campaign phase starts) ────────
function RegistrationCard({ onComplete, onSkip }) {
  const [form, setForm]       = useState({ firstName: '', lastName: '', email: '' });
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);

  const isValid = form.firstName.trim() && form.lastName.trim() && /\S+@\S+/.test(form.email);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/user/ensure`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          firstName: form.firstName.trim(),
          lastName:  form.lastName.trim(),
          email:     form.email.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to process account.');
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <div className="approval-card" style={{ borderLeft: '4px solid #6DBE45' }}>
        <div className="approval-card__header">
          <span className="approval-card__icon">{result.created ? '🎉' : '✅'}</span>
          <span className="approval-card__title">
            {result.created ? 'Account Created' : 'Account Found'}
          </span>
        </div>
        <div className="approval-card__body">
          <div className="approval-row">
            <span className="approval-label">Name</span>
            <span className="approval-value">{result.user.firstName} {result.user.lastName}</span>
          </div>
          <div className="approval-row">
            <span className="approval-label">Email</span>
            <span className="approval-value" style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}>
              {result.user.email}
            </span>
          </div>
          {result.created && (
            <div className="approval-row">
              <span className="approval-label">Department</span>
              <span className="approval-value">{result.department} · Role 3</span>
            </div>
          )}
        </div>
        <div className="approval-card__actions">
          <button className="approval-btn approval-btn--approve" onClick={() => onComplete(result.user)}>
            Continue to Campaign Creation →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="approval-card" style={{ borderLeft: '4px solid #3DBFBF' }}>
      <div className="approval-card__header">
        <span className="approval-card__icon">👤</span>
        <span className="approval-card__title">Who's creating this campaign?</span>
      </div>
      <form onSubmit={handleSubmit}>
        <div className="approval-card__body">
          <div className="reg-field">
            <label>First Name</label>
            <input type="text" placeholder="Jane" value={form.firstName} disabled={loading}
              onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} />
          </div>
          <div className="reg-field">
            <label>Last Name</label>
            <input type="text" placeholder="Doe" value={form.lastName} disabled={loading}
              onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} />
          </div>
          <div className="reg-field">
            <label>Business Email</label>
            <input type="email" placeholder="jane@company.com" value={form.email} disabled={loading}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
          </div>
          {error && <p className="reg-error">{error}</p>}
        </div>
        <div className="approval-card__actions">
          <button type="submit" className="approval-btn approval-btn--approve" disabled={!isValid || loading}>
            {loading ? 'Looking up account…' : 'Continue'}
          </button>
          <button type="button" className="approval-btn approval-btn--cancel" onClick={onSkip}>
            Skip
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Main chat component ───────────────────────────────────────────────────────
export default function AgentChat() {
  const [messages, setMessages]               = useState([]);
  const [input, setInput]                     = useState('');
  const [loading, setLoading]                 = useState(false);
  const [steps, setSteps]                     = useState([]);
  const [phase, setPhase]                     = useState('research');
  const [showTransition, setShowTransition]   = useState(false);
  const [pendingApproval, setPendingApproval]     = useState(null);
  const [pendingPayment, setPendingPayment]       = useState(null);
  const [pendingUsdcPayment, setPendingUsdcPayment] = useState(null);
  const [pendingUserReg, setPendingUserReg]       = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
    return () => clearTimeout(timer);
  }, [messages, steps, pendingApproval, pendingPayment]);

  async function sendMessage(text = input) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setInput('');
    setLoading(true);
    setSteps([]);
    setShowTransition(false);
    setPendingApproval(null);
    // Keep pendingPayment visible across turns until signed or dismissed

    const userMsg = { role: 'user', content: trimmed };
    setMessages((prev) => [...prev, userMsg]);

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${API_BASE}/api/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, chatHistory: history, phase }),
      });

      if (!res.ok) throw new Error(`Server error ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

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
    console.log('[AgentChat] SSE Event:', event.type, event);
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
          console.log('[AgentChat] Setting pendingApproval:', event.campaignPreview);
          setPendingApproval(event.campaignPreview);
        }
        break;

      case 'hashpack_payment':
        if (event.payment) {
          console.log('[AgentChat] Setting pendingPayment:', event.payment);
          setPendingPayment(event.payment);
        }
        break;

      case 'hashpack_usdc_payment':
        if (event.payment) {
          console.log('[AgentChat] Setting pendingUsdcPayment:', event.payment);
          setPendingUsdcPayment(event.payment);
        }
        break;

      case 'done': {
        let output = typeof event.output === 'string' ? event.output.trim() : '';

        // Safety net: if the server somehow let a raw campaign_preview JSON through
        // as the output text, suppress it — the approval card handles the display.
        if (output) {
          try {
            const parsed = JSON.parse(output);
            if (parsed?.__type === 'campaign_preview') {
              console.log('[AgentChat] Suppressing raw campaign_preview JSON from output text');
              output = '';
            }
          } catch { /* not pure JSON — leave as-is */ }
        }

        if (output) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: output, txIds: event.txIds || [] },
          ]);
        }
        if (event.phase === 'research') setShowTransition(true);
        if (event.needsApproval && event.campaignPreview && !pendingApproval) {
          console.log('[AgentChat] Done event: triggering pendingApproval fallback');
          setPendingApproval(event.campaignPreview);
        }
        if (event.needsPayment && event.payment && !pendingPayment) {
          console.log('[AgentChat] Done event: triggering pendingPayment fallback');
          setPendingPayment(event.payment);
        }
        if (event.needsUsdcPayment && event.payment && !pendingUsdcPayment) {
          console.log('[AgentChat] Done event: triggering pendingUsdcPayment fallback');
          setPendingUsdcPayment(event.payment);
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
      {
        role: 'assistant',
        content: 'Campaign creation cancelled. Let me know if you\'d like to adjust anything.',
        txIds: [],
      },
    ]);
  }

  function handleTransitionToCampaign() {
    setShowTransition(false);
    setPendingUserReg(true); // Ask for user details before switching phase
  }

  function completeCampaignTransition(user) {
    setPendingUserReg(false);
    setPhase('campaign');
    const greeting = user ? `Got it, ${user.firstName}! ` : '';
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content:
          `${greeting}Switching to campaign creation mode. Which team or event from the recommendations above would you like to feature? I'll help you find matching sustainability projects and create the campaign.`,
        txIds: [],
      },
    ]);
  }

  const examplePrompts = phase === 'research' ? RESEARCH_PROMPTS : CAMPAIGN_PROMPTS;

  return (
    <div className="chat-container">
      <div className="phase-bar">
        <span className={`phase-badge ${phase === 'research' ? 'phase-badge--active' : ''}`}>
          1 · Campaign Brief
        </span>
        <span className="phase-arrow">→</span>
        <span className={`phase-badge ${phase === 'campaign' ? 'phase-badge--active' : ''}`}>
          2 · Campaign Creation
        </span>
        {phase === 'campaign' && (
          <button
            className="phase-reset"
            onClick={() => {
              setPhase('research');
              setShowTransition(false);
              setPendingApproval(null);
              setPendingUserReg(false);
            }}
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

        {pendingPayment && (
          <HashPackPaymentCard
            payment={pendingPayment}
            onDone={({ txId, amount, toAccount }) => {
              const link = txId
                ? `\n[View on Hashscan](https://hashscan.io/${NETWORK}/transaction/${formatHashscanId(txId)})`
                : '';
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content: `✅ Sent ${amount} HBAR to ${toAccount}.${link}`,
                  txIds: [],
                },
              ]);
              setPendingPayment(null);
            }}
          />
        )}

        {pendingUsdcPayment && (
          <HashPackUsdcPaymentCard
            payment={pendingUsdcPayment}
            onDone={({ txId, amount, toAccount }) => {
              const link = txId
                ? `\n[View on Hashscan](https://hashscan.io/${NETWORK}/transaction/${formatHashscanId(txId)})`
                : '';
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content: `✅ Sent ${amount} USDC to ${toAccount}.${link}`,
                  txIds: [],
                },
              ]);
              setPendingUsdcPayment(null);
            }}
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

        {pendingUserReg && (
          <RegistrationCard
            onComplete={completeCampaignTransition}
            onSkip={() => completeCampaignTransition(null)}
          />
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
              : 'Ask the Nature Backers campaign agent…'
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
