import { useState, useEffect } from 'react';
import AgentChat from './components/AgentChat.jsx';
import VotePage from './components/VotePage.jsx';
import IndexerPage from './components/IndexerPage.jsx';
import HashPackDonate from './components/HashPackDonate.jsx';
import nbAgentIcon from '../nb_agent_icon.png';
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
        // non-critical
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

// Simple client-side routing without react-router-dom
function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const handler = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  return pathname;
}

export default function App() {
  const pathname = usePathname();

  // /vote/:campaignId route
  const voteMatch = pathname.match(/^\/vote\/(\d+)\/?$/);
  if (voteMatch) {
    return <VotePage campaignId={voteMatch[1]} />;
  }

  // /indexer/:timestamp route — in-app Guardian VC document viewer
  const indexerMatch = pathname.match(/^\/indexer\/(.+)$/);
  if (indexerMatch) {
    return <IndexerPage timestamp={decodeURIComponent(indexerMatch[1])} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <img src={nbAgentIcon} alt="Nature Backers Agent" className="logo-icon" />
        <div className="app-header__text">
          <h1>
            <span className="logo-name">nature backers</span>
            {' '}
            <span className="logo-agent">agent</span>
          </h1>
          <p>Built with CarbonSustain</p>
        </div>
        <HbarTicker />
        <HashPackDonate />
      </header>
      <AgentChat />
    </div>
  );
}
