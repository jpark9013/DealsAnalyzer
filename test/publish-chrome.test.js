import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accessToken, compareVersions, publishToChromeWebStore } from '../scripts/publish-chrome.mjs';

const zip = path.join(mkdtempSync(path.join(tmpdir(), 'cws-')), 'deals-analyzer-1.0.7.zip');
writeFileSync(zip, 'PK fake zip');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const published = (crxVersion) => ({
  publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ deployPercentage: 100, crxVersion }] }
});

// Answers each API action from a queue and records what was sent.
function store(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    const action = url.split(':').at(-1);
    calls.push({ url, action, ...init });
    const next = responses[action]?.shift();
    if (!next) throw new Error(`unexpected ${action}`);
    return next;
  };
  return { calls, fetch };
}

const run = (fetch, options = {}) =>
  publishToChromeWebStore({
    zip, version: '1.0.7', token: 'tok', publisherId: 'pub', itemId: 'abc',
    fetch, log: () => {}, sleep: async () => {}, ...options
  });

test('compares versions by number', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
});

test('signs a JWT with the service account key and returns the access token', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'cws@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let sent;
  const fetch = async (url, init) => {
    sent = { url, body: new URLSearchParams(init.body) };
    return json({ access_token: 'ya29.token', expires_in: 3600, token_type: 'Bearer' });
  };

  assert.equal(await accessToken(key, { fetch, now: 1_700_000_000_000 }), 'ya29.token');
  assert.equal(sent.url, 'https://oauth2.googleapis.com/token');
  assert.equal(sent.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = sent.body.get('assertion').split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_700_000_000,
    exp: 1_700_003_600
  });
});

test('reports why Google refused the service account', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'x@y', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const fetch = async () => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400);
  await assert.rejects(accessToken(key, { fetch }), /\(400\): Invalid JWT Signature/);
  await assert.rejects(accessToken({}, { fetch }), /client_email and private_key/);
});

test('uploads the zip, waits for processing, and submits it for review', async () => {
  const { calls, fetch } = store({
    fetchStatus: [json(published('1.0.6')), json({ ...published('1.0.6'), lastAsyncUploadState: 'SUCCEEDED' })],
    upload: [json({ itemId: 'abc', uploadState: 'IN_PROGRESS' })],
    publish: [json({ itemId: 'abc', state: 'PENDING_REVIEW' })]
  });

  assert.deepEqual(await run(fetch), { version: '1.0.7', state: 'PENDING_REVIEW' });
  assert.deepEqual(calls.map((c) => c.action), ['fetchStatus', 'upload', 'fetchStatus', 'publish']);
  assert.ok(calls.every((c) => c.headers.authorization === 'Bearer tok'));
  const [, upload, , publish] = calls;
  assert.equal(upload.method, 'POST');
  assert.equal(upload.url, 'https://chromewebstore.googleapis.com/upload/v2/publishers/pub/items/abc:upload');
  assert.equal(upload.body.toString(), 'PK fake zip');
  assert.equal(publish.url, 'https://chromewebstore.googleapis.com/v2/publishers/pub/items/abc:publish');
  assert.deepEqual(JSON.parse(publish.body), { publishType: 'DEFAULT_PUBLISH' });
});

test('stages instead of publishing on approval with --staged, and stops at a draft with --upload-only', async () => {
  let { calls, fetch } = store({
    fetchStatus: [json(published('1.0.6'))],
    upload: [json({ uploadState: 'SUCCEEDED', crxVersion: '1.0.7' })],
    publish: [json({ state: 'PENDING_REVIEW' })]
  });
  await run(fetch, { staged: true });
  assert.deepEqual(JSON.parse(calls.at(-1).body), { publishType: 'STAGED_PUBLISH' });

  ({ calls, fetch } = store({
    fetchStatus: [json(published('1.0.6'))],
    upload: [json({ uploadState: 'SUCCEEDED', crxVersion: '1.0.7' })]
  }));
  assert.deepEqual(await run(fetch, { uploadOnly: true }), { version: '1.0.7', state: 'DRAFT' });
  assert.deepEqual(calls.map((c) => c.action), ['fetchStatus', 'upload']);
});

test('refuses a version the store already has, before uploading', async () => {
  const { calls, fetch } = store({ fetchStatus: [json(published('1.0.7'))] });
  await assert.rejects(run(fetch), /already has 1\.0\.7/);
  assert.equal(calls.length, 1);
});

test('leaves a submission in review alone unless told to replace it', async () => {
  const inReview = () => json({
    ...published('1.0.5'),
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.6' }] }
  });
  let { calls, fetch } = store({ fetchStatus: [inReview()] });
  await assert.rejects(run(fetch), /still in review/);
  assert.equal(calls.length, 1);

  ({ calls, fetch } = store({
    fetchStatus: [inReview()],
    cancelSubmission: [json({})],
    upload: [json({ uploadState: 'SUCCEEDED', crxVersion: '1.0.7' })],
    publish: [json({ state: 'PENDING_REVIEW' })]
  }));
  await run(fetch, { cancelPending: true });
  assert.deepEqual(calls.map((c) => c.action), ['fetchStatus', 'cancelSubmission', 'upload', 'publish']);
});

test('fails on a failed upload or a rejected submission, though the API answers 200', async () => {
  let { calls, fetch } = store({
    fetchStatus: [json(published('1.0.6')), json({ lastAsyncUploadState: 'FAILED' })],
    upload: [json({ uploadState: 'IN_PROGRESS' })]
  });
  await assert.rejects(run(fetch), /upload ended as FAILED/);
  assert.ok(!calls.some((c) => c.action === 'publish'));

  ({ fetch } = store({
    fetchStatus: [json(published('1.0.6'))],
    upload: [json({ uploadState: 'SUCCEEDED', crxVersion: '1.0.7' })],
    publish: [json({ state: 'REJECTED' })]
  }));
  await assert.rejects(run(fetch), /came back REJECTED/);
});

test('gives up on an upload that never finishes processing', async () => {
  const { fetch } = store({
    fetchStatus: [json(published('1.0.6')), ...Array.from({ length: 3 }, () => json({ lastAsyncUploadState: 'IN_PROGRESS' }))],
    upload: [json({ uploadState: 'IN_PROGRESS' })]
  });
  await assert.rejects(run(fetch, { pollMs: 1, pollLimitMs: 3 }), /still processing/);
});

test('explains access errors', async () => {
  const { fetch } = store({ fetchStatus: [json({ error: { code: 404, message: 'Item not found.' } }, 404)] });
  await assert.rejects(run(fetch), /fetchStatus failed \(404\): Item not found\..*first version was uploaded there by hand/);
});
