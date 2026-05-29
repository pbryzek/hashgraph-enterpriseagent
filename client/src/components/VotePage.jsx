import { useState, useEffect } from 'react';
import './VotePage.css';

const API_BASE = import.meta.env.VITE_API_URL || '';

export default function VotePage({ campaignId }) {
  const [campaign, setCampaign]   = useState(null);
  const [projects, setProjects]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  const [selectedProject, setSelectedProject] = useState(null);
  const [email, setEmail]         = useState('');
  const [reason, setReason]       = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [voteResult, setVoteResult] = useState(null);
  const [voteError, setVoteError]  = useState(null);

  useEffect(() => {
    async function fetchCampaign() {
      try {
        const res  = await fetch(`${API_BASE}/api/campaigns/${campaignId}`);
        if (!res.ok) throw new Error(`Failed to load campaign (${res.status})`);
        const json = await res.json();
        const c    = json?.data ?? json;
        setCampaign(c);

        // Fetch each assigned project individually — mirrors the NatureBackers voting flow
        const projectIds = (c?.CampaignProject ?? []).map(cp => cp.projectId);
        if (projectIds.length === 0) { setLoading(false); return; }

        const settled = await Promise.allSettled(
          projectIds.map(id =>
            fetch(`${API_BASE}/api/projects/${id}`)
              .then(r => r.ok ? r.json() : Promise.reject(r.status))
              .then(j => j?.data ?? j)
          )
        );

        setProjects(
          settled
            .filter(r => r.status === 'fulfilled' && r.value)
            .map(r => ({
              id:   r.value.id,
              name: r.value.projectName ?? `Project ${r.value.id}`,
              type: r.value.projectTypes ?? null,
              desc: r.value.projectMethodology ?? null,
            }))
        );
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchCampaign();
  }, [campaignId]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!selectedProject || !email.trim()) return;

    setSubmitting(true);
    setVoteError(null);

    try {
      const res = await fetch(`${API_BASE}/api/vote`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email:      email.trim(),
          campaignId: Number(campaignId),
          projectId:  Number(selectedProject),
          reason:     reason.trim() || undefined,
        }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `Error ${res.status}`);
      setVoteResult(json?.data ?? json);
    } catch (err) {
      setVoteError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="vote-page">
        <div className="vote-loading">
          <div className="vote-spinner" />
          <p>Loading campaign…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="vote-page">
        <div className="vote-error-state">
          <span className="vote-error-icon">⚠️</span>
          <h2>Could not load campaign</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const status     = campaign?.campaignStatus?.name ?? 'Unknown';
  const statusId   = campaign?.campaignStatusId;
  const isActive   = statusId === 2;
  const endDate    = campaign?.endDate ? new Date(campaign.endDate).toLocaleString() : null;
  const startDate  = campaign?.startDate ? new Date(campaign.startDate).toLocaleString() : null;

  // ── Success ─────────────────────────────────────────────────────────────────
  if (voteResult) {
    const voted = projects.find(p => p.id === Number(selectedProject));
    return (
      <div className="vote-page">
        <div className="vote-success">
          <div className="vote-success__icon">🌿</div>
          <h1>Vote Recorded!</h1>
          <p className="vote-success__sub">
            Thank you for supporting <strong>{voted?.name ?? 'the project'}</strong>.
          </p>
          <p className="vote-success__campaign">
            Campaign: <strong>{campaign?.name}</strong>
          </p>
          {reason && (
            <p className="vote-success__reason">Your reason: "{reason}"</p>
          )}
          <p className="vote-success__note">
            Your vote will be pushed to the Hedera blockchain when the campaign is approved.
          </p>
          <a href="/" className="vote-back-btn">← Back to CarbonSustain Agent</a>
        </div>
      </div>
    );
  }

  return (
    <div className="vote-page">
      <header className="vote-header">
        <span className="vote-logo">🌿</span>
        <div>
          <h1 className="vote-title">{campaign?.name ?? `Campaign #${campaignId}`}</h1>
          <p className="vote-subtitle">Nature Backers — Powered by Hedera</p>
        </div>
      </header>

      <div className="vote-meta">
        <span className={`vote-status vote-status--${isActive ? 'active' : 'inactive'}`}>
          {status}
        </span>
        {startDate && <span className="vote-date">Opens: {startDate}</span>}
        {endDate   && <span className="vote-date">Closes: {endDate}</span>}
      </div>

      {!isActive && (
        <div className="vote-inactive-banner">
          {statusId === 1 && '⏳ This campaign has not started yet. Please check back later.'}
          {statusId === 3 && '✅ Voting has ended. Results are being finalized.'}
          {statusId === 4 && '❌ This campaign was rejected.'}
          {statusId === 5 && '✅ This campaign is approved. Results are on Hedera.'}
          {statusId === 6 && '🚫 This campaign was cancelled.'}
          {!statusId     && '🔒 Voting is not currently open for this campaign.'}
        </div>
      )}

      {isActive && (
        <form className="vote-form" onSubmit={handleSubmit}>
          <section className="vote-section">
            <h2 className="vote-section__title">Select a Project to Support</h2>
            <div className="vote-projects">
              {projects.length === 0 && (
                <p className="vote-no-projects">No projects assigned to this campaign yet.</p>
              )}
              {projects.map(p => (
                <label
                  key={p.id}
                  className={`vote-project-card ${selectedProject === p.id ? 'vote-project-card--selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="project"
                    value={p.id}
                    checked={selectedProject === p.id}
                    onChange={() => setSelectedProject(p.id)}
                    className="vote-project-radio"
                  />
                  <div className="vote-project-info">
                    <span className="vote-project-name">{p.name}</span>
                    {p.type && <span className="vote-project-type">{p.type}</span>}
                    {p.desc && <span className="vote-project-desc">{p.desc}</span>}
                  </div>
                  {selectedProject === p.id && <span className="vote-project-check">✓</span>}
                </label>
              ))}
            </div>
          </section>

          <section className="vote-section">
            <h2 className="vote-section__title">Your Details</h2>
            <label className="vote-label">
              Work Email *
              <input
                type="email"
                className="vote-input"
                placeholder="you@company.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="vote-label">
              Why do you support this project? (optional)
              <textarea
                className="vote-textarea"
                rows={3}
                placeholder="Share your reason…"
                maxLength={500}
                value={reason}
                onChange={e => setReason(e.target.value)}
              />
              <span className="vote-char-count">{reason.length}/500</span>
            </label>
          </section>

          {voteError && (
            <div className="vote-submit-error">
              <strong>Error:</strong> {voteError}
            </div>
          )}

          <button
            type="submit"
            className="vote-submit-btn"
            disabled={!selectedProject || !email.trim() || submitting}
          >
            {submitting ? 'Submitting…' : 'Cast My Vote 🌿'}
          </button>

          <p className="vote-disclaimer">
            Each employee may vote once per campaign. Your vote is recorded on the Hedera blockchain.
          </p>
        </form>
      )}
    </div>
  );
}
