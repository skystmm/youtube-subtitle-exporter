importScripts("helper-launch.js", "video-site.js");

const OFFSCREEN_PATH = "offscreen.html";
const LOCAL_HELPER_URL = "http://127.0.0.1:43127/health";
const NATIVE_HOST_NAME = "com.skystmm.video_subtitle_helper";
let creatingOffscreen;
let activeTabId;

async function checkLocalHelperHealth() {
  try {
    const response = await fetch(LOCAL_HELPER_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(800)
    });
    return response.ok;
  } catch (_) {
    return false;
  }
}

async function ensureLocalHelperRunning() {
  return HelperLauncher.ensureLocalHelper({
    checkHealth: checkLocalHelperHealth,
    startNative: () => chrome.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      { action: "start" }
    ),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    extensionId: chrome.runtime.id
  });
}

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
  if (!tabId) throw new Error("找不到当前视频标签页");
  if (activeTabId) throw new Error("已有本地识别任务正在运行");
  await sendToTab(tabId, {
    type: "WHISPER_STATUS",
    source: "background",
    message: "正在检查并启动本地助手…"
  });
  await ensureLocalHelperRunning();
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
  if (!tabId) throw new Error("找不到当前视频标签页");
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

  if (message?.type === "BILIBILI_FETCH_JSON") {
    let requestUrl;
    try {
      requestUrl = new URL(message.url);
      const allowedHost = requestUrl.hostname === "api.bilibili.com" || requestUrl.hostname.endsWith(".hdslb.com");
      if (requestUrl.protocol !== "https:" || !allowedHost) throw new Error("不允许请求这个地址");
    } catch (error) {
      sendResponse({ ok: false, error: error.message || "字幕地址无效" });
      return false;
    }
    fetch(requestUrl, { credentials: "include", referrer: "https://www.bilibili.com/" })
      .then((response) => {
        if (!response.ok) throw new Error(`B 站接口请求失败 (${response.status})`);
        return response.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

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
  if (!VideoSite.getVideoPage(tab.url)) return;
  startFastTranscription(tab.id, {}, "accurate")
    .then((result) => sendToTab(tab.id, {
      type: "WHISPER_FAST_STARTED",
      source: "background",
      metadata: result.metadata
    }))
    .catch((error) => sendToTab(tab.id, { type: "WHISPER_ERROR", source: "background", error: error.message }));
});
