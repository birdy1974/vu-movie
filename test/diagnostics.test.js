/**
 * Reachability diagnostics: the pure verdict/description logic.
 *
 * These are the strings the operator sees when a resolve fails, so they are
 * part of the product, not debug output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeDnsCheck, isTlsInterceptionError, PUBLIC_RESOLVERS, CONTROL_URLS,
} from '../src/scrapers/diagnostics.js';

test('DNS verdicts name the right culprit', () => {
  const base = { hostname: 'api6.aoneroom.com' };
  const consistent = describeDnsCheck({ ...base, system: { addresses: ['8.8.8.8'] }, publics: [{ server: '1.1.1.1', addresses: ['8.8.8.8'], ok: true }], verdict: 'dns-consistent' });
  assert.match(consistent, /resolves the same everywhere/);
  assert.match(consistent, /DNS is not the problem/);

  const diverged = describeDnsCheck({ ...base, system: { addresses: ['10.0.0.1'] }, publics: [{ server: '1.1.1.1', addresses: ['8.8.8.8'], ok: true }], verdict: 'dns-diverged' });
  assert.match(diverged, /different addresses/);
  assert.match(diverged, /DNS-level filtering/);

  const dead = describeDnsCheck({ ...base, system: { addresses: [] }, publics: [], verdict: 'dns-dead' });
  assert.match(dead, /does not resolve anywhere/);

  const brokenSystem = describeDnsCheck({ ...base, system: { addresses: [], error: 'EAI_AGAIN' }, publics: [{ server: '1.1.1.1', addresses: ['8.8.8.8'], ok: true }], verdict: 'system-dns-broken' });
  assert.match(brokenSystem, /resolves via public DNS but not via this container's resolver/);

  const noPublic = describeDnsCheck({ ...base, system: { addresses: ['8.8.8.8'] }, publics: [], verdict: 'public-dns-unreachable' });
  assert.match(noPublic, /port 53 may be blocked/);

  assert.equal(describeDnsCheck(null), 'DNS check unavailable');
});

test('TLS interception (a re-signing proxy) is distinguished from a dead network', () => {
  assert.equal(isTlsInterceptionError('unable to verify the first certificate'), true);
  assert.equal(isTlsInterceptionError('Error [UNABLE_TO_VERIFY_LEAF_SIGNATURE]: …'), true);
  assert.equal(isTlsInterceptionError('Client network socket disconnected before secure TLS connection was established'), false);
  assert.equal(isTlsInterceptionError('getaddrinfo ENOTFOUND api6.aoneroom.com'), false);
});

test('control hosts and resolvers are sane defaults', () => {
  assert.ok(PUBLIC_RESOLVERS.length >= 2);
  assert.ok(CONTROL_URLS.every((u) => /^https:\/\//.test(u)));
  // The control hosts must not be the thing we are diagnosing.
  assert.ok(!CONTROL_URLS.some((u) => u.includes('aoneroom')));
});
