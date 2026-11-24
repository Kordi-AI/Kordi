import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../experiments/alignment-compass/test/core.test.cjs');
require('../experiments/alignment-compass/test/stress.test.cjs');
