import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { marketUsageStats } from '../server/market-usage.mjs';

const path = process.argv[2] || resolve(process.env.PEARL_DATA_DIR || 'server/data', 'market-usage.sqlite');
const db = new DatabaseSync(path, { readOnly: true });
try { console.log(JSON.stringify(marketUsageStats(db), null, 2)); }
finally { db.close(); }
