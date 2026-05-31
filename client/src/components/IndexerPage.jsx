import { useState, useEffect } from 'react';
import './IndexerPage.css';

const API_BASE = import.meta.env.VITE_API_URL || '';
// Indexer documents are always on mainnet regardless of which network the agent uses
const HASHSCAN_MAINNET = 'https://hashscan.io/mainnet';

// ── Helpers ───────────────────────────────────────────────────────────────────

function str(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim();
  return s && s !== 'Not specified' && s !== 'Not applicable' &&
    !/^[0-9a-f-]{36}$/i.test(s) ? s : null;
}

function extractCs(doc) {
  // Try item.documents array (Guardian indexer shape)
  const documents = doc?.item?.documents ?? doc?.documents;
  if (Array.isArray(documents) && documents.length > 0) {
    try {
      const vc = typeof documents[0] === 'string' ? JSON.parse(documents[0]) : documents[0];
      const cs = vc?.credentialSubject;
      if (cs != null) return Array.isArray(cs) ? cs[0] : cs;
    } catch { /* ignore */ }
  }
  // Fallback paths
  for (const c of [
    doc?.document?.credentialSubject,
    doc?.vc?.credentialSubject,
    doc?.credentialSubject,
    doc?.item?.document?.credentialSubject,
  ]) {
    if (c != null) return Array.isArray(c) ? c[0] : c;
  }
  return null;
}

function extractName(cs) {
  if (!cs) return null;
  const pd   = typeof cs.projectDescription === 'object' ? cs.projectDescription : {};
  const pdet = typeof cs.project_details    === 'object' ? cs.project_details    : {};
  return str(cs.name) ?? str(cs.projectTitle) ?? str(cs['Project title']) ??
    str(cs.vcs_project_title) ?? str(cs.projectName) ?? str(cs.title) ??
    str(pd.name) ?? str(pdet.G5) ?? null;
}

function extractDescription(cs) {
  if (!cs) return null;
  const pd   = typeof cs.projectDescription === 'object' ? cs.projectDescription : {};
  const pdet = typeof cs.project_details    === 'object' ? cs.project_details    : {};
  const raw  = str(cs.summaryDescription) ?? str(pd.G132) ?? str(pdet.G132) ??
    str(cs['Project Description']) ?? str(cs.vcs_project_description) ??
    str(cs.description) ?? str(cs.summary);
  if (!raw) return null;
  return raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
}

function extractType(cs) {
  if (!cs) return null;
  if (cs.category) return str(cs.category);
  if (cs.projectTypes) return Array.isArray(cs.projectTypes) ? cs.projectTypes.join(', ') : str(cs.projectTypes);
  if (cs.projectType) return Array.isArray(cs.projectType) ? cs.projectType.join(', ') : str(cs.projectType);
  const pd = typeof cs.projectDescription === 'object' ? cs.projectDescription : {};
  const g143 = pd?.G143;
  if (typeof g143 === 'object' && str(g143?.G6)) return str(g143.G6);
  return str(cs.project_type) ?? str(cs.type_of_project) ?? str(cs.scope);
}

function extractSdgs(cs) {
  if (!cs) return [];
  const candidates = [
    cs.impactAndRiskSdgs,
    cs.projectDescription?.impactAndRiskSdgs,
    cs.project_details?.impactAndRiskSdgs,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c.filter(Boolean);
  }
  if (cs.SDGImpact && typeof cs.SDGImpact === 'string') {
    const matches = [...cs.SDGImpact.matchAll(/\b(1[0-7]|[1-9]) - /g)];
    return [...new Set(matches.map(m => parseInt(m[1], 10)))].sort((a, b) => a - b)
      .map(n => `SDG ${n}`);
  }
  return [];
}

// Fallback: try to get a project name from analytics.textSearch pipe-delimited format
function nameFromTextSearch(textSearch) {
  if (!textSearch) return null;
  const parts = textSearch.split('|');
  // The payload starts around index 12; scan for the first plausible name segment
  for (let i = 12; i < Math.min(parts.length, 22); i++) {
    const p = parts[i].trim();
    if (!p || p === '[object Object]') continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(p)) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(p)) continue;
    if (p.length >= 4 && p.length <= 200) return p;
  }
  return null;
}

function extractFields(raw) {
  // Unwrap common NatureBackers API envelope: { data: {...} } or bare
  const doc = raw?.data ?? raw;

  const cs        = extractCs(doc);
  const analytics = doc?.item?.analytics ?? doc?.analytics ?? {};
  const timestamp = doc?.item?.consensusTimestamp ?? doc?.consensusTimestamp
    ?? analytics?.messageId ?? null;

  const name =
    extractName(cs) ??
    nameFromTextSearch(analytics.textSearch) ??
    `Project ${timestamp ?? 'unknown'}`;

  return {
    name,
    description: extractDescription(cs),
    type:        extractType(cs),
    methodology: str(cs?.projectMethodology) ?? str(cs?.methodology),
    standard:    str(cs?.standard) ?? str(cs?.standards?.carbonStandard)
                 ?? str(cs?.registry) ?? str(cs?.certificationBody),
    location:    str(cs?.location) ?? str(cs?.country) ?? str(cs?.projectCountry)
                 ?? str(cs?.region) ?? str(cs?.['Project Country']),
    sdgs:        extractSdgs(cs),
    timestamp,
    schema:      analytics.schemaName ?? null,
  };
}

// ── Page component ────────────────────────────────────────────────────────────

export default function IndexerPage({ timestamp }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${API_BASE}/api/indexer/vc/${encodeURIComponent(timestamp)}`);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        setData(await res.json());
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [timestamp]);

  if (loading) return (
    <div className="ix-shell">
      <div className="ix-loading">Loading document from Guardian indexer…</div>
    </div>
  );

  if (error) return (
    <div className="ix-shell">
      <div className="ix-error">Failed to load: {error}</div>
    </div>
  );

  const f = extractFields(data);
  const hashscanUrl = f.timestamp
    ? `${HASHSCAN_MAINNET}/transaction/${f.timestamp}`
    : null;

  return (
    <div className="ix-shell">
      <div className="ix-card">
        <div className="ix-card__header">
          <div className="ix-badge">Guardian Mainnet Indexer</div>
          {f.schema && <div className="ix-schema">{f.schema}</div>}
          <h1 className="ix-card__title">{f.name}</h1>
        </div>

        <div className="ix-card__body">
          {f.type && (
            <div className="ix-row">
              <span className="ix-label">Type</span>
              <span className="ix-value">{f.type}</span>
            </div>
          )}
          {f.methodology && (
            <div className="ix-row">
              <span className="ix-label">Methodology</span>
              <span className="ix-value">{f.methodology}</span>
            </div>
          )}
          {f.standard && (
            <div className="ix-row">
              <span className="ix-label">Standard</span>
              <span className="ix-value">{f.standard}</span>
            </div>
          )}
          {f.location && (
            <div className="ix-row">
              <span className="ix-label">Location</span>
              <span className="ix-value">{f.location}</span>
            </div>
          )}
          {f.sdgs.length > 0 && (
            <div className="ix-row">
              <span className="ix-label">SDGs</span>
              <span className="ix-value">{f.sdgs.join(' · ')}</span>
            </div>
          )}
          {f.timestamp && (
            <div className="ix-row">
              <span className="ix-label">Hedera ID</span>
              <span className="ix-value ix-mono">
                {hashscanUrl ? (
                  <a href={hashscanUrl} target="_blank" rel="noreferrer" className="ix-link">
                    {f.timestamp} ↗
                  </a>
                ) : f.timestamp}
              </span>
            </div>
          )}
          {f.description && (
            <div className="ix-desc">
              <span className="ix-label">Description</span>
              <p>{f.description}</p>
            </div>
          )}
        </div>

        <div className="ix-card__footer">
          <button className="ix-raw-toggle" onClick={() => setShowRaw(v => !v)}>
            {showRaw ? 'Hide raw JSON' : 'Show raw JSON'}
          </button>
          {showRaw && (
            <pre className="ix-raw">{JSON.stringify(data, null, 2)}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
