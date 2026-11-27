// Uploads a packaged zip to the Chrome Web Store and submits it for review,
// through the Chrome Web Store API v2 with a service account. The API only
// updates items: upload the first version by hand in the Developer Dashboard.
//   npm run publish:chrome                         newest zip in dist/: upload, then submit
//   npm run publish:chrome -- --upload-only
//   npm run publish:chrome -- dist/deals-analyzer-1.0.42.zip   a particular zip
// Options:
//   --upload-only     leave the upload as a draft in the dashboard; don't submit it
//   --staged          once approved, wait for Publish to be clicked in the dashboard
//   --cancel-pending  cancel a submission still in review and submit this one (restarts review)
// Needs CWS_PUBLISHER_ID, CWS_EXTENSION_ID, and the service account's JSON key,
// either its contents in CWS_SERVICE_ACCOUNT_KEY or its path in
// CWS_SERVICE_ACCOUNT_KEY_FILE (keep the file outside the repo). Read from the
// environment, then from .env. The store refuses a version it already has, so
// the zip must be newer: CI stamps 1.0.<run number>, local builds stay 1.0.0.
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { newestZip } from './newest-zip.mjs';

const API = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const FLAGS = new Set(['--upload-only', '--staged', '--cancel-pending']);
// Anything else (REJECTED, CANCELLED) means the submission didn't go through,
// even though the API answers 200.
const SUBMITTED = {
  PENDING_REVIEW: 'submitted for review',
  STAGED: 'approved and staged; publish it from the Developer Dashboard',
  PUBLISHED: 'published',
  PUBLISHED_TO_TESTERS: 'published to trusted testers'
};

const base64url = (text) => Buffer.from(text).toString('base64url');

// Signs a one-hour JWT with the service account's key and trades it for an access token.
export async function accessToken(key, { fetch = globalThis.fetch, now = Date.now() } = {}) {
  if (!key?.client_email || !key?.private_key) {
    throw new Error('The service account key needs client_email and private_key: create a JSON key for it.');
  }
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key, 'base64url');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`
    }),
    signal: AbortSignal.timeout(30_000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google refused the service account (${res.status}): ${data.error_description || data.error || 'no access token'}`);
  }
  return data.access_token;
}

// Compares dotted versions by number, so 1.0.10 is newer than 1.0.9.
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export async function publishToChromeWebStore({
  zip, version, token, publisherId, itemId,
  uploadOnly = false, staged = false, cancelPending = false,
  fetch = globalThis.fetch, log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollMs = 5000, pollLimitMs = 10 * 60_000
}) {
  const item = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const call = async (method, action, { prefix = 'v2', headers = {}, body } = {}) => {
    const res = await fetch(`${API}/${prefix}/${item}:${action}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
      signal: AbortSignal.timeout(120_000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hint = [403, 404].includes(res.status)
        ? ' Check CWS_PUBLISHER_ID and CWS_EXTENSION_ID, that the service account is added under Account in the Developer Dashboard, and that the first version was uploaded there by hand.'
        : '';
      throw new Error(`${action} failed (${res.status}): ${data.error?.message || res.statusText || 'no details'}.${hint}`);
    }
    return data;
  };

  // Check the item first: the store refuses a version it already has.
  const status = await call('GET', 'fetchStatus');
  if (status.takenDown) throw new Error('The item was taken down for a policy violation; see the Developer Dashboard.');
  if (status.warned) log('Warning: the item has a policy warning; see the Developer Dashboard.');
  const inStore = [status.publishedItemRevisionStatus, status.submittedItemRevisionStatus]
    .flatMap((revision) => revision?.distributionChannels ?? [])
    .map((channel) => channel.crxVersion)
    .filter(Boolean)
    .sort(compareVersions)
    .at(-1);
  if (inStore && compareVersions(version, inStore) <= 0) {
    throw new Error(`The store already has ${inStore} and this zip is ${version}. Upload a newer build: CI stamps 1.0.<run number>.`);
  }
  if (status.submittedItemRevisionStatus?.state === 'PENDING_REVIEW') {
    if (cancelPending) {
      await call('POST', 'cancelSubmission');
      log('Cancelled the submission that was in review.');
    } else if (!uploadOnly) {
      throw new Error('A submission is still in review. Wait for it, or rerun with --cancel-pending to replace it (review starts over).');
    }
  }

  log(`Uploading ${path.basename(zip)} (${version})…`);
  const upload = await call('POST', 'upload', {
    prefix: 'upload/v2',
    headers: { 'content-type': 'application/zip' },
    body: readFileSync(zip)
  });
  // Processing can finish later; then only fetchStatus says whether it worked.
  let state = upload.uploadState;
  for (let waited = 0; /IN_PROGRESS$/.test(state ?? ''); waited += pollMs) {
    if (waited >= pollLimitMs) throw new Error('The upload is still processing after 10 minutes; check the Developer Dashboard.');
    await sleep(pollMs);
    state = (await call('GET', 'fetchStatus')).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error(`The upload ended as ${state || 'unknown'}; the Developer Dashboard says why.`);
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(`The store read version ${upload.crxVersion} from the upload, not ${version}; not submitting it.`);
  }

  if (uploadOnly) {
    log(`Uploaded ${version} as a draft. Submit it from the Developer Dashboard.`);
    return { version, state: 'DRAFT' };
  }

  const result = await call('POST', 'publish', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publishType: staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH' })
  });
  for (const warning of result.warningInfo?.warnings ?? []) log(`Warning: ${warning.description || warning.reason}`);
  if (!SUBMITTED[result.state]) throw new Error(`The submission came back ${result.state || 'without a state'}; see the Developer Dashboard.`);
  log(`${version}: ${SUBMITTED[result.state]}.`);
  return { version, state: result.state };
}

function readKey() {
  const { CWS_SERVICE_ACCOUNT_KEY: inline, CWS_SERVICE_ACCOUNT_KEY_FILE: file } = process.env;
  if (!inline && !file) throw new Error('Set CWS_SERVICE_ACCOUNT_KEY (the JSON key) or CWS_SERVICE_ACCOUNT_KEY_FILE (its path).');
  try {
    return JSON.parse(inline || readFileSync(file, 'utf8'));
  } catch {
    // JSON.parse quotes the text it failed on, which here is a private key.
    throw new Error('The service account key could not be read as JSON.');
  }
}

async function main(args) {
  const flags = args.filter((arg) => arg.startsWith('--'));
  const unknown = flags.filter((flag) => !FLAGS.has(flag));
  if (unknown.length || args.length - flags.length > 1) {
    throw new Error('usage: npm run publish:chrome -- [zip, default: newest in dist/] [--upload-only] [--staged] [--cancel-pending]');
  }
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  } catch {
    // fall through to the checks below
  }
  const { CWS_PUBLISHER_ID: publisherId, CWS_EXTENSION_ID: itemId } = process.env;
  if (!publisherId || !itemId) throw new Error('Set CWS_PUBLISHER_ID and CWS_EXTENSION_ID.');

  const zip = args.find((arg) => !arg.startsWith('--')) || newestZip();
  // Ship nothing but extension/, whatever else is in the working tree.
  execFileSync(process.execPath, [fileURLToPath(new URL('check-package.mjs', import.meta.url)), zip], { stdio: 'inherit' });
  const { version } = JSON.parse(execFileSync('unzip', ['-p', zip, 'manifest.json'], { encoding: 'utf8' }));

  await publishToChromeWebStore({
    zip,
    version,
    token: await accessToken(readKey()),
    publisherId,
    itemId,
    uploadOnly: flags.includes('--upload-only'),
    staged: flags.includes('--staged'),
    cancelPending: flags.includes('--cancel-pending')
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
