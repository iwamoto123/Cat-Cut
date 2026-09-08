import test from 'node:test';
import assert from 'node:assert/strict';
import { rebaseHighlightWords, setHighlightRange, highlightMaskFromWords } from '../src/lib/telopHighlightEdit.ts';
import { buildHighlightMasksForLines } from '../src/lib/telopTypography.ts';
import { initializeScenes, setSceneTelopText, setSceneDirectedHighlightWords, replaceTelopOccurrences, deriveKeepSegments } from '../src/lib/scenes.ts';
import { deriveDirectedSlots } from '../src/lib/directedTelop.ts';
import { filterHighlightWords } from '../src/lib/previewTelop.ts';
import { createProjectEditor } from '../src/lib/projectEditor.ts';

for (const [label, before, after, words, expected] of [
  ['replace inside a colored phrase', '費用は三万円です', '費用は五万円です', ['三万円'], ['五万円']],
  ['insert inside a colored phrase', '重要な確認事項です', '重要な確認・検証事項です', ['確認事項'], ['確認・検証事項']],
  ['remove part of a colored phrase', '確認と検証を実施', '確認を実施', ['確認と検証'], ['確認']],
  ['keep unrelated highlights through multiple replacements', '赤と青、終わり', '朱と紺、終わり！', ['赤', '終わり'], ['朱', '終わり！']],
  ['plain replacements remain plain', '費用と説明', '価格と説明', ['説明'], ['説明']],
  ['mixed selection replacement remains plain', '赤白', '青緑', ['赤'], []],
  ['replace highlighted selection across a legacy line break', '確認\n事項です', '操作手順です', ['確認', '事項'], ['操作手順']],
  ['replace plain line break does not invent a color', '本文\n説明', '本文と説明', ['説明'], ['説明']],
  ['empty text removes its highlights', '確認事項', '', ['確認事項'], []],
  ['Unicode code points survive replacement', '✅朝🌅です', '✅夜🌙です', ['朝🌅'], ['夜🌙']],
  ['hard line break preserves both colored fragments', '重要な確認事項です', '重要な確認\n事項です', ['確認事項'], ['確認事項']],
  ['remove line break joins colored fragments', '重要な確認\n事項です', '重要な確認事項です', ['確認', '事項'], ['確認事項']],
  ['legacy newline-spanning word is normalized', '重要な確認\n事項です', '重要な確認\n事項です', ['確認事項'], ['確認事項']],
] as Array<[string, string, string, string[], string[]]>) {
  test(`text colors: ${label}`, () => {
    assert.deepEqual(rebaseHighlightWords(before, after, words), expected);
  });
}

test('painting a multiline selection preserves a complete phrase across the break', () => {
  assert.deepEqual(setHighlightRange('あ\nいう', [], 0, 4, true), ['あいう']);
  assert.deepEqual(highlightMaskFromWords('確認\n事項', ['確認事項']), [true, true, true, true, true]);
});

test('long paste has bounded alignment cost and keeps unchanged suffix color', () => {
  const before = 'あ'.repeat(1200) + '重要';
  const after = 'い'.repeat(1500) + '重要';
  assert.deepEqual(rebaseHighlightWords(before, after, ['重要']), ['重要']);
});

test('preview and rendered lines keep a phrase colored across soft/hard wraps and emoji', () => {
  assert.deepEqual(buildHighlightMasksForLines(['確認', '事項です'], ['確認事項']), [[true, true], [true, true, false, false]]);
  assert.deepEqual(buildHighlightMasksForLines(['A🌅', '終わり'], ['🌅\n終']), [[false, true], [true, false, false]]);
  assert.deepEqual(filterHighlightWords(['確認事項', '不在', '\n'], '確認\n事項です'), ['確認事項']);
});

function fixture() {
  return initializeScenes({
    words: [{ id: 'w1', text: '費用は三万円です', startMs: 0, endMs: 2000 }],
    keepSegments: [{ startMs: 0, endMs: 2000 }],
    telopPageBoundaries: [{ startMs: 0, endMs: 2000, text: '費用は三万円です', styleId: 'fact_yellow', highlightWords: ['三万円'] }],
  }).map((scene) => ({ ...scene, styleOverrideId: 'pop_normal', directedStyleId: 'fact_yellow', sourceKeepRanges: [{ startMs: 0, endMs: 1000 }, { startMs: 1500, endMs: 2000 }] }));
}

test('edit, newline, JSON save/reload, directed export and Undo preserve color/style/cuts', () => {
  const editor = createProjectEditor();
  const original = fixture();
  editor.hydrate('/synthetic/color', { scenes: original, images: null, bgm: null });
  editor.setScenes((scenes) => setSceneTelopText(scenes, scenes[0].id, '費用は五万\n円です'));
  const edited = editor.getSnapshot().document;
  assert.deepEqual(edited.scenes[0].directedHighlightWords, ['五万円']);
  assert.equal(edited.scenes[0].styleOverrideId, original[0].styleOverrideId);
  assert.equal(edited.scenes[0].directedStyleId, original[0].directedStyleId);
  assert.deepEqual(deriveKeepSegments(edited.scenes), deriveKeepSegments(original));
  editor.undo();
  assert.deepEqual(editor.getSnapshot().document.scenes, original);
  editor.redo();
  const saved = JSON.parse(JSON.stringify(editor.getSnapshot().document));
  const reopened = createProjectEditor();
  reopened.hydrate('/synthetic/color', saved);
  const slot = deriveDirectedSlots(reopened.getSnapshot().document.scenes)[0];
  assert.equal(slot.text, '費用は五万\n円です');
  assert.deepEqual(slot.highlightWords, ['五万円']);
  assert.equal(slot.styleId, 'fact_yellow');
  assert.deepEqual(buildHighlightMasksForLines(slot.text.split('\n'), slot.highlightWords), [[false, false, false, true, true], [true, false, false]]);
});

test('explicit white removes color; bulk proofreading carries replaced phrase color', () => {
  const original = fixture();
  const bulk = replaceTelopOccurrences(original, '三万円', '五千円', [{ sceneId: original[0].id, occurrenceIndex: 0 }]);
  assert.deepEqual(bulk[0].directedHighlightWords, ['五千円']);
  assert.deepEqual(setSceneDirectedHighlightWords(bulk, bulk[0].id, [])[0].directedHighlightWords, undefined);
});

test('newline inside a highlight does not color identical short fragments elsewhere', () => {
  const before = '確認事項と事項の説明';
  const after = '確認\n事項と事項の説明';
  const words = rebaseHighlightWords(before, after, ['確認事項']);
  assert.deepEqual(words, ['確認事項']);
  assert.deepEqual(highlightMaskFromWords(after, words), [true, true, true, true, true, false, false, false, false, false, false]);
});
