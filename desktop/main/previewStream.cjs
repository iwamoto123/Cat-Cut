"use strict";

const fs = require("fs");
const { pipeline } = require("stream");

/**
 * シーク等でHTTP受信が中断されたらファイル読出しも閉じる。
 * pipeだけでは送信元がpause状態で残り、ファイルディスクリプタが解放されない。
 * ステータスとヘッダは呼出元が決める。送信後の読出しエラーは接続を終了する。
 */
function pipePreviewFile(filePath, response, options) {
  const source = fs.createReadStream(filePath, options);
  // pipelineは正常終了・受信側中断・読出し失敗の全経路で双方のstreamを片付ける。
  // 中断は動画シークの通常動作なので、callbackでは追加のエラー応答を送らない。
  pipeline(source, response, () => {});
  return source;
}

module.exports = { pipePreviewFile };
