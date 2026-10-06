/**
 * PoliMi Webex Enhancer - Background Service Worker
 * Manages offline lecture downloading directly into extension IndexedDB,
 * network stream interception, tab creation, and native MP4 file downloads.
 */

try {
    importScripts("offline_db.js");
} catch (e) {
    console.warn("[Background] Failed to importScripts('offline_db.js'):", e);
}

try {
    importScripts("mediabunny.min.js");
} catch (e) {
    console.warn("[Background] Failed to importScripts('mediabunny.min.js'):", e);
}

// Cache captured stream URLs per tab (in-memory + session storage backup)
const capturedStreams = new Map();
// Cache captured separate audio-only stream URLs per tab
const capturedAudioStreams = new Map();
// Cache captured transcript / subtitle URLs per tab
const capturedTranscripts = new Map();

// Restore from chrome.storage.session on Service Worker wake-up (Bug 3.1)
if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get(null).then((items) => {
        if (!items) return;
        for (const [key, val] of Object.entries(items)) {
            if (key.startsWith("stream_")) {
                const tabId = parseInt(key.replace("stream_", ""), 10);
                if (!isNaN(tabId)) capturedStreams.set(tabId, val);
            } else if (key.startsWith("transcript_")) {
                const tabId = parseInt(key.replace("transcript_", ""), 10);
                if (!isNaN(tabId)) capturedTranscripts.set(tabId, val);
            }
        }
    }).catch(() => {});
}

// Clean test purge for v2.0.4: Wipes lectures and transcripts without touching API keys or email
if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["v204_db_cleaned"], (res) => {
        if (!res || !res.v204_db_cleaned) {
            if (self.WebexOfflineDB && typeof self.WebexOfflineDB.clearAllLecturesAndTranscripts === "function") {
                self.WebexOfflineDB.clearAllLecturesAndTranscripts().then(() => {
                    console.log("[Background] Local lectures & transcripts database cleanly purged for v2.0.4 test!");
                    chrome.storage.local.set({ v204_db_cleaned: true });
                }).catch((err) => {
                    console.warn("[Background] Failed to purge database:", err);
                });
            }
        }
    });
}

// Active background downloads (id -> { abortController, progress })
const activeDownloads = new Map();

// Intercept video stream, audio, and MP4 network requests
if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            const url = details.url;
            if (!url) return;
            const lower = url.toLowerCase();

            // Check if URL is strictly an audio-only stream (telephony or separate audio)
            const isAudioOnly = lower.includes(".mp3") || lower.includes(".m4a") || lower.includes(".wav") || lower.includes("/audio") || lower.includes("audio_only");
            if (isAudioOnly) {
                if (details.tabId && details.tabId >= 0) {
                    capturedAudioStreams.set(details.tabId, { url, timestamp: Date.now() });
                }
            } else if (url.includes(".mp4") || url.includes("/stream?") || url.includes("videoplayback") || url.includes("/medias/download") || url.includes("/recordingservice/") || url.includes("/webappng/api/")) {
                if (details.tabId && details.tabId >= 0) {
                    const data = {
                        url: url,
                        timestamp: Date.now()
                    };
                    capturedStreams.set(details.tabId, data);
                    if (chrome.storage && chrome.storage.session) {
                        chrome.storage.session.set({ [`stream_${details.tabId}`]: data }).catch(() => {});
                    }
                }
            }

            // Check if URL looks like a subtitle, captions or transcript request
            if (lower.includes(".vtt") || lower.includes(".srt") || lower.includes("transcript") || lower.includes("caption") || lower.includes("closedcaption") || lower.includes("subtitles") || lower.includes("texttrack")) {
                if (details.tabId && details.tabId >= 0) {
                    const data = {
                        url: url,
                        timestamp: Date.now()
                    };
                    capturedTranscripts.set(details.tabId, data);
                    if (chrome.storage && chrome.storage.session) {
                        chrome.storage.session.set({ [`transcript_${details.tabId}`]: data }).catch(() => {});
                    }
                }
            }
        },
        {
            urls: [
                "*://*.webex.com/*",
                "*://*.wbx2.com/*",
                "*://*.webexcontent.com/*",
                "*://polimi365.sharepoint.com/*",
                "*://*.sharepoint.com/*",
                "*://*.microsoftstream.com/*"
            ]
        }
    );
}

// Clean up closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
    capturedStreams.delete(tabId);
    capturedAudioStreams.delete(tabId);
    capturedTranscripts.delete(tabId);
    if (chrome.storage && chrome.storage.session) {
        chrome.storage.session.remove([`stream_${tabId}`, `transcript_${tabId}`]).catch(() => {});
    }
});

// Helper: Broadcast message to popup, offline player and relevant tabs
function broadcast(msg) {
    try {
        chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {}

    chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError || !tabs) return;
        tabs.forEach((tab) => {
            if (!tab.id || !tab.url) return;
            const u = tab.url.toLowerCase();
            if (u.includes("webex.com") || u.includes("sharepoint.com") || u.includes("microsoftstream.com") || u.includes("offline_player.html") || u.startsWith("chrome-extension://")) {
                chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
            }
        });
    });
}

// Remux fragmented MP4 into a monolithic web-optimized MP4 with faststart (moov at beginning)
async function remuxWebexMP4(blob, lectureId = "") {
    if (!self.Mediabunny) {
        console.warn("[Background] Mediabunny is not loaded, keeping original MP4");
        return blob;
    }
    const { Input, Output, Conversion, ALL_FORMATS, BufferTarget, Mp4OutputFormat, BlobSource } = self.Mediabunny;
    try {
        console.log(`[Background] Starting Mediabunny MP4 remux (+faststart) for '${lectureId}' (${(blob.size / (1024 * 1024)).toFixed(1)} MB)...`);
        broadcast({
            type: "BUFFER_PROGRESS",
            lectureId: lectureId,
            status: "remuxing",
            percent: 99,
            speedMB: "Ottimizzazione MP4..."
        });

        const input = new Input({
            formats: ALL_FORMATS,
            source: new BlobSource(blob)
        });
        const output = new Output({
            format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
            target: new BufferTarget()
        });
        const conversion = await Conversion.init({ input, output });
        if (!conversion.isValid) {
            console.warn("[Background] Mediabunny conversion not valid:", conversion.discardedTracks);
            return blob;
        }

        let lastPct = 0;
        conversion.onProgress = (progress) => {
            const pct = Math.min(100, Math.round(progress * 100));
            if (pct !== lastPct) {
                lastPct = pct;
                broadcast({
                    type: "BUFFER_PROGRESS",
                    lectureId: lectureId,
                    status: "remuxing",
                    percent: pct,
                    speedMB: `Ottimizzazione ${pct}%`
                });
            }
        };

        const t0 = Date.now();
        await conversion.execute();
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

        const outBuf = output.target.buffer;
        if (outBuf && outBuf.byteLength > 0) {
            const remuxedBlob = new Blob([outBuf], { type: "video/mp4" });
            console.log(`[Background] MP4 Remux (+faststart) finished in ${elapsed}s! New size: ${(remuxedBlob.size / (1024 * 1024)).toFixed(1)} MB`);
            return remuxedBlob;
        }
    } catch (err) {
        console.error("[Background] Mediabunny remux error, falling back to original:", err);
    }
    return blob;
}

// Perform download and store directly in extension's IndexedDB
async function runBackgroundDownload({ streamUrl, title, id, fraction = 1.0, duration = 0, pageUrl = "", folder = "" }) {
    if (activeDownloads.has(id)) {
        console.log("[Background] Download already running for:", id);
        return;
    }

    const abortCtrl = new AbortController();
    activeDownloads.set(id, {
        abortCtrl,
        id,
        title,
        percent: 0,
        recMB: "0",
        totMB: "?",
        speedMB: "0",
        status: "downloading"
    });

    broadcast({
        type: "BUFFER_PROGRESS",
        lectureId: id,
        status: "starting",
        percent: 0
    });

    try {
        let fetchUrl = streamUrl;

        // If fetchUrl is missing, check capturedStreams (ensuring it's a real video stream)
        if (!fetchUrl) {
            for (const [, s] of capturedStreams) {
                if (s && s.url) {
                    const lower = s.url.toLowerCase();
                    if (!lower.includes(".mp3") && !lower.includes(".m4a") && !lower.includes(".wav") && !lower.includes("/audio")) {
                        fetchUrl = s.url;
                        break;
                    }
                }
            }
        }

        let res = null;
        let lastErr = null;

        if (fetchUrl) {
            try {
                res = await fetch(fetchUrl, {
                    signal: abortCtrl.signal,
                    credentials: fetchUrl.includes("webex.com") ? "include" : "omit",
                    headers: {
                        "Accept": "*/*",
                        "Referer": pageUrl || "https://polimi.webex.com/"
                    }
                });
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status} ${res.statusText}`);
                }
            } catch (e) {
                lastErr = e;
                res = null;
            }
        }

        // Fallback: If direct fetch failed and pageUrl is Webex, try resolving via Webex stream API
        if ((!res || !res.ok) && pageUrl && pageUrl.includes(".webex.com")) {
            const regex = /^https?:\/\/(.+?)\.webex\.com\/(?:recordingservice|webappng)\/sites\/([^\/]+)\/.*?([a-f0-9]{32})/i;
            const m = regex.exec(pageUrl);
            if (m) {
                const sub = m[1];
                const site = m[2];
                const recId = m[3];
                const candidates = [
                    `https://${sub}.webex.com/webappng/api/v1/recordings/${recId}/stream?siteurl=${site}`,
                    `https://${sub}.webex.com/webappng/api/v1/recordings/${recId}/stream`,
                    `https://${sub}.webex.com/recordingservice/api/v1/recordings/${recId}/stream?siteurl=${site}`,
                    `https://${sub}.webex.com/recordingservice/api/v1/recordings/${recId}/stream`
                ];
                for (const apiUrl of candidates) {
                    try {
                        const apiRes = await fetch(apiUrl, {
                            credentials: "include",
                            headers: {
                                "Accept": "application/json, text/plain, */*",
                                "clientType": "web",
                                "appFrom": "pb",
                                "Referer": pageUrl
                            }
                        });
                        if (apiRes.ok) {
                            const data = await apiRes.json();
                            const mp4 = data.downloadRecordingInfo?.downloadInfo?.mp4URL ||
                                        data.downloadInfo?.mp4URL ||
                                        data.mp4URL ||
                                        data.fallbackPlaySrc ||
                                        data.downloadUrl ||
                                        data.streamURL;
                            if (mp4 && typeof mp4 === "string" && !mp4.includes(".m3u8")) {
                                fetchUrl = mp4;
                                res = await fetch(fetchUrl, {
                                    signal: abortCtrl.signal,
                                    credentials: "include",
                                    headers: {
                                        "Accept": "*/*",
                                        "Referer": pageUrl
                                    }
                                });
                                if (res.ok) {
                                    lastErr = null;
                                    break;
                                }
                            }
                        }
                    } catch (_) {}
                }
            }
        }

        if (!res || !res.ok) {
            throw lastErr || new Error("Impossibile connettersi al flusso video Webex");
        }

        let totalExpected = 0;
        const clHeader = res.headers.get("content-length");
        if (clHeader) {
            totalExpected = parseInt(clHeader, 10);
            if (fraction < 0.99 && totalExpected > 0) {
                totalExpected = Math.floor(totalExpected * fraction);
            }
        }

        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        const startTime = Date.now();
        let lastReportTime = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            chunks.push(value);
            received += value.length;

            const now = Date.now();
            if (now - lastReportTime > 250 || done) {
                lastReportTime = now;
                const elapsed = (now - startTime) / 1000;
                const speedMB = elapsed > 0 ? (received / (1024 * 1024) / elapsed).toFixed(1) : "0";
                const percent = totalExpected > 0 ? Math.min(100, Math.round((received / totalExpected) * 100)) : 0;
                const recMB = (received / (1024 * 1024)).toFixed(0);
                const totMB = totalExpected > 0 ? (totalExpected / (1024 * 1024)).toFixed(0) : "?";

                const progressData = {
                    type: "BUFFER_PROGRESS",
                    lectureId: id,
                    status: "downloading",
                    percent,
                    recMB,
                    totMB,
                    speedMB
                };

                const current = activeDownloads.get(id);
                if (current) {
                    Object.assign(current, progressData);
                }

                broadcast(progressData);
            }

            if (fraction < 0.99 && totalExpected > 0 && received >= totalExpected) {
                break;
            }
        }

        const rawBlob = new Blob(chunks, { type: "video/mp4" });
        const blob = await remuxWebexMP4(rawBlob, id);

        // Save directly into extension's IndexedDB
        if (self.WebexOfflineDB) {
            await self.WebexOfflineDB.saveLecture({
                id: id,
                title: title || "Lezione PoliMi",
                url: pageUrl,
                blob: blob,
                size: blob.size,
                duration: duration,
                bufferedPercent: Math.round(fraction * 100),
                date: new Date().toISOString(),
                folder: (folder && folder !== "Generale") ? folder : ""
            });
            console.log(`[Background] Saved lecture '${id}' (${Math.round(blob.size / (1024*1024))} MB) to WebexOfflineDB!`);
            
            // If user linked a PC folder, automatically mirror the video file to disk
            try {
                const pcDir = (await self.WebexOfflineDB.getSetting("pc_folder_handle")) || (await self.WebexOfflineDB.getSetting("pcFolderHandle"));
                if (pcDir && typeof pcDir.queryPermission === "function") {
                    const perm = await pcDir.queryPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        const cleanFolder = (folder && folder !== "Generale") ? folder : "";
                        let targetDir = pcDir;
                        if (cleanFolder) {
                            const parts = cleanFolder.split('/');
                            for (const p of parts) {
                                if (p.trim()) targetDir = await targetDir.getDirectoryHandle(p.trim(), { create: true });
                            }
                        }
                        const cleanTitle = (title || id).replace(/[/\\?%*:|"<>]/g, '_');
                        const fh = await targetDir.getFileHandle(`${cleanTitle}.mp4`, { create: true });
                        const w = await fh.createWritable();
                        await w.write(blob);
                        await w.close();
                        console.log(`[Background] Auto-mirrored lecture directly to PC folder: ${cleanFolder}/${cleanTitle}.mp4`);
                    }
                }
            } catch (mirrorErr) {
                console.warn("[Background] PC folder auto-mirror note (will sync on offline player open):", mirrorErr);
            }
        } else {
            console.error("[Background] WebexOfflineDB not found in worker!");
        }

        activeDownloads.delete(id);

        broadcast({
            type: "BUFFER_PROGRESS",
            lectureId: id,
            status: "completed",
            percent: 100,
            sizeMB: Math.round(blob.size / (1024 * 1024)),
            title: title
        });

    } catch (err) {
        activeDownloads.delete(id);

        if (err.name === "AbortError") {
            console.log("[Background] Download cancelled for:", id);
            broadcast({
                type: "BUFFER_PROGRESS",
                lectureId: id,
                status: "cancelled"
            });
        } else {
            console.error("[Background] Download failed:", err);
            broadcast({
                type: "BUFFER_PROGRESS",
                lectureId: id,
                status: "error",
                message: err.message
            });
        }
    }
}

// Runtime Messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 1. Open Offline Player
    if (request.type === "OPEN_OFFLINE_PLAYER") {
        const url = chrome.runtime.getURL("offline_player.html") + (request.lectureId ? `?id=${encodeURIComponent(request.lectureId)}` : "");
        chrome.tabs.create({ url });
        sendResponse({ success: true });
        return true;
    }

    // 2. Intercepted Stream URL
    if (request.type === "GET_CAPTURED_STREAM") {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const captured = capturedStreams.get(tabId);
        if (captured) {
            sendResponse({ stream: captured });
            return true;
        }
        if (chrome.storage && chrome.storage.session && tabId) {
            chrome.storage.session.get([`stream_${tabId}`]).then((res) => {
                const item = res[`stream_${tabId}`] || null;
                if (item) capturedStreams.set(tabId, item);
                sendResponse({ stream: item });
            }).catch(() => sendResponse({ stream: null }));
            return true;
        }
        sendResponse({ stream: null });
        return true;
    }

    // 2b. Intercepted Transcript URL
    if (request.type === "GET_CAPTURED_TRANSCRIPT") {
        const tabId = sender.tab ? sender.tab.id : request.tabId;
        const captured = capturedTranscripts.get(tabId);
        if (captured) {
            sendResponse({ transcript: captured });
            return true;
        }
        if (chrome.storage && chrome.storage.session && tabId) {
            chrome.storage.session.get([`transcript_${tabId}`]).then((res) => {
                const item = res[`transcript_${tabId}`] || null;
                if (item) capturedTranscripts.set(tabId, item);
                sendResponse({ transcript: item });
            }).catch(() => sendResponse({ transcript: null }));
            return true;
        }
        sendResponse({ transcript: null });
        return true;
    }

    // 3. Download MP4 File to Disk
    if (request.type === "DOWNLOAD_FILE") {
        chrome.downloads.download({
            url: request.url,
            filename: request.filename || "PoliMi_Lezione.mp4",
            saveAs: true
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ success: true, downloadId });
            }
        });
        return true;
    }

    // 4. Start Background Offline Buffer Download
    if (request.type === "START_BACKGROUND_DOWNLOAD") {
        runBackgroundDownload({
            streamUrl: request.streamUrl,
            title: request.title,
            id: request.id,
            fraction: request.fraction || 1.0,
            duration: request.duration || 0,
            pageUrl: request.url || "",
            folder: (request.folder && request.folder !== "Generale") ? request.folder : ""
        });
        sendResponse({ success: true, started: true });
        return true;
    }

    // 4b. Capture Visible Frame (Immune to Canvas CORS / Tainted Canvas)
    if (request.type === "CAPTURE_VISIBLE_FRAME") {
        chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
                sendResponse({ error: chrome.runtime.lastError?.message || "Capture failed" });
            } else {
                sendResponse({ dataUrl: dataUrl });
            }
        });
        return true;
    }

    // 5. Cancel Background Download
    if (request.type === "CANCEL_BACKGROUND_DOWNLOAD") {
        const dl = activeDownloads.get(request.lectureId);
        if (dl && dl.abortCtrl) {
            dl.abortCtrl.abort();
            activeDownloads.delete(request.lectureId);
            sendResponse({ success: true, cancelled: true });
        } else {
            sendResponse({ success: false, message: "Download not active" });
        }
        return true;
    }

    // 6. Get Download Status
    if (request.type === "GET_BUFFER_STATUS") {
        const dl = activeDownloads.get(request.lectureId);
        if (dl) {
            sendResponse({
                active: true,
                percent: dl.percent,
                recMB: dl.recMB,
                totMB: dl.totMB,
                speedMB: dl.speedMB,
                status: dl.status
            });
        } else {
            // Check if already in IndexedDB via smart lookup
            if (self.WebexOfflineDB && (request.lectureId || request.pageUrl || request.pageTitle)) {
                self.WebexOfflineDB.findLecture({
                    recordingId: request.lectureId,
                    pageUrl: request.pageUrl,
                    pageTitle: request.pageTitle
                }).then((data) => {
                    if (data && (data.blob || data.fileHandle)) {
                        sendResponse({
                            saved: true,
                            lectureId: data.id,
                            title: data.title,
                            folder: data.folder,
                            sizeMB: data.size ? Math.round(data.size / (1024 * 1024)) : 0,
                            date: data.date,
                            bufferedPercent: data.bufferedPercent || 100
                        });
                    } else {
                        sendResponse({ saved: false, active: false });
                    }
                }).catch(() => sendResponse({ saved: false, active: false }));
                return true;
            }
            sendResponse({ saved: false, active: false });
        }
        return true;
    }

    // 7. Check if lecture is saved (Smart matching by ID, URL, or Title)
    if (request.type === "CHECK_SAVED_LECTURE") {
        if (self.WebexOfflineDB && (request.lectureId || request.pageUrl || request.pageTitle)) {
            self.WebexOfflineDB.findLecture({
                recordingId: request.lectureId,
                pageUrl: request.pageUrl,
                pageTitle: request.pageTitle
            }).then((data) => {
                if (data && (data.blob || data.fileHandle)) {
                    sendResponse({
                        saved: true,
                        lectureId: data.id,
                        title: data.title,
                        folder: data.folder,
                        sizeMB: data.size ? Math.round(data.size / (1024 * 1024)) : 0
                    });
                } else {
                    sendResponse({ saved: false });
                }
            }).catch(() => sendResponse({ saved: false }));
            return true;
        }
        sendResponse({ saved: false });
        return true;
    }

    // 7b. Unified Notes & Bookmarks Persistence (Shared between Webex & Offline)
    if (request.type === "GET_LECTURE_NOTES") {
        if (self.WebexOfflineDB && request.lectureId) {
            self.WebexOfflineDB.getNotes(request.lectureId)
                .then(notes => sendResponse({ success: true, notes: notes || [] }))
                .catch(err => sendResponse({ success: false, error: err.message, notes: [] }));
            return true;
        }
        sendResponse({ success: false, notes: [] });
        return true;
    }

    if (request.type === "SAVE_LECTURE_NOTES") {
        if (self.WebexOfflineDB && request.lectureId) {
            self.WebexOfflineDB.saveNotes(request.lectureId, request.notes || [])
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }
        sendResponse({ success: false });
        return true;
    }

    if (request.type === "GET_LECTURE_BOOKMARKS") {
        if (self.WebexOfflineDB && request.lectureId) {
            self.WebexOfflineDB.getBookmarks(request.lectureId)
                .then(bms => sendResponse({ success: true, bookmarks: bms || [] }))
                .catch(err => sendResponse({ success: false, error: err.message, bookmarks: [] }));
            return true;
        }
        sendResponse({ success: false, bookmarks: [] });
        return true;
    }

    if (request.type === "SAVE_LECTURE_BOOKMARKS") {
        if (self.WebexOfflineDB && request.lectureId) {
            self.WebexOfflineDB.saveBookmarks(request.lectureId, request.bookmarks || [])
                .then(() => sendResponse({ success: true }))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }
        sendResponse({ success: false });
        return true;
    }

    // 8. Delete Saved Lecture & Broadcast to all tabs
    if (request.type === "DELETE_SAVED_LECTURE") {
        if (self.WebexOfflineDB && request.lectureId) {
            self.WebexOfflineDB.deleteLecture(request.lectureId).then(() => {
                broadcast({
                    type: "LECTURE_DELETED",
                    lectureId: request.lectureId,
                    pageUrl: request.pageUrl || "",
                    title: request.title || ""
                });
                sendResponse({ success: true });
            }).catch((err) => {
                sendResponse({ success: false, error: err.message });
            });
            return true;
        }
        sendResponse({ success: false });
        return true;
    }

    // 9. Get all folders from Extension IndexedDB (Unified Source of Truth)
    if (request.type === "GET_FOLDERS") {
        if (self.WebexOfflineDB) {
            self.WebexOfflineDB.getFolders().then((folders) => {
                sendResponse({ success: true, folders: folders || [] });
            }).catch((err) => {
                console.warn("[Background] getFolders error:", err);
                sendResponse({ success: false, folders: [] });
            });
            return true;
        }
        sendResponse({ success: false, folders: [] });
        return true;
    }

    // 10. Create Folder in Extension IndexedDB
    if (request.type === "CREATE_FOLDER") {
        if (self.WebexOfflineDB && request.folder) {
            self.WebexOfflineDB.createFolder(request.folder).then(() => {
                sendResponse({ success: true });
            }).catch((err) => {
                sendResponse({ success: false, error: err.message });
            });
            return true;
        }
        sendResponse({ success: false });
        return true;
    }

    // 11. Deprecated legacy handler for monolithic video blob transfer (Bug 3.4: avoids 64MB IPC crashes)
    if (request.type === "GET_LECTURE_BLOB") {
        sendResponse({
            success: false,
            error: "GET_LECTURE_BLOB è deprecato per superamento limite IPC (64MB). Utilizzare la porta di streaming GET_LECTURE_BLOB_STREAM."
        });
        return true;
    }

    // 12. AI Audio Speech-to-Text Proxy (Bypassing Content Script CSP restrictions)
    if (request.type === "TRANSCRIBE_AUDIO_API") {
        (async () => {
            try {
                let wavBlob = null;
                if (request.audioBase64) {
                    const response = await fetch(`data:audio/wav;base64,${request.audioBase64}`);
                    wavBlob = await response.blob();
                } else if (request.audioArrayBuffer && request.audioArrayBuffer.byteLength > 0) {
                    wavBlob = new Blob([request.audioArrayBuffer], { type: "audio/wav" });
                } else if (request.audioArrayBuffer && typeof request.audioArrayBuffer === "object") {
                    const vals = Object.values(request.audioArrayBuffer);
                    wavBlob = new Blob([new Uint8Array(vals)], { type: "audio/wav" });
                } else if (request.wavBlob) {
                    wavBlob = request.wavBlob;
                }

                if (!wavBlob || wavBlob.size === 0) {
                    sendResponse({ success: false, error: "Nessun blocco audio valido ricevuto per la trascrizione" });
                    return;
                }

                const cleanKey = (request.apiKey || "").trim();
                let model = request.model || "whisper-large-v3-turbo";

                async function sendGroqRequest(targetModel) {
                    const formData = new FormData();
                    formData.append("file", wavBlob, "audio.wav");
                    formData.append("model", targetModel);
                    formData.append("response_format", "verbose_json");
                    formData.append("language", request.language || "it");
                    formData.append("timestamp_granularities[]", "word");
                    formData.append("timestamp_granularities[]", "segment");
                    if (request.prompt) formData.append("prompt", request.prompt);

                    return await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${cleanKey}`
                        },
                        body: formData
                    });
                }

                let res = await sendGroqRequest(model);

                // Fallback to whisper-large-v3 if whisper-large-v3-turbo is unavailable
                if (!res.ok && res.status === 400) {
                    let testJson = null;
                    try {
                        const cloned = res.clone();
                        testJson = await cloned.json();
                    } catch (_) {}

                    if (testJson && testJson.error?.message && testJson.error.message.includes("model")) {
                        console.warn("[Background] Model turbo not supported, trying whisper-large-v3...");
                        res = await sendGroqRequest("whisper-large-v3");
                    }
                }

                if (!res.ok) {
                    let errDetail = "";
                    try {
                        const errJson = await res.json();
                        errDetail = errJson.error?.message || JSON.stringify(errJson);
                    } catch (_) {
                        errDetail = await res.text();
                    }
                    console.warn(`[Background] Groq Whisper API error (${res.status}):`, errDetail);
                    sendResponse({ success: false, status: res.status, error: errDetail });
                    return;
                }

                const data = await res.json();
                sendResponse({ success: true, data });
            } catch (err) {
                console.warn("[Background] TRANSCRIBE_AUDIO_API error:", err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }
});

function uint8ArrayToBase64(u8) {
    let binary = "";
    const len = u8.length;
    const chunkSize = 16384;
    for (let i = 0; i < len; i += chunkSize) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, Math.min(len, i + chunkSize)));
    }
    return btoa(binary);
}

// Stream large lecture video blobs in safe 4MB Base64 chunks over a runtime Port
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "GET_LECTURE_BLOB_STREAM") {
        port.onMessage.addListener(async (req) => {
            if (req.type === "REQUEST_BLOB") {
                try {
                    if (!self.WebexOfflineDB) {
                        port.postMessage({ type: "BLOB_ERROR", error: "WebexOfflineDB non disponibile" });
                        return;
                    }

                    const data = await self.WebexOfflineDB.findLecture({
                        recordingId: req.lectureId,
                        pageUrl: req.pageUrl,
                        pageTitle: req.pageTitle
                    });

                    if (!data) {
                        port.postMessage({ type: "BLOB_ERROR", error: "Lezione non trovata nel database offline" });
                        return;
                    }

                    let blob = data.blob;
                    if (!blob && data.fileHandle) {
                        try {
                            blob = await data.fileHandle.getFile();
                        } catch (e) {
                            console.warn("[Background] Error reading file from handle:", e);
                        }
                    }

                    if (!blob) {
                        port.postMessage({ type: "BLOB_ERROR", error: "File video non trovato" });
                        return;
                    }

                    const totalBytes = blob.size;
                    const mimeType = blob.type || "video/mp4";
                    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks

                    port.postMessage({
                        type: "BLOB_START",
                        totalBytes: totalBytes,
                        mimeType: mimeType
                    });

                    let offset = 0;
                    while (offset < totalBytes) {
                        const slice = blob.slice(offset, Math.min(totalBytes, offset + CHUNK_SIZE));
                        const ab = await slice.arrayBuffer();
                        const b64 = uint8ArrayToBase64(new Uint8Array(ab));
                        port.postMessage({
                            type: "BLOB_CHUNK",
                            base64Chunk: b64,
                            byteLength: ab.byteLength,
                            offset: offset
                        });
                        offset += ab.byteLength;
                    }

                    port.postMessage({ type: "BLOB_END" });
                } catch (err) {
                    port.postMessage({ type: "BLOB_ERROR", error: err.message });
                }
            }
        });
    }

    // Stream remote media URLs (bypassing Webex page CSP and CORS)
    if (port.name === "STREAM_URL_DATA") {
        port.onMessage.addListener(async (req) => {
            if (req.type === "REQUEST_URL") {
                try {
                    const targetUrl = req.url;
                    if (!targetUrl) throw new Error("URL multimediale mancante");

                    const headers = { "Accept": "*/*" };
                    if (req.referer) headers["Referer"] = req.referer;
                    if (req.token) headers["Authorization"] = `Bearer ${req.token}`;
                    if (req.authHeader) headers["Authorization"] = req.authHeader;

                    const res = await fetch(targetUrl, {
                        headers,
                        credentials: targetUrl.includes("webex.com") ? "include" : "omit"
                    });

                    if (!res.ok) {
                        throw new Error(`Download media fallito (${res.status} ${res.statusText})`);
                    }

                    const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
                    const mimeType = res.headers.get("content-type") || "video/mp4";

                    port.postMessage({
                        type: "STREAM_START",
                        totalBytes,
                        mimeType
                    });

                    const reader = res.body.getReader();
                    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks
                    let bufferParts = [];
                    let bufferedLength = 0;
                    let totalTransferred = 0;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (bufferedLength > 0) {
                                const merged = new Uint8Array(bufferedLength);
                                let pos = 0;
                                for (const p of bufferParts) {
                                    merged.set(p, pos);
                                    pos += p.length;
                                }
                                totalTransferred += merged.byteLength;
                                const b64 = uint8ArrayToBase64(merged);
                                port.postMessage({
                                    type: "STREAM_CHUNK",
                                    base64Chunk: b64,
                                    byteLength: merged.byteLength,
                                    totalTransferred
                                });
                            }
                            break;
                        }

                        bufferParts.push(value);
                        bufferedLength += value.length;

                        if (bufferedLength >= CHUNK_SIZE) {
                            const merged = new Uint8Array(bufferedLength);
                            let pos = 0;
                            for (const p of bufferParts) {
                                merged.set(p, pos);
                                pos += p.length;
                            }
                            totalTransferred += merged.byteLength;
                            const b64 = uint8ArrayToBase64(merged);
                            port.postMessage({
                                type: "STREAM_CHUNK",
                                base64Chunk: b64,
                                byteLength: merged.byteLength,
                                totalTransferred
                            });
                            bufferParts = [];
                            bufferedLength = 0;
                        }
                    }

                    port.postMessage({ type: "STREAM_END", totalTransferred });
                } catch (err) {
                    port.postMessage({ type: "STREAM_ERROR", error: err.message });
                }
            }
        });
    }
});
