# Nature Backers Agent

Built with CarbonSustain

AI-guided campaign agent built on Hedera Agent Kit that helps sponsors, teams, venues, and event organizers turn women’s sports sponsorships into QR-based fan participation for verified nature and sustainability projects — with HCS records, HTS proof-of-participation, and HBAR proof for auditable campaign activity.

React frontend + Express SSE backend.

## Demo and App Links

- Demo video: Coming soon
- Live app: https://naturebackers-agent.web.app/
- Prior Apex prototype: https://github.com/CarbonSustain/nature-wired-apex

## Overview

Nature Backers Agent helps users design, approve, launch, and analyze participatory sustainability campaigns connected to live women’s sports events.

The agent guides a user from a blank-page campaign idea to a structured activation:

1. Create a campaign brief
2. Recommend a 3-project sustainability ballot
3. Generate aQR-based fan voting experience
4. Route campaign choices through human sponsor approval
5. Record campaign or participation activity using Hedera
6. Generate post-event sponsor reporting

## Hedera AI Bounty Focus

This submission is designed for the Week 2: Enterprise Agent + Plugin bounty.

It demonstrates:

- AI-guided campaign setup
- Custom Nature Backers campaign plugin
- Guardian Indexer project search
- Human-in-the-loop approval
- QR-based fan voting
- HCS campaign or participation records
- HTS proof-of-participation or sponsor engagement token activity
- HBAR proof for campaign commitment, approval, or milestone activity
- AI-assisted post-event reporting and PDF generation

## Example Use Case

A sports drink sponsor supports a women’s flag football event in San Francisco with 500 fans and a $5,000 sustainability pool.

Nature Backers Agent helps generate:

- campaign concept
- 3-project fan ballot
- QR code for fan participation
- voting mechanics
- funding allocation logic
- Hedera-based proof workflow
- sponsor report language

## Human-in-the-Loop Approval

The agent does not autonomously launch campaigns or move sponsor funds.

Sponsors review and approve project selections, campaign messaging, funding allocation logic, and Hedera transaction actions before execution.

## Hedera Integration

This prototype uses Hedera Agent Kit to support testnet-based agent actions.

Depending on the demo configuration, Hedera actions may include:

- HCS message submission for campaign approval or fan participation records
- HTS token activity for proof-of-participation or sponsor engagement tokens
- HBAR proof for sponsor commitment, campaign approval, or milestone-based activity
- Guardian Indexer API search or verified sustainability project metadata

## QR-Based Fan Voting Experience

The demo includes a QR-based fan participation flow:

1. Sponsor approves the campaign.
2. A QR code connects fans to the voting experience.
3. Fans review a curated 3-project ballot.
4. Fans vote for the nature or sustainability project they want to back.
5. Voting outcomes are used to calculate sponsor funding allocation.
6. Participation activity can be reflected in Hedera-based proof records.

## Local Development

### 1. Install dependencies

```bash
npm install
cd client && npm install && cd ..
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:
- `HEDERA_ACCOUNT_ID` / `HEDERA_PRIVATE_KEY` — testnet account from [portal.hedera.com](https://portal.hedera.com)
- `NATURE_BACKERS_TOKEN` — JWT from [indexer.guardianservice.app](https://indexer.guardianservice.app)
- `GOOGLE_API_KEY` — Gemini key from [aistudio.google.com](https://aistudio.google.com)

### 3. Start backend

```bash
npm run dev
```

Runs on `http://localhost:3001`

### 4. Start frontend

```bash
npm run dev:client
```

Runs on `http://localhost:5173`


## Stack

- **Agent**: [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit) + LangChain
- **Plugin**: `NatureBackersPlugin` — searches `GET /search` on the Guardian indexer
- **LLM**: Gemini 2.5 Flash Lite
- **Frontend**: React + Vite → Firebase Hosting
- **Backend**: Express SSE → Cloud Run

## Vision

Nature Backers explores how AI agents, participatory fan experiences, and Hedera infrastructure can transform sponsorship into transparent, community-driven sustainability engagement.