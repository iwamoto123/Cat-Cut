import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const source = fs.readFileSync(new URL('../../distribution/install.command', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('is_older_build() {'), source.indexOf('\nNEW_VERSION='));
for (const [newVersion, oldVersion, older] of [
  ['20261003-background-export', '20261003-segment-video-validation', false],
  ['20261003-173400-installer-version-order', '20261003-segment-video-validation', false],
  ['20261002-fix', '20261003-fix', true],
  ['20261004-fix', '20261003-fix', false],
  ['20261003-110000-z', '20261003-120000-a', true],
  ['20261003-130000-a', '20261003-120000-z', false],
  ['20261003-120000-a', '20261003-120000-z', false],
  ['', '20261003-fix', false],
] as const) {
  test(`installer ordering: ${newVersion} vs ${oldVersion}`, () => {
    const result = spawnSync('/bin/bash', ['-c', fn + '\nis_older_build "$1" "$2"', 'test', newVersion, oldVersion]);
    assert.equal(result.status, older ? 0 : 1, result.stderr.toString());
  });
}
