import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { read, repoRoot } from './local-debug-stack-helpers.mjs';

test('remote development launcher binds the IAP tunnel and desktop to one verified lifecycle', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kordi-remote-dev-test-'));
  const binDir = join(tempRoot, 'bin');
  const allowlistPath = join(tempRoot, 'operator-github-allowlist.txt');
  const tunnelReadyPath = join(tempRoot, 'tunnel-ready');
  const tunnelAttemptPath = join(tempRoot, 'tunnel-attempt');
  const desktopStartedPath = join(tempRoot, 'desktop-started');
  const gcloudCapturePath = join(tempRoot, 'gcloud.txt');
  const desktopCapturePath = join(tempRoot, 'desktop.txt');
  const scriptPath = join(repoRoot, 'scripts', 'dev-cloud-remote.sh');
  try {
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$TEST_GITHUB_LOGIN"\n');
    writeFileSync(
      join(binDir, 'gcloud'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" > "$TEST_GCLOUD_CAPTURE"\n: > "$TEST_TUNNEL_READY"\nif [[ -n "${TEST_TUNNEL_ATTEMPT_FILE:-}" ]]; then\n  attempt=1\n  if [[ -f "$TEST_TUNNEL_ATTEMPT_FILE" ]]; then attempt=$(( $(cat "$TEST_TUNNEL_ATTEMPT_FILE") + 1 )); fi\n  printf \'%s\\n\' "$attempt" > "$TEST_TUNNEL_ATTEMPT_FILE"\n  if (( attempt == 1 )); then\n    for _wait in $(seq 1 80); do\n      [[ -f "$TEST_DESKTOP_STARTED" ]] && break\n      sleep 0.1\n    done\n    rm -f "$TEST_TUNNEL_READY"; exit 255\n  fi\nfi\ntrap \'exit 0\' TERM INT\nwhile true; do sleep 1; done\n',
    );
    writeFileSync(
      join(binDir, 'curl'),
      '#!/usr/bin/env bash\nurl="${@: -1}"\n[[ -f "$TEST_TUNNEL_READY" ]] || exit 7\ncase "$url" in\n  */health) printf \'{"ok":true,"server":"kordi-cloud"}\\n\' ;;\n  */v1/cloud/auth/capabilities) [[ -z "${KORDI_DEV_PREVIEW_PATH:-}" ]] || exit 22; printf \'{"password":true,"oauthProviders":["google","github"]}\\n\' ;;\n  *) exit 22 ;;\nesac\n',
    );
    writeFileSync(
      join(binDir, 'pnpm'),
      '#!/usr/bin/env bash\nif [[ -n "${TEST_TUNNEL_ATTEMPT_FILE:-}" ]]; then\n  : > "$TEST_DESKTOP_STARTED"\n  for _attempt in $(seq 1 80); do\n    if [[ -f "$TEST_TUNNEL_ATTEMPT_FILE" ]] && (( $(cat "$TEST_TUNNEL_ATTEMPT_FILE") >= 2 )); then break; fi\n    sleep 0.1\n  done\nfi\nprintf \'%s\\n\' "$*|$VITE_KORDI_CLOUD_API_BASE|$VITE_KORDI_DEV_PROFILE|${DATABASE_URL:-}|${KORDI_OAUTH_GOOGLE_CLIENT_SECRET:-}|${KORDI_CLOUD_GCP_PROJECT:-}|$VITE_KORDI_ENABLE_LOOPBACK_REALTIME" > "$TEST_DESKTOP_CAPTURE"\n',
    );
    writeFileSync(
      join(binDir, 'nc'),
      '#!/usr/bin/env bash\n[[ -f "$TEST_TUNNEL_READY" ]]\n',
    );
    // OAuth HTTP/state behavior is covered by check-dev-oauth.test.mjs; this fixture owns process lifecycles.
    writeFileSync(join(binDir, 'node'), '#!/usr/bin/env bash\n[[ "$1" == */check-dev-oauth.mjs && "$2" == --api-base && "$3" == http://127.0.0.1:17081 ]] || exit 2\nprintf "fixture OAuth preflight verified\\n"\n');
    for (const command of ['gh', 'gcloud', 'curl', 'pnpm', 'nc', 'node']) {
      chmodSync(join(binDir, command), 0o755);
    }
    writeFileSync(allowlistPath, 'example-maintainer\n');

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      KORDI_REMOTE_DEV_GITHUB_ALLOWLIST_FILE: allowlistPath,
      KORDI_DEV_GCP_PROJECT: 'example-project',
      KORDI_DEV_SSH_ZONE: 'example-zone',
      KORDI_DEV_SSH_TARGET: 'example-user@example-instance',
      KORDI_DEV_DESKTOP_PROFILE: 'remote-isolated',
      KORDI_DEV_FRONTEND_MODE: 'production',
      KORDI_DEV_DESKTOP_TITLE: 'Kordi Remote Dev',
      KORDI_DEV_DESKTOP_PORT: '1498',
      TEST_GITHUB_LOGIN: 'example-maintainer',
      TEST_TUNNEL_READY: tunnelReadyPath,
      TEST_DESKTOP_STARTED: desktopStartedPath,
      TEST_GCLOUD_CAPTURE: gcloudCapturePath,
      TEST_DESKTOP_CAPTURE: desktopCapturePath,
      DATABASE_URL: 'postgresql://must-not-reach-desktop',
      KORDI_OAUTH_GOOGLE_CLIENT_SECRET: 'must-not-reach-desktop',
      KORDI_CLOUD_GCP_PROJECT: 'must-not-reach-desktop',
    };
    const launched = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(launched.status, 0, launched.stderr);
    const gcloudArgs = readFileSync(gcloudCapturePath, 'utf8');
    assert.match(gcloudArgs, /compute ssh example-user@example-instance/);
    assert.match(gcloudArgs, /--project example-project/);
    assert.match(gcloudArgs, /--zone example-zone/);
    assert.match(gcloudArgs, /--tunnel-through-iap/);
    assert.match(gcloudArgs, /-L 127\.0\.0\.1:17081:127\.0\.0\.1:17081/);
    assert.equal(
      readFileSync(desktopCapturePath, 'utf8').trim(),
      'dev:desktop:profile -- --profile remote-isolated --title Kordi Remote Dev --frontend production --port 1498|http://127.0.0.1:17081|community||||1',
    );
    assert.match(launched.stdout, /Verified Google and GitHub OAuth/);
    assert.match(launched.stdout, /fixture OAuth preflight verified/);

    rmSync(tunnelReadyPath);
    const previewLaunched = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: { ...env, KORDI_DEV_PREVIEW_PATH: '/tests/visual/groupMentionPreview.html' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(previewLaunched.status, 0, previewLaunched.stderr);
    assert.match(previewLaunched.stdout, /login-free fixture preview/);

    rmSync(tunnelReadyPath);
    // Drop the fixture tunnel only after startup so this tests reconnection, not an initial health-check race.
    const recovered = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: { ...env, TEST_TUNNEL_ATTEMPT_FILE: tunnelAttemptPath },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /The IAP tunnel exited; reconnecting/);
    assert.ok(Number(readFileSync(tunnelAttemptPath, 'utf8')) >= 2);

    rmSync(tunnelReadyPath);
    const mediaLaunched = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: {
        ...env,
        KORDI_DEV_LOCAL_SIGNALING_PORT: '17880',
        KORDI_DEV_REMOTE_SIGNALING_PORT: '7880',
        KORDI_DEV_LOCAL_ICE_TCP_PORT: '17881',
        KORDI_DEV_REMOTE_ICE_TCP_PORT: '17881',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(mediaLaunched.status, 0, mediaLaunched.stderr);
    const mediaGcloudArgs = readFileSync(gcloudCapturePath, 'utf8');
    assert.match(mediaGcloudArgs, /-L 127\.0\.0\.1:17880:127\.0\.0\.1:7880/);
    assert.match(mediaGcloudArgs, /-L 127\.0\.0\.1:17881:127\.0\.0\.1:17881/);
    assert.match(mediaLaunched.stdout, /Verified API, OAuth, signaling, and ICE\/TCP/);

    const mismatchedIce = spawnSync('bash', [scriptPath], {
      cwd: repoRoot,
      env: {
        ...env,
        KORDI_DEV_LOCAL_SIGNALING_PORT: '17880',
        KORDI_DEV_REMOTE_SIGNALING_PORT: '7880',
        KORDI_DEV_LOCAL_ICE_TCP_PORT: '17882',
        KORDI_DEV_REMOTE_ICE_TCP_PORT: '17881',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(mismatchedIce.status, 0);
    assert.match(mismatchedIce.stderr, /must match the advertised loopback candidate/);

    const packageJson = read('package.json');
    const guide = read('docs/development-environments.md');
    assert.match(packageJson, /"dev:cloud:remote": "bash scripts\/dev-cloud-remote\.sh"/);
    assert.match(guide, /pnpm dev:cloud:remote/);
    assert.match(guide, /KORDI_DEV_GCP_PROJECT="<DEV_GCP_PROJECT>"/);
    assert.doesNotMatch(guide, /example-project|example-instance/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
