import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

const API_BASE      = import.meta.env.VITE_API_URL || '';
const ENV_ADMIN     = import.meta.env.VITE_ADMIN_ACCOUNT_ID || null;
const ENV_NETWORK   = import.meta.env.VITE_HEDERA_NETWORK   || 'testnet';
const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';
export const USDC_TOKEN_ID = import.meta.env.VITE_USDC_TOKEN_ID || '0.0.456858'; // Testnet USDC

const APP_METADATA = {
  name:        'CarbonSustain',
  description: 'Nature Backers — donate HBAR to conservation campaigns',
  url:         typeof window !== 'undefined' ? window.location.origin : '',
  icons:       [],
};

const HashPackContext = createContext(null);

export function HashPackProvider({ children }) {
  const [accountId, setAccountId]     = useState(null);
  const [adminAccountId, setAdmin]    = useState(ENV_ADMIN);
  const [ready, setReady]             = useState(false);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError]             = useState(null);
  const connectorRef = useRef(null);

  useEffect(() => {
    if (ENV_ADMIN) return;
    fetch(`${API_BASE}/api/config`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(({ adminAccountId: aid }) => { if (aid) setAdmin(aid); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!WC_PROJECT_ID) {
      setError('VITE_WALLETCONNECT_PROJECT_ID not set');
      return;
    }
    (async () => {
      try {
        const { DAppConnector, HederaChainId } = await import('@hashgraph/hedera-wallet-connect');
        const { LedgerId } = await import('@hashgraph/sdk');

        const network = ENV_NETWORK === 'mainnet' ? LedgerId.MAINNET : LedgerId.TESTNET;
        const chain   = ENV_NETWORK === 'mainnet' ? HederaChainId.Mainnet : HederaChainId.Testnet;

        const connector = new DAppConnector(APP_METADATA, network, WC_PROJECT_ID, undefined, undefined, [chain]);
        connectorRef.current = connector;
        await connector.init({ logger: 'error' });

        if (connector.signers.length > 0) {
          setAccountId(connector.signers[0].getAccountId().toString());
        }
        setReady(true);
      } catch (e) {
        console.error('DAppConnector init error:', e);
        setError(e.message);
      }
    })();
  }, []);

  const connect = useCallback(async () => {
    if (!connectorRef.current) { setError('Still initializing.'); return; }
    setError(null);
    setConnecting(true);
    try {
      const session  = await connectorRef.current.openModal();
      const accounts = session?.namespaces?.hedera?.accounts ?? [];
      const id = accounts.length > 0
        ? accounts[0].split(':').pop()
        : connectorRef.current.signers[0]?.getAccountId().toString();
      if (id) setAccountId(id);
    } catch (e) {
      if (!e.message?.includes('rejected')) setError(e.message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try { await connectorRef.current?.disconnectAll(); } catch { /* ignore */ }
    setAccountId(null);
  }, []);

  const sendHbar = useCallback(async (amountHbar, toAccountOverride, onTxId) => {
    console.log("[HashPackContext] sendHbar called:", { amountHbar, toAccountOverride });
    if (!connectorRef.current || !accountId) throw new Error('Wallet not connected');
    const recipient = toAccountOverride ?? adminAccountId;
    if (!recipient) throw new Error('Recipient account not configured');

    const { TransferTransaction, Hbar, AccountId } = await import('@hashgraph/sdk');

    const fromId = AccountId.fromString(accountId);
    const toId   = AccountId.fromString(recipient);

    const signers = connectorRef.current.signers;
    if (!signers || signers.length === 0) {
      throw new Error('No active signer — wallet may need to reconnect');
    }

    const signer = signers.find(s => s.getAccountId().toString() === accountId);
    if (!signer) throw new Error(`No signer found for account ${accountId}`);

    console.log("[HashPackContext] Preparing transaction...");

    const tx = new TransferTransaction()
      .addHbarTransfer(fromId, new Hbar(-amountHbar))
      .addHbarTransfer(toId,   new Hbar(amountHbar))
      .setTransactionMemo(`NatureBackers donation: ${amountHbar} HBAR`)
      .setMaxTransactionFee(new Hbar(1));

    // HashPack's WalletConnect signer handles freeze/sign/execute as one atomic
    // RPC call — it doesn't expose node IDs client-side, so freezeWithSigner
    // fails. We get the real txId from the response after execute instead.
    console.log("[HashPackContext] Calling tx.executeWithSigner(signer)...");
    const response = await tx.executeWithSigner(signer);
    console.log("[HashPackContext] Transaction response received:", response);
    return response;
  }, [accountId, adminAccountId]);

  // USDC (HTS token) transfer — 6 decimal places (1 USDC = 1_000_000 tinycents)
  const sendUsdc = useCallback(async (amountUsdc, toAccountOverride) => {
    console.log("[HashPackContext] sendUsdc called:", { amountUsdc, toAccountOverride });
    if (!connectorRef.current || !accountId) throw new Error('Wallet not connected');
    const recipient = toAccountOverride ?? adminAccountId;
    if (!recipient) throw new Error('Recipient account not configured');

    const { TransferTransaction, Hbar, AccountId, TokenId } = await import('@hashgraph/sdk');

    const fromId    = AccountId.fromString(accountId);
    const toId      = AccountId.fromString(recipient);
    const tokenId   = TokenId.fromString(USDC_TOKEN_ID);
    const tinycents = Math.round(amountUsdc * 1_000_000);

    const signers = connectorRef.current.signers;
    if (!signers || signers.length === 0) throw new Error('No active signer — wallet may need to reconnect');
    const signer = signers.find(s => s.getAccountId().toString() === accountId);
    if (!signer) throw new Error(`No signer found for account ${accountId}`);

    console.log("[HashPackContext] Preparing USDC token transfer...");

    const tx = new TransferTransaction()
      .addTokenTransfer(tokenId, fromId, -tinycents)
      .addTokenTransfer(tokenId, toId,    tinycents)
      .setTransactionMemo(`NatureBackers USDC donation: ${amountUsdc} USDC`)
      .setMaxTransactionFee(new Hbar(2));

    console.log("[HashPackContext] Calling tx.executeWithSigner(signer) for USDC...");
    const response = await tx.executeWithSigner(signer);
    console.log("[HashPackContext] USDC transaction response received:", response);
    return response;
  }, [accountId, adminAccountId]);

  return (
    <HashPackContext.Provider value={{ accountId, adminAccountId, ready, isConnecting, error, connect, disconnect, sendHbar, sendUsdc }}>
      {children}
    </HashPackContext.Provider>
  );
}

export function useHashPack() {
  const ctx = useContext(HashPackContext);
  if (!ctx) throw new Error('useHashPack must be used inside <HashPackProvider>');
  return ctx;
}
