import { env, pipeline } from "@huggingface/transformers";
import {
  cleanWhisperText,
  WHISPER_GENERATION_OPTIONS,
  WHISPER_MODEL_IDS
} from "./whisper-utils.js";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
env.backends.onnx.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1);

const HELPER_URL = "http://127.0.0.1:43127";
let activeJob;
let transcriberPromise;

function report(tabId, type, details = {}) {
  chrome.runtime.sendMessage({ source: "offscreen", tabId, type, ...details });
}

function modelProgress(tabId, progress) {
  if (progress.status === "progress" && Number.isFinite(progress.progress)) {
    report(tabId, "WHISPER_STATUS", {
      message: `首次下载本地模型：${Math.round(progress.progress)}%`
    });
  } else if (progress.status === "ready") {
    report(tabId, "WHISPER_STATUS", { message: "模型已就绪，正在识别口播…" });
  }
}

function getTranscriber(tabId) {
  if (!transcriberPromise) {
    report(tabId, "WHISPER_STATUS", { message: "正在加载本地 Whisper 模型…" });
    transcriberPromise = (async () => {
      let baseError;
      for (const [index, modelId] of WHISPER_MODEL_IDS.entries()) {
        try {
          return await pipeline("automatic-speech-recognition", modelId, {
            device: "wasm",
            progress_callback: (progress) => modelProgress(tabId, progress)
          });
        } catch (error) {
          if (index === 0) {
            baseError = error;
            report(tabId, "WHISPER_STATUS", {
              message: "Base 模型下载失败，改用已缓存的 Tiny 模型…"
            });
            continue;
          }
          throw new Error(`本地模型加载失败：${error?.message || baseError?.message || "网络异常"}`);
        }
      }
      throw baseError || new Error("没有可用的 Whisper 模型");
    })().catch((error) => {
      transcriberPromise = undefined;
      throw error;
    });
  }
  return transcriberPromise;
}

async function startCapture({ tabId, streamId, metadata }) {
  if (activeJob) throw new Error("已有录音任务正在运行");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);

  const mimeType = ["audio/webm;codecs=opus", "audio/webm"]
    .find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.start(1000);
  activeJob = { kind: "capture", tabId, stream, audioContext, recorder, chunks, metadata, cancelled: false };
  report(tabId, "WHISPER_STATUS", { message: "正在录制视频音频…" });
}

function stopRecorder(job) {
  return new Promise((resolve) => {
    job.recorder.addEventListener("stop", resolve, { once: true });
    job.recorder.stop();
  });
}

async function transcribeEncodedAudio(job, encodedAudio) {
  report(job.tabId, "WHISPER_STATUS", { message: "正在解码音频…" });
  const decodeContext = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await decodeContext.decodeAudioData(encodedAudio);
  const mono = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const values = audioBuffer.getChannelData(channel);
    for (let index = 0; index < values.length; index += 1) {
      mono[index] += values[index] / audioBuffer.numberOfChannels;
    }
  }
  await decodeContext.close();

  const transcriber = await getTranscriber(job.tabId);
  if (job.cancelled) return;
  report(job.tabId, "WHISPER_STATUS", { message: "正在本地识别口播，长视频需要一些时间…" });
  const result = await transcriber(mono, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: job.metadata?.language || "zh",
    task: "transcribe",
    ...WHISPER_GENERATION_OPTIONS
  });
  if (job.cancelled) return;
  const rawText = String(result?.text || "").trim();
  const text = cleanWhisperText(rawText);
  if (!text) throw new Error("Whisper 没有识别出可导出的文字");
  if (text !== rawText) {
    report(job.tabId, "WHISPER_STATUS", { message: "已清理识别中的异常重复片段" });
  }
  report(job.tabId, "WHISPER_COMPLETE", { text, metadata: job.metadata });
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("已取消", "AbortError"));
    }, { once: true });
  });
}

async function helperFetch(path, options = {}) {
  try {
    return await fetch(`${HELPER_URL}${path}`, options);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new Error("本地助手未响应，请重新运行 install-helper.command，或查看本地助手日志");
  }
}

async function runFastTranscription(job) {
  try {
    const mode = job.metadata?.transcriptionMode === "accurate" ? "accurate" : "fast";
    report(job.tabId, "WHISPER_STATUS", { message: "正在连接本地助手…" });
    const createResponse = await helperFetch("/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: job.metadata?.url,
        mode,
        language: job.metadata?.language || "auto",
        title: job.metadata?.title || ""
      }),
      signal: job.controller.signal
    });
    const created = await createResponse.json();
    if (!createResponse.ok) throw new Error(created.error || "本地助手创建任务失败");
    job.helperJobId = created.id;

    while (!job.cancelled) {
      const statusResponse = await helperFetch(`/jobs/${job.helperJobId}`, {
        signal: job.controller.signal
      });
      const status = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(status.error || "无法读取下载进度");
      if (status.status === "error") throw new Error(status.error || "音频下载失败");
      if (status.status === "ready") break;
      report(job.tabId, "WHISPER_STATUS", {
        message: status.status === "transcribing"
          ? "正在用 Whisper large-v3 高精度识别；首次使用会下载模型…"
          : status.progress > 0
            ? `正在快速下载音频：${status.progress}%`
            : "正在快速下载并转换音频…"
      });
      await wait(800, job.controller.signal);
    }
    if (job.cancelled) return;

    if (mode === "accurate") {
      report(job.tabId, "WHISPER_STATUS", { message: "高精度识别完成，正在生成 TXT…" });
      const transcriptResponse = await helperFetch(`/jobs/${job.helperJobId}/transcript`, {
        signal: job.controller.signal
      });
      if (!transcriptResponse.ok) {
        const error = await transcriptResponse.json();
        throw new Error(error.error || "读取高精度文字稿失败");
      }
      const text = cleanWhisperText(await transcriptResponse.text());
      if (!text) throw new Error("Whisper 没有识别出可导出的文字");
      report(job.tabId, "WHISPER_COMPLETE", { text, metadata: job.metadata });
      return;
    }

    report(job.tabId, "WHISPER_STATUS", { message: "音频下载完成，正在读取…" });
    const audioResponse = await helperFetch(`/jobs/${job.helperJobId}/audio`, {
      signal: job.controller.signal
    });
    if (!audioResponse.ok) {
      const error = await audioResponse.json();
      throw new Error(error.error || "读取本地音频失败");
    }
    const encodedAudio = await audioResponse.arrayBuffer();
    await transcribeEncodedAudio(job, encodedAudio);
  } catch (error) {
    if (!job.cancelled && error?.name !== "AbortError") {
      report(job.tabId, "WHISPER_ERROR", { error: error.message || "快速本地转写失败" });
    }
  } finally {
    if (job.helperJobId) {
      fetch(`${HELPER_URL}/jobs/${job.helperJobId}`, { method: "DELETE" }).catch(() => {});
    }
    if (activeJob === job) activeJob = undefined;
  }
}

function startFastTranscription({ tabId, metadata }) {
  if (activeJob) throw new Error("已有本地识别任务正在运行");
  const job = {
    kind: "fast",
    tabId,
    metadata,
    controller: new AbortController(),
    helperJobId: undefined,
    cancelled: false
  };
  activeJob = job;
  runFastTranscription(job);
}

async function cancelFastTranscription() {
  const job = activeJob;
  if (!job || job.kind !== "fast") return { ok: false, error: "当前没有快速转写任务" };
  job.cancelled = true;
  job.controller.abort();
  if (job.helperJobId) {
    fetch(`${HELPER_URL}/jobs/${job.helperJobId}`, { method: "DELETE" }).catch(() => {});
  }
  activeJob = undefined;
  report(job.tabId, "WHISPER_CANCELLED");
  return { ok: true };
}

async function finishCapture(cancelled) {
  const job = activeJob;
  if (!job) return { ok: false, error: "当前没有录音任务" };
  activeJob = undefined;
  job.cancelled = cancelled;
  await stopRecorder(job);
  job.stream.getTracks().forEach((track) => track.stop());
  await job.audioContext.close();

  if (cancelled) {
    report(job.tabId, "WHISPER_CANCELLED");
    return { ok: true };
  }

  const blob = new Blob(job.chunks, { type: job.recorder.mimeType });
  blob.arrayBuffer().then((encodedAudio) => transcribeEncodedAudio(job, encodedAudio)).catch((error) => {
    report(job.tabId, "WHISPER_ERROR", { error: error.message || "本地识别失败" });
  });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  if (message.type === "START_CAPTURE") {
    startCapture(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "START_FAST_TRANSCRIPTION") {
    try {
      startFastTranscription(message);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }
  if (message.type === "CANCEL_FAST_TRANSCRIPTION") {
    cancelFastTranscription().then(sendResponse);
    return true;
  }
  if (message.type === "STOP_CAPTURE" || message.type === "CANCEL_CAPTURE") {
    finishCapture(message.type === "CANCEL_CAPTURE").then(sendResponse);
    return true;
  }
  return false;
});
