import { useHashPack } from '../hooks/HashPackContext.jsx';
import './HashPackDonate.css';

function shortAccount(id) {
  if (!id) return '';
  const parts = id.split('.');
  return `${parts[0]}.${parts[1]}.…${parts[2]?.slice(-4)}`;
}

export default function HashPackDonate() {
  const { accountId, ready, isConnecting, error, connect, disconnect } = useHashPack();

  if (!accountId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        <button
          className="hp-connect-btn"
          onClick={connect}
          disabled={!ready || isConnecting}
        >
          {!ready ? 'Initializing…' : isConnecting ? 'Opening wallet…' : 'Connect Wallet'}
        </button>
        {error && <span className="hp-inline-error">{error}</span>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div className="hp-account-pill">
        <span className="hp-dot" />
        <span className="hp-account-text">{shortAccount(accountId)}</span>
      </div>
      <button className="hp-disconnect-btn" onClick={disconnect}>Disconnect</button>
    </div>
  );
}
