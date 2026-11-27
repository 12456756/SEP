const { appendFileSync } = require('node:fs');

const REPOSITORY = '12456756/SEP';

async function checkReleaseQuality({
  env = process.env,
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = console.log,
  timeoutMs = 20 * 60 * 1000,
  pollMs = 15 * 1000,
} = {}) {
  const sha = env.GITHUB_SHA;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Production releases must use 12456756/SEP main.');
  }
  if (!/^[a-f0-9]{40}$/.test(sha || '') || !env.GITHUB_TOKEN) {
    throw new Error('A full GITHUB_SHA and GITHUB_TOKEN with actions:read and contents:read are required.');
  }
  const started = now();
  const deadline = started + timeoutMs;
  const api = `https://api.github.com/repos/${REPOSITORY}`;
  async function get(path) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (now() >= deadline) throw new Error('Quality gate timed out; no server connection was made.');
      try {
        const response = await fetch(`${api}/${path}`, {
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))),
        });
        if (response.ok) return response.json();
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
          throw Object.assign(new Error(`GitHub API returned HTTP ${response.status}; release blocked.`), { fatal: true });
        }
      } catch (error) {
        if (error.fatal) throw error;
        if (attempt === 3) throw new Error('GitHub API could not be reached after 3 attempts; release blocked.');
      }
      await sleep(Math.min(2000, Math.max(0, deadline - now())));
    }
  }
  async function assertCurrentMain() {
    const ref = await get('git/ref/heads/main');
    if (ref.object?.sha !== sha) {
      throw new Error('main has advanced. Start a new deployment from main to avoid releasing an outdated queued commit.');
    }
  }
  await assertCurrentMain();
  while (now() < deadline) {
    const query = new URLSearchParams({ head_sha: sha, branch: 'main', event: 'push', per_page: '1' });
    const data = await get(`actions/workflows/quality.yml/runs?${query}`);
    if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid Quality Gates API response; release blocked.');
    const run = data.workflow_runs[0];
    if (run) {
      if (run.head_sha !== sha || run.head_branch !== 'main' || run.event !== 'push' || run.head_repository?.full_name !== REPOSITORY) {
        throw new Error('Quality Gates does not match this production commit; release blocked.');
      }
      const url = `https://github.com/${REPOSITORY}/actions/runs/${run.id}`;
      if (run.status === 'completed') {
        if (run.conclusion !== 'success') {
          throw new Error(`Quality Gates finished with ${run.conclusion}; fix or rerun it before deployment: ${url}`);
        }
        await assertCurrentMain();
        log(`Quality Gates passed for ${sha}: ${url}`);
        return { sha, url };
      }
      log(`Waiting for Quality Gates (${run.status}): ${url}`);
    } else if (now() - started >= 60000) {
      throw new Error('No main push Quality Gates run exists for this commit. Check the push workflow before deploying.');
    } else {
      log('Waiting for the Quality Gates run to appear for this commit.');
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
  }
  throw new Error('Quality Gates did not pass within 20 minutes; no server connection was made.');
}

module.exports = { checkReleaseQuality };

if (require.main === module) {
  checkReleaseQuality().then(({ sha, url }) => {
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release verification\n\nCommit: \`${sha}\`\n\nQuality Gates: ${url}\n`);
    }
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
