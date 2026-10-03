/**
 * Network diagnostics: answer *why* a resolve failed, in one log line.
 *
 * Background (see docs/MOVIEBOX-TUI-COMPARISON.md): the reference client
 * (MovieBox-TUI, MIT OR Apache-2.0) does not just fire requests and hope. It pins a
 * DNS resolver that fails over to public resolvers (hickory + Cloudflare /
 * Google / Quad9) and it treats "all hosts exhausted" as a *network* verdict
 * it can act on. vu-movie used to report the same six `fetch failed` lines and
 * then guess at JA3/TLS fingerprinting — which is one of at least four very
 * different failure modes with four different fixes:
 *
 *   1. DNS      — the hostname resolves to nothing, or to a filtered address
 *                 (ISP / Pi-hole / Synology DNS Server / ControlD blocklist).
 *   2. TCP      — connects, then nothing (firewall drop, dead CDN edge).
 *   3. TLS      — TCP connects, then the peer closes during the handshake
 *                 (SNI/IP-level blocking, JA3 fingerprint, transparent proxy).
 *   4. HTTP     — a real response, but a status/body we cannot use.
 *
 * This module separates those. All functions are side-effect free apart from
 * the probes themselves and every one of them has a hard timeout, because a
 * diagnostic that hangs is worse than no diagnostic.
 */
import dns from 'node:dns/promises';
import { request } from './http.js';
import { getConfig } from '../core/config.js';
import { log } from '../core/log.js';

/** Resolvers to compare against, from `/config` when the operator changed them. */
function configuredResolvers(fallback = PUBLIC_RESOLVERS) {
  const configured = getConfig?.().scraper?.dnsCheckServers;
  return Array.isArray(configured) && configured.length ? configured : fallback;
}

/** Public resolvers used for the cross-check (same families the reference client pins). */
export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

/**
 * Control endpoints for "does this container have general internet access?".
 * They are deliberately boring, fast and unlikely to be blocked anywhere.
 */
export const CONTROL_URLS = [
  'https://api.github.com/zen',
  'https://www.google.com/generate_204',
];

/** Resolve a hostname through one specific DNS server, with a hard timeout. */
export async function resolveVia(hostname, server, { timeoutMs = 4000 } = {}) {
  const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
  if (server) resolver.setServers([server]);
  const [a, aaaa] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
  const addresses = [
    ...(a.status === 'fulfilled' ? a.value : []),
    ...(aaaa.status === 'fulfilled' ? aaaa.value : []),
  ];
  return { server: server || 'system', addresses, ok: addresses.length > 0 };
}

/**
 * Compare what the container's own resolver says with what public resolvers
 * say. A mismatch is the classic signature of DNS-level filtering — and the
 * exact case the reference client's built-in resolver exists to survive.
 */
export async function dnsCrossCheck(hostname, { servers = configuredResolvers(), timeoutMs = 4000 } = {}) {
  const system = await resolveVia(hostname, null, { timeoutMs }).catch((err) => ({ server: 'system', addresses: [], ok: false, error: String(err?.message || err) }));
  const publics = await Promise.all(servers.map((server) => resolveVia(hostname, server, { timeoutMs })
    .catch((err) => ({ server, addresses: [], ok: false, error: String(err?.message || err) }))));
  const informative = publics.filter((p) => p.ok);
  const systemSet = new Set(system.addresses);
  const publicSet = new Set(informative.flatMap((p) => p.addresses));
  let verdict = 'unknown';
  if (!system.ok && !publicSet.size) verdict = 'dns-dead';
  else if (!system.ok && publicSet.size) verdict = 'system-dns-broken';
  else if (system.ok && publicSet.size && ![...systemSet].some((ip) => publicSet.has(ip))) verdict = 'dns-diverged';
  else if (system.ok && publicSet.size) verdict = 'dns-consistent';
  else if (system.ok && !publicSet.size) verdict = 'public-dns-unreachable';
  return { hostname, system, publics, verdict };
}

/** One-line, human-readable DNS verdict. */
export function describeDnsCheck(check) {
  if (!check) return 'DNS check unavailable';
  const sys = check.system?.addresses?.length ? check.system.addresses.join(',') : `unresolved${check.system?.error ? ` (${check.system.error})` : ''}`;
  const pub = check.publics?.filter((p) => p.ok).map((p) => `${p.server}: ${p.addresses.join(',')}`).join('; ') || 'no public resolver answered';
  switch (check.verdict) {
    case 'dns-dead':
      return `${check.hostname} does not resolve anywhere (system: ${sys}; ${pub}) — DNS/blocklist problem, not a MovieBox bug`;
    case 'system-dns-broken':
      return `${check.hostname} resolves via public DNS but not via this container's resolver (${pub}) — the container's DNS is filtering this host`;
    case 'dns-diverged':
      return `${check.hostname} resolves to different addresses on this container's resolver (${sys}) vs public DNS (${pub}) — DNS-level filtering or a stale cache`;
    case 'dns-consistent':
      return `${check.hostname} resolves the same everywhere (${sys}) — DNS is not the problem`;
    case 'public-dns-unreachable':
      return `${check.hostname} resolves to ${sys} locally, but no public resolver (${PUBLIC_RESOLVERS.join(', ')}) answered — outbound DNS port 53 may be blocked`;
    default:
      return `${check.hostname}: DNS state unclear (system: ${sys}; ${pub})`;
  }
}

/**
 * True when the failure is a certificate problem rather than a dead network:
 * a transparent proxy / antivirus / ISP box is re-signing TLS and Node does not
 * trust its CA (Node ships its own CA bundle and ignores the system store).
 */
export function isTlsInterceptionError(message = '') {
  return /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|unable to verify the first certificate|self.signed certificate/i.test(String(message));
}

/** Probe a list of URLs; `ok` means "we got an HTTP response", not "the page is what we want". */
export async function probeEgress({ urls = CONTROL_URLS, timeoutMs = 5000, signal = null } = {}) {
  const results = await Promise.all(urls.map(async (url) => {
    const started = Date.now();
    try {
      const res = await request(url, { method: 'GET', timeoutMs, retries: 0, as: 'text', allowFailure: true, signal });
      return { url, ok: true, intercepted: false, status: res.status, ms: Date.now() - started };
    } catch (err) {
      const message = String(err?.cause?.message || err?.message || err).slice(0, 160);
      return { url, ok: false, intercepted: isTlsInterceptionError(message), ms: Date.now() - started, error: message };
    }
  }));
  const reachable = results.filter((r) => r.ok);
  const intercepted = results.filter((r) => r.intercepted);
  return {
    ok: reachable.length > 0,
    intercepted: intercepted.length > 0 && reachable.length === 0,
    results,
    summary: results.map((r) => `${new URL(r.url).host} ${r.ok
      ? `HTTP ${r.status}`
      : r.intercepted ? `TLS interrupted by a proxy (${r.error})` : `unreachable (${r.error})`}`).join(' · '),
  };
}

let cachedDiagnosis = null;
let cachedAt = 0;

/**
 * Full verdict for a failed resolve. Cached for `ttlMs` (default 60 s) because
 * a search fans out over several sources and we do not want six identical
 * probe rounds hammering the network.
 */
export async function diagnoseReachability({
  hosts = [], sourceUrl = null, ttlMs = 60_000, signal = null, force = false,
} = {}) {
  if (getConfig?.().scraper?.diagnoseOnFailure === false) return null;
  if (!force && cachedDiagnosis && Date.now() - cachedAt < ttlMs) return cachedDiagnosis;
  const hostnames = hosts
    .map((h) => { try { return new URL(h).hostname; } catch { return String(h).replace(/^https?:\/\//, '').split('/')[0]; } })
    .filter(Boolean);
  const unique = [...new Set(hostnames)];
  const [dnsChecks, egress] = await Promise.all([
    Promise.all(unique.slice(0, 3).map((h) => dnsCrossCheck(h).catch(() => null))),
    probeEgress({ signal }).catch((err) => ({ ok: false, results: [], summary: `probe failed: ${err?.message || err}` })),
  ]);

  const dns = dnsChecks.filter(Boolean);
  const egressOk = egress.ok;
  const dnsKinds = new Set(dns.map((d) => d.verdict));
  let verdict = 'service-unreachable';
  let hint = 'The API/CDN edge refused the connection — it may be down, geo-blocked, or the host is filtered on this network.';

  if (egress.intercepted) {
    verdict = 'tls-intercepted';
    hint = 'TLS is being intercepted on this network (the control hosts present a certificate Node does not trust) — a proxy/antivirus/gateway is terminating TLS. Install its CA via NODE_EXTRA_CA_CERTS or stop proxying this container; until then every HTTPS scrape looks like a connection failure.';
  } else if (!egressOk) {
    verdict = 'no-egress';
    hint = 'This container has no general internet access either (control hosts are unreachable), so nothing can be scraped until the container gets egress (Docker network/DNS/firewall/proxy).';
  } else if (dnsKinds.has('dns-dead') || dnsKinds.has('system-dns-broken') || dnsKinds.has('dns-diverged')) {
    verdict = 'dns-filtered';
    hint = 'General internet works, but DNS for the failing host looks filtered or stale. Point the container at public DNS (or the resolver setting below) and retry.';
  } else if (egressOk && dnsKinds.has('dns-consistent')) {
    verdict = 'tls-or-ip-block';
    const proxyHint = (() => {
      try {
        const cfg = getConfig?.();
        if (cfg?.scraper?.proxyUrl) return ' (proxy already configured — check that it can reach aoneroom.com)';
        return '';
      } catch { return ''; }
    })();
    const envProxy = process.env.MOVIEBOX_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy ? ' (proxy already configured via env — check that it can reach aoneroom.com)' : '';
    const proxyNote = proxyHint || envProxy || ' — fastest fix: set MOVIEBOX_PROXY or HTTP_PROXY to a proxy/VPN outside the blocking ISP (e.g. http://proxy:3128), or leave MOVIEBOX_BROWSER_FALLBACK=true (default) to retry via Chromium BoringSSL which has a different JA3 fingerprint.';
    hint = `DNS resolves correctly and the container has internet, yet the host closes the TLS handshake. That is SNI/IP-level blocking (ISP, firewall, or a transparent proxy) rather than a bug in the scraper${proxyNote}`;
  }

  const summary = [egress.summary, ...dns.map(describeDnsCheck)].filter(Boolean).join(' | ');
  const result = { verdict, hint, summary, egress, dns, checkedAt: new Date().toISOString() };
  cachedDiagnosis = result;
  cachedAt = Date.now();
  log.info('diagnostics', `reachability verdict: ${verdict}`, { summary, sourceUrl: sourceUrl || undefined });
  return result;
}

/** Test/ops helper. */
export function resetDiagnosticsCache() {
  cachedDiagnosis = null;
  cachedAt = 0;
}

export default { PUBLIC_RESOLVERS, CONTROL_URLS, resolveVia, dnsCrossCheck, describeDnsCheck, probeEgress, diagnoseReachability, resetDiagnosticsCache };
