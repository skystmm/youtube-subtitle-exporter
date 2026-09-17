const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cuesFromJson3,
  json3Url,
  resolveWhisperLanguage,
  safeFilename,
  selectPreferredTrack,
  transcriptToText
} = require("../transcript.js");

test("extracts text cues from YouTube json3 data", () => {
  const cues = cuesFromJson3({
    events: [
      { tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: " world" }] },
      { tStartMs: 1200, segs: [{ utf8: "Next  line" }] },
      { tStartMs: 2000 }
    ]
  });

  assert.deepEqual(cues, [
    { startMs: 0, text: "Hello world" },
    { startMs: 1200, text: "Next line" }
  ]);
});

test("resolves a manually selected Whisper language", () => {
  assert.equal(resolveWhisperLanguage("ja", "zh-CN", "中文标题"), "ja");
});

test("uses YouTube audio metadata for automatic language selection", () => {
  assert.equal(resolveWhisperLanguage("auto", "es-MX", "An English title"), "es");
});

test("infers an automatic language from the video title when metadata is missing", () => {
  assert.equal(resolveWhisperLanguage("auto", "", "卫青的一生"), "zh");
  assert.equal(resolveWhisperLanguage("auto", "", "歴史を学ぶ"), "ja");
  assert.equal(resolveWhisperLanguage("auto", "", "한국 역사"), "ko");
  assert.equal(resolveWhisperLanguage("auto", "", "A history lesson"), "en");
});

test("removes duplicate rolling auto-caption lines", () => {
  const text = transcriptToText([
    { startMs: 0, text: "This is" },
    { startMs: 300, text: "This is a test" },
    { startMs: 900, text: "This is a test" },
    { startMs: 1400, text: "Next sentence" }
  ]);

  assert.equal(text, "This is a test\nNext sentence");
});

test("creates a safe TXT filename", () => {
  assert.equal(safeFilename('A: video / "demo"', "zh-Hans"), "A_ video _ _demo_ [zh-Hans].txt");
});

test("requests the json3 subtitle format without losing signed parameters", () => {
  const result = new URL(json3Url("https://www.youtube.com/api/timedtext?v=abc&sig=123"));
  assert.equal(result.searchParams.get("v"), "abc");
  assert.equal(result.searchParams.get("sig"), "123");
  assert.equal(result.searchParams.get("fmt"), "json3");
});

test("selects one-click subtitles by UI language, then audio language", () => {
  const tracks = [
    { languageCode: "en", kind: "asr", name: "English" },
    { languageCode: "zh-Hans", kind: "asr", name: "中文（自动生成）" },
    { languageCode: "zh-Hant", name: "繁體中文" },
    { languageCode: "ja", name: "日本語" }
  ];

  assert.equal(selectPreferredTrack(tracks, "zh-CN", "ja"), tracks[2]);
  assert.equal(selectPreferredTrack(tracks, "fr-FR", "ja"), tracks[3]);
  assert.equal(selectPreferredTrack(tracks, "fr-FR", "de"), tracks[0]);
});

test("returns null when no subtitle track is available", () => {
  assert.equal(selectPreferredTrack([], "zh-CN", "zh"), null);
});
