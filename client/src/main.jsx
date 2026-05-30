import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashPackProvider } from './hooks/HashPackContext.jsx';
import App from './App.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashPackProvider>
      <App />
    </HashPackProvider>
  </StrictMode>
);
