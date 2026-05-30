import { useState, useEffect, useCallback, useRef } from 'react';

const API_BASE      = import.meta.env.VITE_API_URL || '';
const ENV_ADMIN     = import.meta.env.VITE_ADMIN_ACCOUNT_ID || null;
const ENV_NETWORK   = import.meta.env.VITE_HEDERA_NETWORK   || 'testnet';
const WC_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

const APP_METADATA = {
  name:        'CarbonSustain',
  description: 'Nature Backers — donate HBAR to conservation campaigns',
  url:         typeof window !== 'undefined' ? window.location.origin : '',
  icons:       [],
};

export function useHashPack() {
  const [accountId, setAccountId]     = useState(null);
  const [adminAccountId, setAdmin]    = useState(ENV_ADMIN);
  const [ready, setReady]             = useState(false);
  const [isConnecting, setConnecting] = useState(false);
  const [error, setError]             = useState(null);
  const connectorRef = useRef(null);

  // Fetch admin account from backend only if env not set
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

        const connector = new DAppConnector(
          APP_METADATA,
          network,
          WC_PROJECT_ID,
          undefined,  // methods — use defaults
          undefined,  // events  — use defaults
          [chain],
        );

        connectorRef.current = connector;
        await connector.init({ logger: 'error' });

        // Restore existing session if present
        if (connector.signers.length > 0) {
          const id = connector.signers[0].getAccountId().toString();
          setAccountId(id);
        }

        setReady(true);
      } catch (e) {
        console.error('DAppConnector init error:', e);
        setError(e.message);
      }
    })();
  }, []);

  const connect = useCallback(async () => {
    if (!connectorRef.current) {
      setError('Still initializing — please wait.');
      return;
    }
    setError(null);
    setConnecting(true);
    try {
      // openModal() shows WalletConnect QR + HashPack extension option
      const session = await connectorRef.current.openModal();
      const accounts = session?.namespaces?.hedera?.accounts ?? [];
      if (accounts.length > 0) {
        // account format: "hedera:testnet:0.0.xxxxxx"
        const id = accounts[0].split(':').pop();
        setAccountId(id);
      } else if (connectorRef.current.signers.length > 0) {
        const id = connectorRef.current.signers[0].getAccountId().toString();
        setAccountId(id);
      }
    } catch (e) {
      if (!e.message?.includes('rejected')) setError(e.message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!connectorRef.current) return;
    try { await connectorRef.current.disconnectAll(); } catch { /* ignore */ }
    setAccountId(null);
  }, []);

  const sendHbar = useCallback(async (amountHbar, toAccountOverride) => {
    if (!connectorRef.current || !accountId) throw new Error('Wallet not connected');
    const recipient = toAccountOverride ?? adminAccountId;
    if (!recipient) throw new Error('Recipient account not configured');

    const { TransferTransaction, Hbar, AccountId } = await import('@hashgraph/sdk');

    const fromId  = AccountId.fromString(accountId);
    const toId    = AccountId.fromString(recipient);
    const signer  = connectorRef.current.getSigner(fromId);

    const tx = await new TransferTransaction()
      .addHbarTransfer(fromId, new Hbar(-amountHbar))
      .addHbarTransfer(toId,   new Hbar(amountHbar))
      .freezeWithSigner(signer);

    return tx.executeWithSigner(signer);
  }, [accountId, adminAccountId]);

  return { accountId, adminAccountId, ready, isConnecting, error, connect, disconnect, sendHbar };
}
