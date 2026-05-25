# CarbonSustain — NatureBackers Agent

AI agent built on Hedera Agent Kit that searches the NatureBackers environmental project registry. React frontend + Express SSE backend.

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
