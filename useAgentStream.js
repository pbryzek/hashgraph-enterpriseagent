// useAgentStream.js
import { useCallback, useState } from 'react';
import { useHashPack } from './useHashPack';

export function useAgentStream() {
  const { sendHbar } = useHashPack();
  const [output, setOutput]           = useState('');
  const [status, setStatus]           = useState('');
  const [pendingPayment, setPending]  = useState(null);
  const [loading, setLoading]         = useState(false);

  const invoke = useCallback(async (message, chatHistory = [], phase = 'research') => {
    setLoading(true);
    setOutput('');
    setPending(null);

    const res = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, chatHistory, phase }),
    });

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));

        switch (event.type) {
          case 'status':
          case 'tool_start':
          case 'tool_end':
          case 'llm_start':
            setStatus(event.step);
            break;

          case 'hashpack_payment':
            // Pause here — surface to UI for user confirmation
            setPending(event.payment);
            setLoading(false);
            return; // stop reading; UI takes over

          case 'done':
            setOutput(event.output);
            setLoading(false);
            break;

          case 'error':
            setOutput(`Error: ${event.error}`);
            setLoading(false);
            break;
        }
      }
    }
  }, []);

  // Called by the confirm button in UI
  const confirmPayment = useCallback(async () => {
    if (!pendingPayment) return;
    const { amount, toAccount, campaignName } = pendingPayment;

    setStatus('Waiting for HashPack signature…');
    setPending(null);
    setLoading(true);

    try {
      const result = await sendHbar(amount, toAccount);
      setOutput(`:white_check_mark: Donated ${amount} HBAR to ${campaignName}\nTx: ${result.transactionId.toString()}`);
    } catch (e) {
      setOutput(`:x: Donation failed: ${e.message}`);
    } finally {
      setLoading(false);
      setStatus('');
    }
  }, [pendingPayment, sendHbar]);

  const cancelPayment = useCallback(() => {
    setPending(null);
    setOutput('Donation cancelled.');
    setLoading(false);
  }, []);

  return { invoke, output, status, loading, pendingPayment, confirmPayment, cancelPayment };
}