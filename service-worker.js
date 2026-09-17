const OFFSCREEN_PATH = "offscreen.html";
let creatingOffscreen;
let activeTabId;

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["USER_MEDIA", "BLOBS"],
        justification: "获取本机助手音频或捕获标签页音频，并在本地执行 Whisper 转写"
      })
      .finally(() => {
        creatingOffscreen = undefined;
      });
  }
  await creatingOffscreen;
}

async function readPageMetadata(tabId, metadata = {}) {
  if (metadata?.language) return metadata;
  try {
    const settings = await chrome.tabs.sendMessage(tabId, { type: "REQUEST_WHISPER_SETTINGS" });
    return settings?.metadata || metadata;
  } catch (_) {
    return metadata;
  }
}

async function startFastTranscription(tabId, metadata = {}, defaultMode = "fast") {
  if (!tabId) throw new Error("找不到当前 YouTube 标签页");
  if (activeTabId) throw new Error("已有本地识别任务正在运行");
  metadata = await readPageMetadata(tabId, metadata);
  metadata.transcriptionMode ||= defaultMode;
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_FAST_TRANSCRIPTION",
    tabId,
    metadata
  });
  if (!response?.ok) throw new Error(response?.error || "无法启动快速转写");
  activeTabId = tabId;
  return { ok: true, metadata };
}

async function startCapture(tabId, metadata = {}) {
  if (!tabId) throw new Error("找不到当前 YouTube 标签页");
  if (activeTabId) throw new Error("已有本地识别任务正在运行");

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  metadata = await readPageMetadata(tabId, metadata);
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "START_CAPTURE",
    tabId,
    streamId,
    metadata
  });
  if (!response?.ok) throw new Error(response?.error || "无法启动标签页录音");
  activeTabId = tabId;
  return { ok: true };
}

async function sendToTab(tabId, message) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    // The tab may have navigated or closed while transcription was running.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  if (message?.type === "START_LOCAL_WHISPER") {
    startCapture(sender.tab?.id, message.metadata)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "START_FAST_WHISPER") {
    startFastTranscription(sender.tab?.id, message.metadata)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "STOP_LOCAL_WHISPER" || message?.type === "CANCEL_LOCAL_WHISPER") {
    chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: message.type === "STOP_LOCAL_WHISPER" ? "STOP_CAPTURE" : "CANCEL_CAPTURE"
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "CANCEL_FAST_WHISPER") {
    chrome.runtime
      .sendMessage({ target: "offscreen", type: "CANCEL_FAST_TRANSCRIPTION" })
      .then((response) => {
        if (response?.ok) activeTabId = undefined;
        sendResponse(response);
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.source === "offscreen") {
    const tabId = message.tabId || activeTabId;
    sendToTab(tabId, message);
    if (message.type === "WHISPER_COMPLETE" || message.type === "WHISPER_ERROR" || message.type === "WHISPER_CANCELLED") {
      activeTabId = undefined;
    }
  }
  return false;
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab.url?.startsWith("https://www.youtube.com/watch")) return;
  startFastTranscription(tab.id, {}, "accurate")
    .then((result) => sendToTab(tab.id, {
      type: "WHISPER_FAST_STARTED",
      source: "background",
      metadata: result.metadata
    }))
    .catch((error) => sendToTab(tab.id, { type: "WHISPER_ERROR", source: "background", error: error.message }));
});
