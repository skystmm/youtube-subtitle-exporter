function cleanWhisperText(text) {
  let cleaned = String(text || "").trim();
  const repeatedCharacter = /(.)\1{7,}/gu;
  const repeatedPhrase = /(.{2,24}?)(?:\1){3,}/gu;

  // Whisper can get stuck emitting the same short phrase until the current
  // decoding window ends. Four consecutive copies are treated as a decoder
  // loop; ordinary emphasis such as “非常非常” is deliberately preserved.
  for (let pass = 0; pass < 4; pass += 1) {
    const next = cleaned
      .replace(repeatedCharacter, "$1")
      .replace(repeatedPhrase, "$1");
    if (next === cleaned) break;
    cleaned = next;
  }

  return cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/ +([，。！？；：,.!?;:])/gu, "$1")
    .trim();
}

// Generic language-model repetition penalties are intentionally omitted.
// Whisper uses ordinary repeated n-grams in Chinese, so banning them can make
// a decoding window skip valid speech. Pathological loops are cleaned only
// after transcription, where the surrounding text remains intact.
const WHISPER_GENERATION_OPTIONS = Object.freeze({});

const WHISPER_MODEL_IDS = Object.freeze([
  "Xenova/whisper-base",
  "Xenova/whisper-tiny"
]);

module.exports = {
  cleanWhisperText,
  WHISPER_GENERATION_OPTIONS,
  WHISPER_MODEL_IDS
};
