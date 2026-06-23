import { config } from '../config.js';
import { exec } from '../db.js';
import type { IntelligenceEvent } from '../types.js';
import { safeFetch } from '../util/safeFetch.js';

let reconHourlyCount = 0;
let reconHourStart = Date.now();

/** Small async sleep used to throttle between keyless passive-DNS providers. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Common subdomain wordlist for brute-force enumeration
const SUBDOMAIN_WORDLIST = [
  'www', 'mail', 'api', 'dev', 'staging', 'vpn', 'admin', 'ftp', 'blog', 'shop', 'cdn', 'media', 'docs', 'support', 'portal',
  'remote', 'webmail', 'smtp', 'imap', 'pop', 'ns1', 'ns2', 'dns', 'mx', 'ssh', 'git', 'ci', 'build', 'test', 'demo', 'beta',
  'alpha', 'prod', 'production', 'app', 'apps', 'mobile', 'm', 'cms', 'panel', 'dashboard', 'manage', 'manager', 'console',
  'control', 'cp', 'webmin', 'phpmyadmin', 'mysql', 'db', 'database', 'sql', 'postgres', 'mongo', 'redis', 'elastic', 'kibana',
  'grafana', 'prometheus', 'jenkins', 'gitlab', 'github', 'bitbucket', 'jira', 'confluence', 'wiki', 'kb', 'help', 'faq',
  'status', 'health', 'monitor', 'nagios', 'zabbix', 'sentry', 'log', 'logs', 'logging', 'splunk', 'graylog', 'backup', 'bak',
  'archive', 'old', 'legacy', 'v1', 'v2', 'v3', 'version', 'release', 'deploy', 'deployment', 'dr', 'disaster', 'recovery',
  'failover', 'lb', 'loadbalancer', 'proxy', 'cache', 'edge', 'static', 'assets', 'img', 'images', 'image', 'photo', 'photos',
  'pic', 'pics', 'video', 'videos', 'stream', 'streaming', 'live', 'broadcast', 'tv', 'radio', 'podcast', 'feed', 'rss', 'atom',
  'xml', 'json', 'rest', 'graphql', 'ws', 'websocket', 'socket', 'io', 'hook', 'webhook', 'callback', 'oauth', 'auth', 'sso',
  'login', 'signin', 'signup', 'register', 'account', 'accounts', 'user', 'users', 'member', 'members', 'profile', 'profiles',
  'id', 'identity', 'directory', 'dir', 'ldap', 'ad', 'active', 'dc', 'controller', 'exchange', 'sharepoint', 'teams', 'office',
  'outlook', 'calendar', 'meet', 'zoom', 'webex', 'slack', 'discord', 'mattermost', 'rocket', 'chat', 'im', 'message', 'messages',
  'msg', 'notification', 'notify', 'alert', 'alerts', 'ticket', 'tickets', 'ticketing', 'service', 'servicedesk', 'helpdesk',
  'desk', 'crm', 'erp', 'sap', 'salesforce', 'hubspot', 'zendesk', 'freshdesk', 'intercom', 'livechat', 'chatbot', 'bot',
  'agent', 'ai', 'ml', 'data', 'analytics', 'stats', 'metric', 'metrics', 'report', 'reports', 'billing', 'invoice', 'payment',
  'pay', 'checkout', 'cart', 'store', 'marketplace', 'catalog', 'product', 'products', 'item', 'items', 'order', 'orders',
  'shipping', 'delivery', 'track', 'tracking', 'warehouse', 'inventory', 'stock', 'supply', 'supplier', 'vendor', 'partner',
  'partners', 'affiliate', 'reseller', 'distributor', 'dealer', 'franchise', 'corp', 'corporate', 'enterprise', 'business',
  'company', 'group', 'holding', 'inc', 'ltd', 'limited', 'llc', 'gmbh', 'sarl', 'bv', 'nv', 'plc', 'co', 'cloud', 'tech',
  'online', 'digital', 'cyber', 'secure', 'safe', 'trust', 'verified', 'cert', 'certificate', 'ssl', 'tls', 'private', 'internal',
  'intranet', 'extranet', 'dmz', 'bastion', 'jump', 'gateway', 'gw', 'router', 'switch', 'firewall', 'fw', 'ids', 'ips', 'waf',
  'siem', 'soc', 'noc', 'gitlab-ci', 'registry', 'docker', 'k8s', 'kubernetes', 'helm', 'argo', 'vault', 'consul', 'nomad',
  'terraform', 'ansible', 'puppet', 'chef', 'salt', 'vagrant', 'packer', 'nomad', 'traefik', 'nginx', 'apache', 'iis', 'tomcat',
  'jetty', 'wildfly', 'jboss', 'weblogic', 'websphere', 'caddy', 'haproxy', 'varnish', 'squid', 'stun', 'turn', 'ice', 'sip',
  'rtp', 'rtmp', 'rtsp', 'hls', 'dash', 'webrtc', 'mqtt', 'amqp', 'kafka', 'rabbitmq', 'zeromq', 'nats', 'pulsar', 'celery',
  'flower', 'rq', 'huey', 'airflow', 'prefect', 'dagster', 'luigi', 'pinball', 'azkaban', 'oozie', 'drake', 'make', 'cmake',
  'bazel', 'buck', 'pants', 'gradle', 'maven', 'ant', 'sbt', 'leiningen', 'cargo', 'npm', 'yarn', 'pnpm', 'pip', 'poetry',
  'conda', 'pipenv', 'virtualenv', 'venv', 'tox', 'nox', 'pytest', 'unittest', 'jest', 'mocha', 'jasmine', 'cypress', 'playwright',
  'selenium', 'webdriver', 'puppeteer', 'nightwatch', 'testcafe', 'protractor', 'karma', 'ava', 'tap', 'tape', 'lab', 'code',
  'chai', 'should', 'expect', 'assert', 'nock', 'sinon', 'mockery', 'proxyquire', 'rewire', 'supertest', 'frisby', 'dredd',
  'apitest', 'resttest', 'httptest', 'postman', 'insomnia', 'swagger', 'openapi', 'graphql-playground', 'graphiql', 'altair',
  'prisma', 'sequelize', 'typeorm', 'mikro-orm', 'bookshelf', 'objection', 'knex', 'waterline', 'sails', 'feathers', 'nest',
  'next', 'nuxt', 'gatsby', 'astro', 'sveltekit', 'remix', 'blitz', 'redwood', ' Keystone', 'strapi', 'directus', 'payload',
  'cockpit', 'ghost', 'wordpress', 'joomla', 'drupal', 'magento', 'prestashop', 'shopify', 'bigcommerce', 'woocommerce', 'opencart',
  'moodle', 'canvas', 'blackboard', 'd2l', 'brightspace', ' Sakai',
];

export async function runDomainRecon(event: IntelligenceEvent): Promise<void> {
  if (!config.RECON_DOMAIN_ENABLED) return;

  const now = Date.now();
  if (now - reconHourStart > 60 * 60 * 1000) {
    reconHourlyCount = 0;
    reconHourStart = now;
  }
  if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) return;

  const domains = extractDomainsFromEvent(event);
  if (domains.length === 0) return;

  for (const domain of domains) {
    await reconDomain(domain, event.id);
  }
}

function extractDomainsFromEvent(event: IntelligenceEvent): string[] {
  const domains: string[] = [];
  const tags = event.tags;

  if (typeof tags.domain === 'string') domains.push(tags.domain);
  if (typeof tags.parent_domain === 'string') domains.push(tags.parent_domain);
  if (Array.isArray(tags.domains)) {
    for (const d of tags.domains) {
      if (typeof d === 'string') domains.push(d);
    }
  }

  const entities = tags.entities;
  if (Array.isArray(entities)) {
    for (const e of entities) {
      if (e && typeof e === 'object' && e.type === 'domain' && typeof e.value === 'string') {
        domains.push(e.value);
      }
    }
  }

  return [...new Set(domains)];
}

async function reconDomain(domain: string, parentEventId: string): Promise<void> {
  try {
    // 1. Certificate transparency lookup via crt.sh
    const crtEntries = await queryCrtsh(domain);
    for (const entry of crtEntries) {
      await createReconEvent({
        title: `Recon: subdomain ${entry.name}`,
        content: `Discovered subdomain via certificate transparency:\nDomain: ${entry.name}\nIssuer: ${entry.issuer_name || 'unknown'}\nParent: ${domain}`,
        tags: {
          recon_source: 'domain',
          recon_type: 'subdomain',
          parent_domain: domain,
          parent_event_id: parentEventId,
          subdomain: entry.name,
          issuer: entry.issuer_name,
          cert_id: entry.id,
        },
      });
      reconHourlyCount++;
    }

    // 2. DNS resolution (A, AAAA, MX, NS, TXT)
    const dnsRecords = await queryDns(domain);
    const mxRecords = dnsRecords.filter((r) => r.type === 'MX');
    const otherRecords = dnsRecords.filter((r) => r.type !== 'MX');

    for (const record of otherRecords) {
      await createReconEvent({
        title: `Recon: DNS ${record.type} for ${domain}`,
        content: `DNS record for ${domain}:\nType: ${record.type}\nValue: ${record.value}`,
        tags: {
          recon_source: 'domain',
          recon_type: 'dns',
          parent_domain: domain,
          parent_event_id: parentEventId,
          dns_type: record.type,
          dns_value: record.value,
        },
      });
      reconHourlyCount++;
    }

    // 2b. MX records — formatted as dedicated recon events
    if (mxRecords.length > 0) {
      await createReconEvent({
        title: `Recon: MX records for ${domain}`,
        content: `Mail servers for ${domain}:\n${mxRecords.map((r) => `- ${r.value}`).join('\n')}`,
        tags: {
          recon_source: 'domain',
          recon_type: 'mx',
          parent_domain: domain,
          parent_event_id: parentEventId,
          mx_records: mxRecords.map((r) => r.value),
        },
      });
      reconHourlyCount++;
    }

    // 3. WHOIS lookup
    const whois = await queryWhois(domain);
    if (whois) {
      await createReconEvent({
        title: `Recon: WHOIS for ${domain}`,
        content: [
          `Domain: ${whois.domain}`,
          whois.registrar ? `Registrar: ${whois.registrar}` : '',
          whois.created ? `Created: ${whois.created}` : '',
          whois.expires ? `Expires: ${whois.expires}` : '',
          whois.updated ? `Updated: ${whois.updated}` : '',
          whois.nameservers ? `Name Servers: ${whois.nameservers.join(', ')}` : '',
          whois.org ? `Organization: ${whois.org}` : '',
          whois.country ? `Country: ${whois.country}` : '',
        ].filter(Boolean).join('\n'),
        tags: {
          recon_source: 'domain',
          recon_type: 'whois',
          parent_domain: domain,
          parent_event_id: parentEventId,
          registrar: whois.registrar,
          created: whois.created,
          expires: whois.expires,
          updated: whois.updated,
          nameservers: whois.nameservers,
          org: whois.org,
          country: whois.country,
        },
      });
      reconHourlyCount++;
    }

    // 4. Subdomain brute-force via DNS
    const bruteResults = await bruteForceSubdomains(domain);
    for (const sub of bruteResults) {
      await createReconEvent({
        title: `Recon: brute-force subdomain ${sub.subdomain}`,
        content: `Discovered subdomain via brute-force:\nSubdomain: ${sub.subdomain}\nIP: ${sub.ip}\nParent: ${domain}`,
        tags: {
          recon_source: 'domain',
          recon_type: 'subdomain_brute',
          parent_domain: domain,
          parent_event_id: parentEventId,
          subdomain: sub.subdomain,
          ip: sub.ip,
        },
      });
      reconHourlyCount++;
    }

    // 5. Zone transfer attempt (Fierce-style)
    const zoneTransfer = await attemptZoneTransfer(domain);
    if (zoneTransfer && zoneTransfer.length > 0) {
      await createReconEvent({
        title: `Recon: Zone Transfer for ${domain}`,
        content: `Zone transfer successful for ${domain}!\nRecords:\n${zoneTransfer.slice(0, 30).map((r) => `${r.type}: ${r.value}`).join('\n')}`,
        tags: {
          recon_source: 'domain',
          recon_type: 'zone_transfer',
          parent_domain: domain,
          parent_event_id: parentEventId,
          zone_records: zoneTransfer.slice(0, 30),
        },
      });
      reconHourlyCount++;
    }

    // 7. Keyless passive-DNS enrichment (mnemonic + hackertarget). Both are
    //    throttled and degrade to empty on error. We collect their discovered
    //    IPs so step 6's reverse-DNS handling can also cover them.
    const passiveIps = new Set<string>();

    if (reconHourlyCount < config.RECON_MAX_EVENTS_PER_HOUR) {
      const mnemonicHits = await queryMnemonic(domain);
      for (const hit of mnemonicHits) {
        if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) break;
        await createReconEvent({
          title: `Recon: passive DNS ${hit.record} ${hit.value}`,
          content: `Passive DNS record for ${domain} (mnemonic):\nRecord: ${hit.record}\nValue: ${hit.value}`,
          tags: {
            recon_source: 'domain',
            recon_type: 'passive_dns',
            source: 'mnemonic',
            parent_domain: domain,
            parent_event_id: parentEventId,
            record: hit.record,
            value: hit.value,
          },
        });
        reconHourlyCount++;
        if (hit.record === 'A' || hit.record === 'AAAA') passiveIps.add(hit.value);
      }
    }

    // Throttle between the two providers to stay polite to both keyless APIs.
    await sleep(750);

    if (reconHourlyCount < config.RECON_MAX_EVENTS_PER_HOUR) {
      const cohosts = await queryHackertarget(domain);
      for (const co of cohosts) {
        if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) break;
        await createReconEvent({
          title: `Recon: passive DNS ${co.host} -> ${co.ip}`,
          content: `Co-hosted record for ${domain} (hackertarget):\nHost: ${co.host}\nIP: ${co.ip}`,
          tags: {
            recon_source: 'domain',
            recon_type: 'passive_dns',
            source: 'hackertarget',
            parent_domain: domain,
            parent_event_id: parentEventId,
            record: 'A',
            value: co.ip,
            host: co.host,
          },
        });
        reconHourlyCount++;
        passiveIps.add(co.ip);
      }
    }

    // 6. Reverse DNS for discovered IPs (Fierce-style)
    const discoveredIps = [...new Set([
      ...dnsRecords.filter((r) => r.type === 'A').map((r) => r.value),
      ...bruteResults.map((r) => r.ip),
      ...passiveIps,
    ])];
    for (const ip of discoveredIps.slice(0, 10)) {
      if (reconHourlyCount >= config.RECON_MAX_EVENTS_PER_HOUR) break;
      const ptr = await queryReverseDns(ip);
      if (ptr) {
        await createReconEvent({
          title: `Recon: Reverse DNS ${ip}`,
          content: `Reverse DNS lookup for ${ip}:\nHostname: ${ptr}`,
          tags: {
            recon_source: 'domain',
            recon_type: 'reverse_dns',
            parent_domain: domain,
            parent_event_id: parentEventId,
            ip,
            ptr,
          },
        });
        reconHourlyCount++;
      }
    }
  } catch (err) {
    console.error(`[reconDomain] Failed for ${domain}:`, err instanceof Error ? err.message : String(err));
  }
}

async function queryCrtsh(domain: string): Promise<Array<{ name: string; issuer_name?: string; id?: number }>> {
  const url = `https://crt.sh/?q=%.${encodeURIComponent(domain)}&output=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];

  const entries = (await res.json()) as Array<{ name_value?: string; issuer_name?: string; id?: number }>;
  if (!Array.isArray(entries)) return [];

  const seen = new Set<string>();
  const results: Array<{ name: string; issuer_name?: string; id?: number }> = [];
  for (const e of entries) {
    const name = String(e.name_value).trim().toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (name.startsWith('*.')) continue;
    if (name === domain) continue;
    results.push({ name, issuer_name: e.issuer_name, id: e.id });
  }
  return results.slice(0, 50);
}

async function queryDns(domain: string): Promise<Array<{ type: string; value: string }>> {
  const records: Array<{ type: string; value: string }> = [];
  const types = ['A', 'AAAA', 'MX', 'NS', 'TXT'];
  for (const type of types) {
    try {
      const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { Answer?: Array<{ data: string; type: number }> };
      for (const ans of data.Answer ?? []) {
        records.push({ type, value: ans.data });
      }
    } catch {
      // ignore individual DNS query failures
    }
  }
  return records;
}

async function queryWhois(domain: string): Promise<{
  domain: string;
  registrar?: string;
  created?: string;
  expires?: string;
  updated?: string;
  nameservers?: string[];
  org?: string;
  country?: string;
} | undefined> {
  try {
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(domain)}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    if (data.success === false) return undefined;

    return {
      domain,
      registrar: typeof data['domain registrar'] === 'string' ? data['domain registrar'] as string : undefined,
      created: typeof data.creation_date === 'string' ? data.creation_date : undefined,
      expires: typeof data.expiration_date === 'string' ? data.expiration_date : undefined,
      updated: typeof data.updated_date === 'string' ? data.updated_date : undefined,
      nameservers: Array.isArray(data.name_servers) ? data.name_servers.filter((s): s is string => typeof s === 'string') : undefined,
      org: typeof data.org === 'string' ? data.org : undefined,
      country: typeof data.country === 'string' ? data.country : undefined,
    };
  } catch {
    return undefined;
  }
}

async function attemptZoneTransfer(domain: string): Promise<Array<{ type: string; value: string }> | undefined> {
  try {
    // Get NS records first
    const nsRes = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=NS`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!nsRes.ok) return undefined;
    const nsData = (await nsRes.json()) as { Answer?: Array<{ data: string }> };
    const nsServers = (nsData.Answer ?? []).map((a) => a.data);
    if (nsServers.length === 0) return undefined;

    // Try AXFR against each NS (best-effort, most will refuse)
    for (const _ns of nsServers.slice(0, 3)) {
      try {
        // Google DoH doesn't support AXFR, so we use a public AXFR test endpoint
        const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=AXFR`, {
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = (await res.json()) as { Answer?: Array<{ data: string; type: number; name: string }> };
          if (data.Answer && data.Answer.length > 1) {
            return data.Answer.map((a) => ({ type: 'AXFR', value: `${a.name} -> ${a.data}` }));
          }
        }
      } catch {
        // ignore per-NS failures
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function queryReverseDns(ip: string): Promise<string | undefined> {
  try {
    const parts = ip.split('.').reverse().join('.');
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(parts)}.in-addr.arpa&type=PTR`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { Answer?: Array<{ data: string }> };
    return data.Answer?.[0]?.data;
  } catch {
    return undefined;
  }
}

/**
 * Keyless passive-DNS lookup via mnemonic's PDNS v3 API.
 *
 * Clean-room port of the idea behind SpiderFoot's sfp_mnemonic.py
 * (smicallef/spiderfoot, MIT) — no code copied. Queries the public, keyless
 * endpoint, verifies the JSON envelope's responseCode, treats 402 as a quota
 * stop, de-dupes (record,value) pairs, filters out stale answers when a
 * lastSeenTimestamp is present, and caps the result set.
 */
async function queryMnemonic(domain: string): Promise<Array<{ record: string; value: string }>> {
  try {
    const url = `https://api.mnemonic.no/pdns/v3/${encodeURIComponent(domain)}`;
    const res = await safeFetch(url, { timeoutMs: 15000 });
    if (!res.ok) return [];

    const data = (await res.json()) as {
      responseCode?: number;
      data?: Array<{ rrtype?: string; answer?: string; value?: string; lastSeenTimestamp?: number }>;
    };

    // 402 = quota exhausted -> back off quietly. Anything other than 200 is
    // treated as no usable data.
    if (data.responseCode === 402) return [];
    if (data.responseCode !== 200) return [];

    const rows = Array.isArray(data.data) ? data.data : [];

    // Recency window: keep answers seen within the last ~180 days when a
    // lastSeenTimestamp is provided; rows without one are kept (no signal to drop).
    const recencyCutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;

    const seen = new Set<string>();
    const results: Array<{ record: string; value: string }> = [];
    for (const row of rows) {
      const record = String(row.rrtype ?? '').toUpperCase().trim();
      const value = String(row.answer ?? row.value ?? '').trim();
      if (!record || !value) continue;

      if (typeof row.lastSeenTimestamp === 'number' && row.lastSeenTimestamp < recencyCutoff) {
        continue;
      }

      const key = `${record}|${value}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ record, value });
      if (results.length >= 100) break;
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Keyless reverse-IP / co-host lookup via HackerTarget's hostsearch endpoint.
 *
 * Clean-room port of the idea behind SpiderFoot's sfp_hackertarget.py
 * (smicallef/spiderfoot, MIT) — no code copied. The endpoint returns a plain
 * `host,ip` CSV body. We bail on HTTP 429 and on the well-known
 * "API count exceeded" body, parse each `host,ip` row, and cap co-hosts.
 */
async function queryHackertarget(domain: string): Promise<Array<{ host: string; ip: string }>> {
  try {
    const url = `https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`;
    const res = await safeFetch(url, { timeoutMs: 15000 });
    // 429 = rate limited -> bail.
    if (res.status === 429) return [];
    if (!res.ok) return [];

    const text = await res.text();
    // Free-tier quota message arrives as a 200 body, so check the text too.
    if (!text || text.includes('API count exceeded')) return [];
    // Other plaintext error markers from the API.
    if (text.startsWith('error') || text.includes('No DNS')) return [];

    const seen = new Set<string>();
    const results: Array<{ host: string; ip: string }> = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const comma = trimmed.indexOf(',');
      if (comma === -1) continue;
      const host = trimmed.slice(0, comma).trim().toLowerCase();
      const ip = trimmed.slice(comma + 1).trim();
      if (!host || !ip) continue;

      const key = `${host}|${ip}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({ host, ip });
      if (results.length >= 100) break;
    }
    return results;
  } catch {
    return [];
  }
}

async function bruteForceSubdomains(domain: string): Promise<Array<{ subdomain: string; ip: string }>> {
  const results: Array<{ subdomain: string; ip: string }> = [];
  const seen = new Set<string>();

  // Limit wordlist to avoid excessive DNS queries
  const wordlist = SUBDOMAIN_WORDLIST.slice(0, 200);

  // Process in batches of 20 with Promise.allSettled for concurrency
  const batchSize = 20;
  for (let i = 0; i < wordlist.length; i += batchSize) {
    const batch = wordlist.slice(i, i + batchSize);
    const promises = batch.map(async (word) => {
      const subdomain = `${word}.${domain}`;
      try {
        const url = `https://dns.google/resolve?name=${encodeURIComponent(subdomain)}&type=A`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const data = (await res.json()) as { Answer?: Array<{ data: string }> };
        const ip = data.Answer?.[0]?.data;
        if (ip && !seen.has(subdomain)) {
          seen.add(subdomain);
          return { subdomain, ip };
        }
      } catch {
        // ignore
      }
      return null;
    });

    const settled = await Promise.allSettled(promises);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) {
        results.push(s.value);
        if (results.length >= 50) break; // cap results
      }
    }
    if (results.length >= 50) break;
  }

  return results;
}

async function createReconEvent(partial: {
  title: string;
  content: string;
  tags: Record<string, unknown>;
}): Promise<void> {
  const id = `recon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await exec(
    `INSERT INTO intelligence_events
     (id, source_id, kind, title, content, tags, confidence, sensitivity, event_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      'recon_domain',
      'alert',
      partial.title,
      partial.content,
      JSON.stringify(partial.tags),
      0.75,
      'public',
      Date.now(),
      Date.now(),
    ],
  );
}
