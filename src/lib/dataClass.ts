import type { DataClass, EventKind } from '../types.js';

/**
 * Derive a coarse finding-class label for an event from its kind + tags (006).
 *
 * The store column is the source of truth; this is the single derivation point so
 * the label is consistent whether stamped at ingest (the main stream) or
 * backfilled over recon events by the lineage sweep. Pure, dependency-free.
 *
 * Returns `undefined` when nothing confident applies, so callers can leave the
 * column NULL rather than mislabel — `data_class` is a triage aid, not ground truth.
 */
export function deriveDataClass(event: { kind: EventKind; tags?: Record<string, unknown> }): DataClass | undefined {
  const t = event.tags ?? {};
  const reconType = typeof t.recon_type === 'string' ? t.recon_type.toLowerCase() : '';
  const iocType = typeof t.ioc_type === 'string' ? t.ioc_type.toLowerCase() : '';
  const threat = typeof t.threat === 'string' ? t.threat.toLowerCase() : '';

  // 1. Explicit threat/IOC signals (highest confidence).
  if (threat.includes('phish') || iocType === 'phish' || reconType === 'phishing') return 'phishing';
  if (threat.includes('malware') || iocType === 'malware' || Number(t.vt_malicious) > 0) return 'malware';
  if (reconType === 'defacement' || t.defaced === true) return 'defacement';
  if (t.breached === true || Number(t.breach_count) > 0) return 'breach_leak';
  if (reconType === 'secret' || reconType === 'secret_scan' || t.secret_type) return 'leaked_secret';

  // 2. Vulnerability / exposure.
  if (t.cve || (Array.isArray(t.shodan_vulns) && t.shodan_vulns.length > 0) || reconType === 'vulnerability') {
    return 'vulnerability';
  }
  if (
    reconType === 'open_port' ||
    reconType === 'port_probe' ||
    reconType === 'portprobe' ||
    reconType === 'nuclei' ||
    Array.isArray(t.open_ports)
  ) {
    return 'exposed_service';
  }

  // 3. Any other recon-derived finding (subdomain/dns/whois/cert/etc.).
  if (reconType || t.recon_source) return 'recon_finding';

  // 4. Generic cyber IOC enrichment.
  if (iocType || t.combo_intel || t.recon_type === 'combo_intel') return 'cyber_ioc';

  // 5. Computer vision.
  if (Object.prototype.hasOwnProperty.call(t, 'cv') || event.kind === 'detection') return 'cv_detection';

  // 6. Hazard / authoritative alerts.
  if (event.kind === 'alert' || event.kind === 'anomaly') return 'hazard_alert';

  // 7. Plain content classes.
  if (event.kind === 'social_post') return 'social_post';
  if (event.kind === 'text') {
    if (t.source_kind === 'arxiv' || t.publisher === 'arxiv') return 'research';
    return 'news';
  }

  return undefined;
}
