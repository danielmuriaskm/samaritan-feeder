import { exec } from '../src/db.js';

async function main() {
  await exec(`
    ALTER TABLE intelligence_sources DROP CONSTRAINT IF EXISTS intelligence_sources_kind_check;
    ALTER TABLE intelligence_sources ADD CONSTRAINT intelligence_sources_kind_check CHECK (kind IN (
      'instagram', 'twitter', 'reddit', 'bluesky', 'tiktok',
      'webcam', 'traffic_cam', 'weather_cam', 'ip_camera',
      'rss', 'news_api', 'gdelt', 'github', 'hn', 'arxiv',
      'windy', 'youtube'
    ));
  `);
  console.log('Constraint updated successfully');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
