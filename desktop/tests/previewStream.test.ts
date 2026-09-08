import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

const require = createRequire(import.meta.url);
const { pipePreviewFile } = require("../main/previewStream.cjs");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catcut-preview-stream-"));
  const file = path.join(dir, "video.mp4");
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  fs.writeFileSync(file, bytes);
  return { dir, file, bytes };
}

function collectingResponse() {
  const chunks: Buffer[] = [];
  return {
    chunks,
    response: new Writable({
      write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    }),
  };
}

test("プレビュー配信: 正常終了で全バイトを送りファイルを閉じる", async () => {
  const { dir, file, bytes } = fixture();
  try {
    const { response, chunks } = collectingResponse();
    const source = pipePreviewFile(file, response);
    await Promise.all([finished(source), finished(response)]);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.equal(source.closed, true);
    assert.equal(source.fd, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("プレビュー配信: Rangeの始終点を含む指定バイトだけ送る", async () => {
  const { dir, file, bytes } = fixture();
  try {
    const { response, chunks } = collectingResponse();
    const source = pipePreviewFile(file, response, { start: 17, end: 92 });
    await Promise.all([finished(source), finished(response)]);
    assert.deepEqual(Buffer.concat(chunks), bytes.subarray(17, 93));
    assert.equal(source.bytesRead, 76);
    assert.equal(source.closed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("プレビュー配信: シークによる受信側中断で読出しstreamとFDも閉じる", { timeout: 2000 }, async () => {
  const { dir, file } = fixture();
  try {
    const fileSize = 2 * 1024 * 1024;
    fs.writeFileSync(file, Buffer.alloc(fileSize));
    const response = new Writable({
      write(_chunk, _encoding, callback) { this.destroy(); callback(); },
    });
    const source = pipePreviewFile(file, response);
    await Promise.allSettled([finished(source), finished(response)]);
    assert.equal(source.destroyed, true);
    assert.equal(source.closed, true);
    assert.equal(source.fd, null);
    assert.ok(source.bytesRead < fileSize, "中断後に残りの全動画を読まない");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("プレビュー配信: 読出し失敗も捕捉して受信側を終了する", { timeout: 2000 }, async () => {
  const { dir } = fixture();
  try {
    const { response, chunks } = collectingResponse();
    const source = pipePreviewFile(path.join(dir, "missing.mp4"), response);
    const results = await Promise.allSettled([finished(source), finished(response)]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "rejected");
    assert.equal(source.closed, true);
    assert.equal(response.destroyed, true);
    assert.deepEqual(chunks, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
