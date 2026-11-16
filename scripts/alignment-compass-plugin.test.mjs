import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../experiments/alignment-compass/test/host.test.cjs');
