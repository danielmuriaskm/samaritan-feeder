import { query, exec } from '../db.js';

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did',
  'will','would','could','should','may','might','must','shall','can','need','dare','ought','used',
  'to','of','in','for','on','with','at','by','from','as','into','through','during','before','after',
  'above','below','between','under','again','further','then','once','here','there','when','where',
  'why','how','all','each','few','more','most','other','some','such','no','nor','not','only','own',
  'same','so','than','too','very','just','and','but','if','or','because','until','while','this','that',
  'these','those','i','me','my','myself','we','our','ours','ourselves','you','your','yours',
  'yourself','yourselves','he','him','his','himself','she','her','hers','herself','it','its','itself',
  'they','them','their','theirs','themselves','what','which','who','whom','whose','am','get','got',
  'go','going','went','come','came','say','said','see','saw','know','knew','think','thought','take',
  'took','make','made','want','wanted','give','gave','find','found','tell','told','become','became',
  'leave','left','feel','felt','put','set','keep','kept','let','help','helped','show','showed','hear',
  'heard','play','played','run','ran','move','moved','live','lived','believe','believed','bring',
  'brought','happen','happened','stand','stood','lose','lost','pay','paid','meet','met','include',
  'included','continue','continued','set','remain','remained','add','added','become','became',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function computeTfIdfVectors(texts: string[]): Map<number, Map<string, number>> {
  const docCount = texts.length;
  const docFreq = new Map<string, number>();
  const vectors = new Map<number, Map<string, number>>();

  // Compute document frequencies
  for (const text of texts) {
    const tokens = new Set(tokenize(text));
    for (const token of tokens) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
  }

  // Compute TF-IDF vectors
  for (let i = 0; i < texts.length; i++) {
    const tokens = tokenize(texts[i]);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }

    const vec = new Map<string, number>();
    for (const [token, count] of tf) {
      const idf = Math.log(docCount / (1 + (docFreq.get(token) ?? 1)));
      vec.set(token, count * idf);
    }
    vectors.set(i, vec);
  }

  return vectors;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [token, val] of a) {
    normA += val * val;
    const bVal = b.get(token) ?? 0;
    if (bVal) dot += val * bVal;
  }

  for (const val of b.values()) {
    normB += val * val;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function clusterRecentEvents(hoursBack = 24, similarityThreshold = 0.6): Promise<void> {
  const since = Date.now() - hoursBack * 60 * 60 * 1000;

  const rows = await query<Record<string, unknown>>(
    `SELECT id, title, content, kind, event_at FROM intelligence_events WHERE event_at >= $1 ORDER BY event_at DESC`,
    [since],
  );

  if (rows.length < 2) return;

  const texts = rows.map((r) => `${String(r.title ?? '')} ${String(r.content ?? '')}`);
  const vectors = computeTfIdfVectors(texts);

  const clusters: Array<{ representativeId: string; memberIds: string[] }> = [];
  const assigned = new Set<number>();

  for (let i = 0; i < rows.length; i++) {
    if (assigned.has(i)) continue;

    const clusterMembers = [i];
    assigned.add(i);

    for (let j = i + 1; j < rows.length; j++) {
      if (assigned.has(j)) continue;
      const sim = cosineSimilarity(vectors.get(i)!, vectors.get(j)!);
      if (sim >= similarityThreshold) {
        clusterMembers.push(j);
        assigned.add(j);
      }
    }

    if (clusterMembers.length > 1) {
      clusters.push({
        representativeId: String(rows[i].id),
        memberIds: clusterMembers.map((idx) => String(rows[idx].id)),
      });
    }
  }

  // Update cluster tags in DB
  for (const cluster of clusters) {
    for (const memberId of cluster.memberIds) {
      await exec(
        `UPDATE intelligence_events SET tags = jsonb_set(tags, '{cluster_id}', $1::jsonb) WHERE id = $2`,
        [JSON.stringify(cluster.representativeId), memberId],
      );
    }
  }

  console.log(`[nlpCluster] Clustered ${rows.length} events into ${clusters.length} clusters`);
}
