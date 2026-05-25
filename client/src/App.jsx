import AgentChat from './components/AgentChat.jsx';
import './App.css';

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <span className="logo">🌿</span>
        <div>
          <h1>CarbonSustain</h1>
          <p>Nature-Based Solutions Agent — powered by NatureBackers</p>
        </div>
      </header>
      <AgentChat />
    </div>
  );
}
