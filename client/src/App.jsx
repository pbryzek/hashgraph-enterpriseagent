import { useState, useEffect } from 'react';
import AgentChat from './components/AgentChat.jsx';
import './App.css';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=hedera-hashgraph&vs_currencies=usd&include_24hr_change=true';

function HbarTicker() {
  const [data, setData] = useState(null);

  useEffect(() => {
    async function fetch_() {
      try {
        const res  = await fetch(COINGECKO_URL);
        const json = await res.json();
        const hbar = json?.['hedera-hashgraph'];
        if (!hbar) return;
        setData({
          price:  hbar.usd.toFixed(5),
          change: hbar.usd_24h_change?.toFixed(2) ?? '0.00',
        });
      } catch {
        // non-critical — silently skip
      }
    }
    fetch_();
    const id = setInterval(fetch_, 60_000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  const up = parseFloat(data.change) >= 0;
  return (
    <div className="hbar-ticker">
      <span className="hbar-ticker__label">HBAR</span>
      <span className="hbar-ticker__price">${data.price}</span>
      <span className={`hbar-ticker__change ${up ? 'up' : 'down'}`}>
        {up ? '▲' : '▼'} {Math.abs(data.change)}%
      </span>
    </div>
  );
}

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">🌿</span>
        <div className="app-header__text">
          <h1>CarbonSustain</h1>
          <p>Nature-Based Solutions Agent — powered by NatureBackers</p>
        </div>
        <HbarTicker />
      </header>
      <AgentChat />
    </div>
  );
}
