/**
 * test-cross-chain-audit.js
 * Run: node test-cross-chain-audit.js
 *
 * Tests the full cross-chain audit flow:
 *   1. recordCrossChainAudit() — HCS write + CLPR write (simulated or live)
 *   2. getAuditLogs()          — in-memory log query
 *   3. Multiple events + partial failure simulation
 */

import 'dotenv/config';
import { recordCrossChainAudit, getAuditLogs } from './plugins/crossChainAudit.js';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

function pass(label) { console.log(`${GREEN}  ✓ ${label}${RESET}`); }
function fail(label) { console.log(`${RED}  ✗ ${label}${RESET}`); }
function info(label) { console.log(`${CYAN}  ℹ ${label}${RESET}`); }
function section(label) { console.log(`\n${YELLOW}── ${label} ──${RESET}`); }

let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { pass(label); passed++; }
  else           { fail(label); failed++; }
}

// ── Config summary ─────────────────────────────────────────────────────────────

section('Config');
info(`HEDERA_NETWORK:    ${process.env.HEDERA_NETWORK     || 'testnet (default)'}`);
info(`HEDERA_ACCOUNT_ID: ${process.env.HEDERA_ACCOUNT_ID  || '(not set — HCS will simulate)'}`);
info(`AUDIT_TOPIC_ID:    ${process.env.AUDIT_TOPIC_ID     || '(not set — HCS will simulate)'}`);
info(`CLPR_SIMULATE:     ${process.env.CLPR_SIMULATE       || '(not set)'}`);
info(`CLPR_API_KEY:      ${process.env.CLPR_API_KEY        ? '(set)'  : '(not set — CLPR will simulate)'}`);
info(`CLPR_ENDPOINT_URL: ${process.env.CLPR_ENDPOINT_URL  || '(not set)'}`);

const clprSimulated = process.env.CLPR_SIMULATE === 'true' || !process.env.CLPR_API_KEY;
const hcsSimulated  = !process.env.AUDIT_TOPIC_ID;

if (hcsSimulated)  info('HCS mode:  SIMULATED (no AUDIT_TOPIC_ID)');
else               info('HCS mode:  LIVE (will write to Hedera)');
if (clprSimulated) info('CLPR mode: SIMULATED (no CLPR_API_KEY)');
else               info('CLPR mode: LIVE');

// ── Test 1: Basic audit record ─────────────────────────────────────────────────

section('Test 1: Basic recordCrossChainAudit()');

const result1 = await recordCrossChainAudit({
  eventType: 'TEST_EVENT',
  entityId:  'test-entity-001',
  actor:     'test-script',
  payload:   { campaignId: 999, action: 'test', timestamp: new Date().toISOString() },
  tags:      ['test', 'unit-test'],
});

console.log('\n  Raw result:', JSON.stringify(result1, null, 2).split('\n').map(l => '  ' + l).join('\n'));

assert(result1.auditId,              'auditId is present');
assert(result1.summary.integrityHash,'integrityHash (SHA-256) is present');
assert(result1.summary.integrityHash.length === 64, 'integrityHash is 64-char hex (SHA-256)');
assert(['recorded','partial','failed'].includes(result1.summary.status), `status is valid: ${result1.summary.status}`);
assert(result1.summary.eventType === 'TEST_EVENT', 'eventType matches');
assert(result1.summary.entityId  === 'test-entity-001', 'entityId matches');
assert(result1.summary.actor     === 'test-script', 'actor matches');
assert(result1.hcs  !== undefined, 'hcs result present');
assert(result1.clpr !== undefined, 'clpr result present');

if (clprSimulated) {
  assert(result1.clpr.simulated === true,           'CLPR marked as simulated');
  assert(result1.clpr.tx_hash?.startsWith('0xclpr_sim_'), 'CLPR sim hash has correct prefix');
  assert(result1.clpr.proofHash === result1.summary.integrityHash, 'CLPR proofHash == integrityHash');
}
if (hcsSimulated) {
  assert(result1.hcs.simulated === true,  'HCS marked as simulated');
  assert(result1.hcs.tx_hash?.startsWith('sim@'), 'HCS sim tx_hash has correct prefix');
} else {
  assert(!result1.hcs.error, `HCS live write succeeded (tx: ${result1.hcs.tx_hash})`);
}

// ── Test 2: Integrity hash is deterministic ────────────────────────────────────

section('Test 2: Integrity hash determinism');

const payload = { campaignId: 42, amount: 5, currency: 'HBAR' };

const r2a = await recordCrossChainAudit({ eventType: 'HASH_TEST', entityId: 'e1', actor: 'a1', payload });
const r2b = await recordCrossChainAudit({ eventType: 'HASH_TEST', entityId: 'e1', actor: 'a1', payload });

assert(r2a.summary.integrityHash === r2b.summary.integrityHash,
  'Same payload → same integrityHash (deterministic)');
assert(r2a.auditId !== r2b.auditId,
  'Different auditIds for each call (UUID, not deterministic)');

// ── Test 3: Simulated CLPR hash is deterministic ───────────────────────────────

if (clprSimulated) {
  section('Test 3: Simulated CLPR hash determinism');
  // CLPR sim hash includes auditId (which is random), so it won't be identical
  // but it should always start with the sim prefix
  assert(result1.clpr.tx_hash?.startsWith('0xclpr_sim_'), 'CLPR sim prefix consistent');
  info('Note: CLPR sim hash includes auditId so each call produces a unique hash (by design)');
}

// ── Test 4: Donation event types ──────────────────────────────────────────────

section('Test 4: DONATION_HBAR event');

const donationResult = await recordCrossChainAudit({
  eventType: 'DONATION_HBAR',
  entityId:  'campaign-113',
  actor:     '0.0.7314364',
  payload: {
    campaignId:  113,
    campaignName: 'Test Campaign 1',
    currency:    'HBAR',
    amount:      5,
    hbarAddress: '0.0.99999',
    txId:        '0.0.7314364-1234567890-000000000',
    txStatus:    'SUCCESS',
    timestamp:   new Date().toISOString(),
  },
  tags: ['hbar', 'campaign-113', 'donation'],
});

assert(donationResult.summary.status !== 'failed', `DONATION_HBAR audit status: ${donationResult.summary.status}`);
assert(donationResult.summary.tags.includes('hbar'),        'tag "hbar" present');
assert(donationResult.summary.tags.includes('campaign-113'),'tag "campaign-113" present');

// ── Test 5: getAuditLogs filtering ────────────────────────────────────────────

section('Test 5: getAuditLogs() filtering');

const allLogs = getAuditLogs();
assert(allLogs.length >= 3, `In-memory log has ${allLogs.length} entries (expected ≥ 3)`);

const testLogs = getAuditLogs({ eventType: 'TEST_EVENT' });
assert(testLogs.length === 1, `Filter by eventType=TEST_EVENT → ${testLogs.length} entry`);

const donationLogs = getAuditLogs({ eventType: 'DONATION_HBAR' });
assert(donationLogs.length === 1, `Filter by eventType=DONATION_HBAR → ${donationLogs.length} entry`);

const campaignLogs = getAuditLogs({ entityId: 'campaign-113' });
assert(campaignLogs.length === 1, `Filter by entityId=campaign-113 → ${campaignLogs.length} entry`);

const tagLogs = getAuditLogs({ tag: 'hbar' });
assert(tagLogs.length >= 1, `Filter by tag=hbar → ${tagLogs.length} entry`);

const noLogs = getAuditLogs({ eventType: 'NONEXISTENT' });
assert(noLogs.length === 0, 'Filter by unknown eventType → 0 entries');

// ── Test 6: Promise.allSettled — partial failure ───────────────────────────────

section('Test 6: Promise.allSettled partial failure resilience');

// Force a bad CLPR endpoint to trigger a partial failure
const origEndpoint = process.env.CLPR_ENDPOINT_URL;
const origSimulate = process.env.CLPR_SIMULATE;
const origApiKey   = process.env.CLPR_API_KEY;

process.env.CLPR_SIMULATE    = 'false';
process.env.CLPR_API_KEY     = 'fake-key';
process.env.CLPR_ENDPOINT_URL = 'https://invalid-clpr-endpoint.example.com';

const partialResult = await recordCrossChainAudit({
  eventType: 'PARTIAL_TEST',
  entityId:  'test-partial',
  actor:     'test-script',
  payload:   { test: true },
  tags:      ['partial-failure-test'],
});

// Restore env
process.env.CLPR_SIMULATE    = origSimulate ?? '';
process.env.CLPR_API_KEY     = origApiKey   ?? '';
process.env.CLPR_ENDPOINT_URL = origEndpoint ?? '';

assert(partialResult.clpr?.error !== undefined, 'CLPR failure captured in clpr.error');
assert(
  hcsSimulated
    ? partialResult.hcs.simulated === true
    : !partialResult.hcs.error,
  'HCS succeeded independently of CLPR failure'
);
assert(partialResult.summary.status === (hcsSimulated ? 'partial' : 'partial'),
  `Status is "partial" when one chain fails: ${partialResult.summary.status}`);

info(`CLPR error captured: "${partialResult.clpr.error}"`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`${GREEN}Passed: ${passed}${RESET}  ${failed > 0 ? RED : ''}Failed: ${failed}${RESET}`);
console.log('─'.repeat(50));

if (failed === 0) {
  console.log(`\n${GREEN}✓ All tests passed!${RESET}`);
  console.log('\nTo test with LIVE Hedera HCS, set in .env:');
  console.log('  AUDIT_TOPIC_ID=0.0.xxxxx');
  console.log('\nTo test with LIVE CLPR, set in .env:');
  console.log('  CLPR_ENDPOINT_URL=https://clpr-beta.hashgraph.com/v1');
  console.log('  CLPR_API_KEY=your-key');
  console.log('  CLPR_SIMULATE=false');
} else {
  process.exit(1);
}
