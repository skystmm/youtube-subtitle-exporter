const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cuesFromJson,
  extractBvid,
  normalizeSubtitleUrl,
  normalizeTracks,
  selectPage,
  selectPreferredTrack,
  transcriptToText
} = require("../bilibili-transcript.js");

test("extracts a Bilibili bvid from a standard video path", () => {
  assert.equal(extractBvid("/video/BV1xx411c7mD/"), "BV1xx411c7mD");
  assert.equal(extractBvid("/bangumi/play/ep123"), null);
});

test("selects the current multi-part video page", () => {
  const video = { pages: [{ page: 1, cid: 11 }, { page: 2, cid: 22 }] };
  assert.equal(selectPage(video, 2).cid, 22);
  assert.equal(selectPage(video, 99).cid, 11);
});

test("normalizes Bilibili subtitle tracks and protocol-relative URLs", () => {
  const tracks = normalizeTracks({ subtitle: { subtitles: [
    { id: 1, lan: "zh-CN", lan_doc: "中文（自动生成）", subtitle_url: "//aisubtitle.hdslb.com/a.json" }
  ] } });
  assert.deepEqual(tracks, [{
    id: 1,
    languageCode: "zh-CN",
    name: "中文（自动生成）",
    url: "https://aisubtitle.hdslb.com/a.json"
  }]);
  assert.equal(normalizeSubtitleUrl("/relative.json"), "https://www.bilibili.com/relative.json");
});

test("parses timed Bilibili subtitle cues", () => {
  assert.deepEqual(cuesFromJson({ body: [
    { from: 1.25, to: 3.5, content: " 第一  行 " },
    { from: 4, to: 5, content: "" }
  ] }), [{ startMs: 1250, endMs: 3500, text: "第一 行" }]);
});

test("prefers a track matching the browser language and creates plain text", () => {
  const tracks = [
    { languageCode: "en-US", name: "English" },
    { languageCode: "zh-CN", name: "中文" }
  ];
  assert.equal(selectPreferredTrack(tracks, "zh-TW"), tracks[1]);
  assert.equal(transcriptToText([{ text: "一" }, { text: "二" }]), "一\n二");
});
