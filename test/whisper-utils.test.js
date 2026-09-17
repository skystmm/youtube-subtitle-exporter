const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanWhisperText,
  WHISPER_GENERATION_OPTIONS,
  WHISPER_MODEL_IDS
} = require("../whisper-utils.js");

test("removes a pathological repeated Chinese phrase without losing its context", () => {
  const source = `七年山，在这儿${"在这儿".repeat(40)}，他十八岁深入漠南。`;

  assert.equal(cleanWhisperText(source), "七年山，在这儿，他十八岁深入漠南。");
});

test("removes a pathological repeated word sequence", () => {
  const source = `The army moved forward ${"on the road ".repeat(16)}before dawn.`;

  assert.equal(cleanWhisperText(source), "The army moved forward on the road before dawn.");
});

test("removes long single-character and punctuated decoder loops", () => {
  assert.equal(cleanWhisperText(`战果${"万".repeat(100)}，归营。`), "战果万，归营。");
  assert.equal(cleanWhisperText(`随后${"在这里面，".repeat(60)}故事继续。`), "随后在这里面，故事继续。");
});

test("preserves intentional short emphasis", () => {
  assert.equal(cleanWhisperText("这件事非常非常重要。"), "这件事非常非常重要。");
  assert.equal(cleanWhisperText("好好好，我们继续。"), "好好好，我们继续。");
});

test("does not apply generic text-generation penalties to Whisper decoding", () => {
  assert.equal(WHISPER_GENERATION_OPTIONS.no_repeat_ngram_size, undefined);
  assert.equal(WHISPER_GENERATION_OPTIONS.repetition_penalty, undefined);
});

test("prefers the more accurate Base model and keeps Tiny as a network fallback", () => {
  assert.deepEqual(WHISPER_MODEL_IDS, [
    "Xenova/whisper-base",
    "Xenova/whisper-tiny"
  ]);
});
