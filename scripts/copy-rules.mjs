// Copy the declarative rule-engine YAML rules into dist so the compiled
// ruleEngine.js can load them in production (the Docker image ships only dist/,
// not src/). tsc does not copy non-TS assets. Runs as the npm `postbuild` step.
import { cpSync, existsSync } from 'node:fs';

const src = 'src/processors/rules';
const dest = 'dist/processors/rules';

if (existsSync(src)) {
  cpSync(src, dest, { recursive: true });
  console.log(`[postbuild] copied ${src} -> ${dest}`);
} else {
  console.warn(`[postbuild] ${src} not found; skipping rules copy`);
}
