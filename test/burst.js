'use strict';
/* Burst test: N parallel POSTs, proves the API does not fall under rapid calls. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const N = parseInt(process.argv[2] || '10', 10);

async function main() {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.md'), 'utf8');
  const pack = JSON.parse(raw);
  const jobs = [];
  for (let i = 0; i < N; i++) {
    const c = pack.cases[i % pack.cases.length];
    const t0 = Date.now();
    jobs.push(
      fetch(`${BASE}/optimize-energy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.input),
      })
        .then(async (r) => ({ id: c.id, status: r.status, ms: Date.now() - t0, ok: r.status === 200 }))
        .catch((e) => ({ id: c.id, status: 'ERR', ms: Date.now() - t0, ok: false, err: e.message }))
    );
  }
  const res = await Promise.all(jobs);
  let pass = 0;
  for (const r of res) {
    if (r.ok) pass++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id} HTTP ${r.status} ${r.ms}ms${r.err ? ' ' + r.err : ''}`);
  }
  console.log(`\nBurst: ${pass}/${N} ok`);
  if (pass < N) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
