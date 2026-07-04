import test from "node:test";
import assert from "node:assert/strict";
import {
  findTelopOccurrencesInOtherScenes,
  replaceTelopOccurrences,
} from "../src/lib/telopOccurrences.ts";
import { initializeScenes, setSceneTelopText } from "../src/lib/scenes.ts";

function words(...entries: Array<[string, string, number, number]>) {
  return entries.map(([id, text, startMs, endMs]) => ({ id, text, startMs, endMs }));
}

test("findTelopOccurrencesInOtherScenes: 前後10文字の文脈とシーン番号を返す", () => {
  const scenes = initializeScenes({
    words: words(["w1", "あ", 0, 100], ["w2", "い", 500, 600]),
    keepSegments: [
      { startMs: 0, endMs: 100 },
      { startMs: 500, endMs: 600 },
    ],
  });
  const edited = setSceneTelopText(scenes, scenes[0].id, "もし難下が続く");
  const edited2 = setSceneTelopText(edited, scenes[1].id, "前後文脈テスト難化と難下の例");
  const occurrences = findTelopOccurrencesInOtherScenes(edited2, scenes[0].id, "難下");
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].sceneOrdinal, 2);
  assert.equal(occurrences[0].match, "難下");
  assert.match(occurrences[0].contextBefore, /難化と$/);
  assert.match(occurrences[0].contextAfter, /^の例/);
});

test("replaceTelopOccurrences: 同一シーン内の指定インデックスだけ置換する", () => {
  const sceneA = initializeScenes({
    words: words(["w1", "あ", 0, 100]),
    keepSegments: [{ startMs: 0, endMs: 100 }],
  });
  const sceneB = initializeScenes({
    words: words(["w2", "い", 500, 600]),
    keepSegments: [{ startMs: 500, endMs: 600 }],
  });
  const editedA = setSceneTelopText(sceneA, sceneA[0].id, "編集中シーン");
  const editedB = setSceneTelopText(sceneB, sceneB[0].id, "難下と難下の例");
  const merged = [...editedA, ...editedB];
  const occurrences = findTelopOccurrencesInOtherScenes(merged, editedA[0].id, "難下");
  assert.equal(occurrences.length, 2);
  const replaced = replaceTelopOccurrences(merged, "難下", "難化", [occurrences[1]]);
  assert.equal(replaced[1].telopText, "難下と難化の例", "2件目だけ置換");
});
