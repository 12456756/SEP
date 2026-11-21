const REPOSITORY = '12456756/SEP';

async function requireSuccessfulQuality({
  env = process.env,
  fetch = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
  timeoutMs = 20 * 60 * 1000,
  pollMs = 15000,
} = {}) {
  const sha = env.GITHUB_SHA;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Embedding service maintenance must use 12456756/SEP main.');
  }
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !env.GITHUB_TOKEN) {
    throw new Error('Full GITHUB_SHA and read-only GITHUB_TOKEN are required.');
  }
  const start = now();
  const deadline = start + timeoutMs;
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  async function get(resource) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (now() >= deadline) throw new Error('Quality Gates wait timed out.');
      try {
        const response = await fetch(`${api}/${resource}`, {
          headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
          signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))),
        });
        if (response.ok) return response.json();
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
          throw Object.assign(new Error(`GitHub API returned HTTP ${response.status}.`), { fatal: true });
        }
      } catch (error) {
        if (error.fatal) throw error;
        if (attempt === 3) throw new Error('GitHub API unavailable after 3 attempts.');
      }
      await sleep(Math.min(2000, Math.max(0, deadline - now())));
    }
  }
  const ref = await get('git/ref/heads/main');
  if (ref.object?.sha !== sha) throw new Error('main changed; start model maintenance again at the current main commit.');
  while (now() < deadline) {
    const query = new URLSearchParams({ head_sha: sha, branch: 'main', event: 'push', per_page: '1' });
    const data = await get(`actions/workflows/quality.yml/runs?${query}`);
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid Quality Gates response.');
    const run = data.workflow_runs[0];
    if (run) {
      if (run.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push' || run.head_repository?.full_name !== REPOSITORY) {
        throw new Error('Quality Gates run does not match this main commit.');
      }
      const url = `https://github.com/${REPOSITORY}/actions/runs/${run.id}`;
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error(`Quality Gates ${run.conclusion}; model maintenance blocked: ${url}`);
        const finalRef = await get('git/ref/heads/main');
        if (finalRef.object?.sha !== sha) throw new Error('main changed while waiting; start again at the current commit.');
        log(`Quality Gates passed for ${sha}: ${url}`);
        return { sha, url };
      }
      log(`Waiting for Quality Gates (${run.status}): ${url}`);
    } else if (now() - start >= 60000) throw new Error('No Quality Gates push run exists for this commit.');
    else log('Waiting for the main Quality Gates run to appear.');
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new Error('Quality Gates did not pass within 20 minutes.');
}

module.exports = { requireSuccessfulQuality };
if (require.main === module) {
  requireSuccessfulQuality().then(() => {
    if (process.env.GITHUB_STEP_SUMMARY) require('node:fs').appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Quality Gates passed for ${process.env.GITHUB_SHA}.\n`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
