/**
 * PoliMi Webex Enhancer - AI Audio Speech-to-Text & Spotify-Style Synced Lyrics Engine
 * Extracts audio tracks directly from Webex MP4 streams or offline files (zero microphone usage),
 * performs AI Speech-to-Text with word-level timestamps, and renders Spotify-style interactive lyrics.
 */

const AITranscriber = (function () {
    // Default Groq API key storage key (supports both plural and singular)
    const GROQ_KEY_STORAGE = "webex_groq_api_keys";
    const GROQ_KEY_STORAGE_LEGACY = "webex_groq_api_key";

    // Fallback public demo keys pool for instant 1-click student access (if configured)
    const DEMO_KEYS = [];

    let cachedApiKey = "";
    try {
        cachedApiKey = (localStorage.getItem(GROQ_KEY_STORAGE) || localStorage.getItem(GROQ_KEY_STORAGE_LEGACY) || "").trim();
    } catch (_) {}

    // Synchronize seamlessly across tabs, popups, and offline player
    if (typeof chrome !== "undefined" && chrome.storage) {
        if (chrome.storage.local) {
            chrome.storage.local.get([GROQ_KEY_STORAGE, GROQ_KEY_STORAGE_LEGACY], (result) => {
                const k = (result && (result[GROQ_KEY_STORAGE] || result[GROQ_KEY_STORAGE_LEGACY])) || "";
                if (k) {
                    cachedApiKey = k.trim();
                    try {
                        localStorage.setItem(GROQ_KEY_STORAGE, cachedApiKey);
                        localStorage.setItem(GROQ_KEY_STORAGE_LEGACY, cachedApiKey);
                    } catch (_) {}
                }
            });
        }
        if (chrome.storage.sync) {
            chrome.storage.sync.get([GROQ_KEY_STORAGE, GROQ_KEY_STORAGE_LEGACY, "webex_student_email"], (res) => {
                const k = (res && (res[GROQ_KEY_STORAGE] || res[GROQ_KEY_STORAGE_LEGACY])) || "";
                if (k) {
                    cachedApiKey = k.trim();
                    try {
                        localStorage.setItem(GROQ_KEY_STORAGE, cachedApiKey);
                        localStorage.setItem(GROQ_KEY_STORAGE_LEGACY, cachedApiKey);
                    } catch (_) {}
                }
                if (res && res.webex_student_email) {
                    try { localStorage.setItem("webex_student_email", res.webex_student_email); } catch (_) {}
                }
            });
        }
    }

    function getApiKey() {
        if (cachedApiKey && cachedApiKey.trim()) return cachedApiKey.trim();
        try {
            const saved = localStorage.getItem(GROQ_KEY_STORAGE) || localStorage.getItem(GROQ_KEY_STORAGE_LEGACY);
            if (saved && saved.trim()) {
                cachedApiKey = saved.trim();
                return cachedApiKey;
            }
        } catch (_) {}
        return "";
    }

    function setApiKey(key) {
        const clean = (key || "").trim();
        cachedApiKey = clean;
        try {
            if (clean) {
                localStorage.setItem(GROQ_KEY_STORAGE, clean);
                localStorage.setItem(GROQ_KEY_STORAGE_LEGACY, clean);
            } else {
                localStorage.removeItem(GROQ_KEY_STORAGE);
                localStorage.removeItem(GROQ_KEY_STORAGE_LEGACY);
            }
        } catch (_) {}
        if (typeof chrome !== "undefined" && chrome.storage) {
            try {
                if (chrome.storage.local) {
                    if (clean) {
                        chrome.storage.local.set({ [GROQ_KEY_STORAGE]: clean, [GROQ_KEY_STORAGE_LEGACY]: clean });
                    } else {
                        chrome.storage.local.remove([GROQ_KEY_STORAGE, GROQ_KEY_STORAGE_LEGACY]);
                    }
                }
                if (chrome.storage.sync) {
                    if (clean) {
                        chrome.storage.sync.set({ [GROQ_KEY_STORAGE]: clean, [GROQ_KEY_STORAGE_LEGACY]: clean });
                    } else {
                        chrome.storage.sync.remove([GROQ_KEY_STORAGE, GROQ_KEY_STORAGE_LEGACY]);
                    }
                }
            } catch (_) {}
        }
    }

    // =========================================================================
    // 1. Audio Resampling & WAV 16-Bit Mono Encoding (Web Audio API)
    // =========================================================================
    async function convertAudioBufferTo16kMonoWav(audioBuffer) {
        const targetSampleRate = 16000;
        const totalDuration = audioBuffer.duration;
        const targetLength = Math.ceil(totalDuration * targetSampleRate);

        // OfflineAudioContext automatically resamples and downmixes to 16kHz Mono
        const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, targetLength, targetSampleRate);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0);

        const renderedBuffer = await offlineCtx.startRendering();
        const pcmData = renderedBuffer.getChannelData(0);

        // Encode to 16-bit linear PCM WAV
        const wavBuffer = new ArrayBuffer(44 + pcmData.length * 2);
        const view = new DataView(wavBuffer);

        function writeStr(offset, str) {
            for (let i = 0; i < str.length; i++) {
                view.setUint8(offset + i, str.charCodeAt(i));
            }
        }

        /* RIFF identifier */
        writeStr(0, "RIFF");
        /* file length */
        view.setUint32(4, 36 + pcmData.length * 2, true);
        /* RIFF type */
        writeStr(8, "WAVE");
        /* format chunk identifier */
        writeStr(12, "fmt ");
        /* format chunk length */
        view.setUint32(16, 16, true);
        /* sample format (1 = raw PCM) */
        view.setUint16(20, 1, true);
        /* channel count (1 = mono) */
        view.setUint16(22, 1, true);
        /* sample rate */
        view.setUint32(24, targetSampleRate, true);
        /* byte rate (sampleRate * 2) */
        view.setUint32(28, targetSampleRate * 2, true);
        /* block align (1 channel * 2 bytes/sample) */
        view.setUint16(32, 2, true);
        /* bits per sample */
        view.setUint16(34, 16, true);
        /* data chunk identifier */
        writeStr(36, "data");
        /* data chunk length */
        view.setUint32(40, pcmData.length * 2, true);

        // Convert Float32 [-1.0, 1.0] to Int16 [-32768, 32767]
        let offset = 44;
        for (let i = 0; i < pcmData.length; i++, offset += 2) {
            const s = Math.max(-1, Math.min(1, pcmData[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }

        return new Blob([view], { type: "audio/wav" });
    }

    // Slice a Float32Array into chunks of maxSeconds (default 300s = 5 minutes)
    function slicePcmTo16kWavChunks(pcmData, sampleRate, chunkDurationSec = 300) {
        const samplesPerChunk = chunkDurationSec * sampleRate;
        const chunks = [];
        let cur = 0;
        let index = 0;

        while (cur < pcmData.length) {
            const end = Math.min(cur + samplesPerChunk, pcmData.length);
            const slice = pcmData.subarray(cur, end);
            const chunkDuration = slice.length / sampleRate;

            // Generate WAV for this slice
            const wavBuffer = new ArrayBuffer(44 + slice.length * 2);
            const view = new DataView(wavBuffer);

            function writeStr(offset, str) {
                for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
            }
            writeStr(0, "RIFF");
            view.setUint32(4, 36 + slice.length * 2, true);
            writeStr(8, "WAVE");
            writeStr(12, "fmt ");
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            writeStr(36, "data");
            view.setUint32(40, slice.length * 2, true);

            let offset = 44;
            for (let i = 0; i < slice.length; i++, offset += 2) {
                const s = Math.max(-1, Math.min(1, slice[i]));
                view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
            }

            chunks.push({
                blob: new Blob([view], { type: "audio/wav" }),
                startTimeSec: (cur / sampleRate),
                durationSec: chunkDuration,
                index: index++
            });

            cur = end;
        }

        return chunks;
    }

    // Helper to stream media files via background service worker (bypassing Webex CSP and CORS)
    function fetchMediaViaBackground(url, onProgress = () => {}, authToken = "") {
        return new Promise((resolve, reject) => {
            if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.connect) {
                return reject(new Error("Chrome runtime background non disponibile"));
            }
            try {
                const port = chrome.runtime.connect({ name: "STREAM_URL_DATA" });
                const chunks = [];
                let total = 0;
                let received = 0;

                port.onMessage.addListener((msg) => {
                    if (msg.type === "STREAM_START") {
                        total = msg.totalBytes;
                        onProgress({ stage: "download", percent: 8, detail: "Download avviato tramite background sicuro..." });
                    } else if (msg.type === "STREAM_CHUNK") {
                        let bytes = null;
                        if (msg.base64Chunk) {
                            const binary = atob(msg.base64Chunk);
                            bytes = new Uint8Array(binary.length);
                            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                        } else if (msg.buffer && msg.buffer.byteLength) {
                            bytes = new Uint8Array(msg.buffer);
                        }
                        if (bytes && bytes.byteLength > 0) {
                            chunks.push(bytes);
                            received += bytes.byteLength;
                        }

                        if (total > 0) {
                            const pct = Math.min(65, Math.round((received / total) * 55) + 10);
                            const mb = (received / (1024 * 1024)).toFixed(1);
                            const totMb = (total / (1024 * 1024)).toFixed(1);
                            onProgress({ stage: "download", percent: pct, detail: `Download traccia audio (${mb} MB / ${totMb} MB)...` });
                        } else {
                            const mb = (received / (1024 * 1024)).toFixed(1);
                            onProgress({ stage: "download", percent: 35, detail: `Download traccia audio (${mb} MB)...` });
                        }
                    } else if (msg.type === "STREAM_END") {
                        try { port.disconnect(); } catch (_) {}
                        const allBytes = new Uint8Array(received);
                        let pos = 0;
                        for (const c of chunks) {
                            allBytes.set(c, pos);
                            pos += c.length;
                        }
                        resolve(allBytes);
                    } else if (msg.type === "STREAM_ERROR") {
                        try { port.disconnect(); } catch (_) {}
                        reject(new Error(msg.error || "Errore durante il download in background"));
                    }
                });

                port.onDisconnect.addListener(() => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message || "Connessione background interrotta"));
                    }
                });

                port.postMessage({ type: "REQUEST_URL", url, referer: window.location.href, token: authToken });
            } catch (err) {
                reject(err);
            }
        });
    }

    // =========================================================================
    // 2. Audio Track Downloader & Decoder (Zero Microphone)
    // =========================================================================
    async function extractAudioTrackFromUrl(mediaUrl, onProgress = () => {}, authToken = "") {
        onProgress({ stage: "download", percent: 5, detail: "Connessione al flusso audio..." });

        let allBytes = null;

        // Mode A: Local Blob (from IndexedDB, memory buffer, or local file)
        if (typeof mediaUrl === "string" && mediaUrl.startsWith("blob:")) {
            try {
                const res = await fetch(mediaUrl);
                if (!res.ok) throw new Error(`Lettura buffer locale fallita (${res.status})`);
                const arrayBuf = await res.arrayBuffer();
                allBytes = new Uint8Array(arrayBuf);
            } catch (blobErr) {
                throw new Error("Impossibile leggere il buffer locale del video: " + blobErr.message);
            }
        } else {
            // Mode B: Remote URL (Webex CDN / AWS S3)
            // First attempt: direct fetch (mode: "cors" WITHOUT credentials to prevent S3 CORS wildcard errors)
            let directSuccess = false;
            try {
                const fetchHeaders = {};
                if (authToken && mediaUrl.includes("webex.com")) {
                    fetchHeaders["Authorization"] = `Bearer ${authToken}`;
                }
                const res = await fetch(mediaUrl, { mode: "cors", headers: fetchHeaders });
                if (res.ok) {
                    const totalBytes = parseInt(res.headers.get("content-length") || "0", 10);
                    const reader = res.body.getReader();
                    const chunks = [];
                    let received = 0;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        chunks.push(value);
                        received += value.length;

                        if (totalBytes > 0) {
                            const pct = Math.min(65, Math.round((received / totalBytes) * 60) + 5);
                            const mb = (received / (1024 * 1024)).toFixed(1);
                            const totMb = (totalBytes / (1024 * 1024)).toFixed(1);
                            onProgress({ stage: "download", percent: pct, detail: `Scaricamento traccia audio (${mb} MB / ${totMb} MB)...` });
                        }
                    }

                    allBytes = new Uint8Array(received);
                    let pos = 0;
                    for (const c of chunks) {
                        allBytes.set(c, pos);
                        pos += c.length;
                    }
                    directSuccess = true;
                }
            } catch (directErr) {
                console.warn("[AITranscriber] Direct fetch blocked (likely CSP/CORS), trying background proxy:", directErr);
            }

            // Fallback: Background service worker download (100% immune to Webex CSP and CORS!)
            if (!directSuccess || !allBytes) {
                onProgress({ stage: "download", percent: 8, detail: "Download sicuro tramite background..." });
                allBytes = await fetchMediaViaBackground(mediaUrl, onProgress, authToken);
            }
        }

        if (!allBytes || allBytes.length < 50) {
            throw new Error("Dati audio non validi o flusso vuoto ricevuto.");
        }

        // Validate that response is actual audio/video data and not an XML/HTML error page
        const headerSnippet = new TextDecoder().decode(allBytes.subarray(0, Math.min(300, allBytes.length)));
        if (headerSnippet.includes("<Error>") || headerSnippet.includes("AccessDenied") || headerSnippet.includes("<!DOCTYPE html>")) {
            throw new Error("Flusso audio non accessibile o link Webex scaduto. Ricarica la pagina e riprova.");
        }

        onProgress({ stage: "decode", percent: 70, detail: "Decodifica digitale dell'audio (PCM)..." });

        // Clone clean slice of ArrayBuffer to avoid detached/offset buffer issues and release allBytes
        const rawBuffer = allBytes.buffer.slice(allBytes.byteOffset, allBytes.byteOffset + allBytes.byteLength);
        allBytes = null;

        // Initialize AudioContext with 16kHz if supported to downscale memory immediately
        let audioCtx;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        } catch (_) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        let audioBuffer;
        try {
            audioBuffer = await audioCtx.decodeAudioData(rawBuffer);
        } catch (e) {
            throw new Error("Impossibile decodificare la traccia audio dal file multimediale: " + e.message);
        } finally {
            try { audioCtx.close(); } catch (_) {}
        }

        onProgress({ stage: "resample", percent: 85, detail: "Ricampionamento 16kHz per Speech-to-Text..." });

        // Resample to 16kHz Mono
        const targetSampleRate = 16000;
        const totalDuration = audioBuffer.duration;
        const targetLength = Math.ceil(totalDuration * targetSampleRate);

        const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, targetLength, targetSampleRate);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start(0);

        const rendered = await offlineCtx.startRendering();
        const monoPcm = rendered.getChannelData(0);
        audioBuffer = null; // Immediate memory release

        onProgress({ stage: "ready", percent: 100, detail: `Traccia audio pronta (${formatTime(totalDuration)})` });
        return { pcmData: monoPcm, sampleRate: targetSampleRate, duration: totalDuration };
    }

    // Convert Blob to Base64 safely for Chrome message passing
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result;
                const base64 = dataUrl.split(",")[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // =========================================================================
    // 3. AI Speech-to-Text (Whisper API with Word-Level Granularity)
    // =========================================================================
    async function transcribeWavChunkWithGroq(wavBlob, apiKey, language = "it", prompt = "", retryCount = 0) {
        const cleanKey = (apiKey || "").trim();
        if (!cleanKey) throw new Error("Chiave API mancante. Configura la tua chiave Groq.");

        // Priority 1: Background service worker proxy (bypasses CSP on webex.com)
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
            try {
                const b64 = await blobToBase64(wavBlob);

                const resp = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        type: "TRANSCRIBE_AUDIO_API",
                        apiKey: cleanKey,
                        language,
                        prompt,
                        audioBase64: b64
                    }, (r) => {
                        if (chrome.runtime.lastError) {
                            resolve({ success: false, error: chrome.runtime.lastError.message });
                        } else {
                            resolve(r);
                        }
                    });
                });

                if (resp && resp.success && resp.data) {
                    return resp.data;
                }

                if (resp && !resp.success) {
                    const status = resp.status;
                    const errMsg = resp.error || "";

                    // Auto-retry on Rate Limit (HTTP 429: max 20 requests/min)
                    if ((status === 429 || errMsg.includes("rate_limit") || errMsg.includes("Rate limit")) && retryCount < 3) {
                        console.warn(`[AITranscriber] Rate limit 429 raggiunto. Attesa di 6 secondi prima di riprovare (tentativo ${retryCount + 1}/3)...`);
                        await new Promise(r => setTimeout(r, 6000));
                        return transcribeWavChunkWithGroq(wavBlob, apiKey, language, prompt, retryCount + 1);
                    }

                    if (status === 401 || errMsg.includes("invalid_api_key") || errMsg.includes("Invalid API Key")) {
                        throw new Error("Chiave API Groq non valida o errata. Verifica la tua chiave su console.groq.com/keys.");
                    }

                    if (errMsg.includes("7200") || errMsg.includes("audio duration") || errMsg.includes("quota")) {
                        throw new Error("Raggiunto il limite orario del piano gratuito Groq (max 2 ore di audio all'ora, circa 7.200s). Riprova tra un'ora o usa un'altra chiave gratuita.");
                    }

                    if (status === 413 || errMsg.includes("25MB") || errMsg.includes("file size")) {
                        throw new Error("Il blocco audio supera il limite di 25 MB di Groq.");
                    }

                    throw new Error(`Errore API Groq (${status || 'Proxy'}): ${errMsg}`);
                }
            } catch (bgErr) {
                // If this was an explicit API error, re-throw it so the user sees the real message
                if (bgErr.message && (bgErr.message.includes("Chiave API") || bgErr.message.includes("limite orario") || bgErr.message.includes("Errore API Groq"))) {
                    throw bgErr;
                }
                console.warn("[AITranscriber] Background message failed, checking direct fetch:", bgErr);
            }
        }

        // Priority 2: Direct fetch (for local pages such as offline_player.html where CSP is open)
        const formData = new FormData();
        formData.append("file", wavBlob, "audio.wav");
        formData.append("model", "whisper-large-v3-turbo");
        formData.append("response_format", "verbose_json");
        formData.append("language", language);
        formData.append("timestamp_granularities[]", "word");
        formData.append("timestamp_granularities[]", "segment");
        if (prompt) formData.append("prompt", prompt);

        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${cleanKey}`
            },
            body: formData
        });

        if (!res.ok) {
            let errText = "";
            try {
                const j = await res.json();
                errText = j.error?.message || JSON.stringify(j);
            } catch (_) {
                errText = await res.text();
            }

            if (res.status === 429 && retryCount < 3) {
                await new Promise(r => setTimeout(r, 6000));
                return transcribeWavChunkWithGroq(wavBlob, apiKey, language, prompt, retryCount + 1);
            }
            if (res.status === 401) {
                throw new Error("Chiave API Groq non valida o errata. Verifica la tua chiave su console.groq.com/keys.");
            }
            throw new Error(`Errore API Trascrizione (${res.status}): ${errText}`);
        }

        return await res.json();
    }

    // Full transcription runner: chunks audio if needed, combines word timestamps
    async function transcribeAudioTrack(audioData, onProgress = () => {}) {
        let apiKeyRaw = getApiKey();
        if (!apiKeyRaw) {
            apiKeyRaw = await promptForGroqApiKey();
            if (!apiKeyRaw) throw new Error("Chiave API necessaria per la trascrizione vocale.");
        }
        
        // Support multiple comma-separated keys
                let apiKeysList = [];
        if (apiKeyRaw.startsWith("[")) {
            try {
                apiKeysList = JSON.parse(apiKeyRaw).map(obj => obj.key.trim()).filter(k => k);
            } catch(e) {}
        } else {
            apiKeysList = apiKeyRaw.split(",").map(k => k.trim()).filter(k => k);
        }
        const numKeys = apiKeysList.length;

        const { pcmData, sampleRate, duration } = audioData;
        // Slice into safe 3-minute (180s = ~5.7 MB) WAV chunks
        const chunks = slicePcmTo16kWavChunks(pcmData, sampleRate, 180);
        const totalChunks = chunks.length;

        const allCues = [];
        let allWordsCount = 0;
        
        // Parallel Worker Pool Algorithm with Resilient Key Re-queueing
        let completedChunks = 0;
        let queue = chunks.map((chunk, index) => ({ chunk, index }));
        const resultsArray = new Array(totalChunks).fill(null);
        let activeWorkersCount = numKeys;
        let lastErrorMessage = "";
        
        async function worker(workerId, apiKey) {
            let rateLimitRetries = 0;
            while (queue.length > 0) {
                const task = queue.shift(); // Get next chunk chronologically
                if (!task) break;

                const chunk = task.chunk;
                const chunkStart = chunk.startTimeSec;
                
                // Polite pause to respect Groq rate limits (20 req / minute per key)
                if (completedChunks >= numKeys) {
                    await new Promise(r => setTimeout(r, 1500)); 
                }

                let success = false;
                
                while (!success) {
                    onProgress({
                        stage: "transcribing",
                        percent: Math.round((completedChunks / totalChunks) * 100),
                        detail: `Trascrizione in parallelo (Worker ${workerId + 1}/${numKeys}): elaborazione blocco cronologico ${task.index + 1}/${totalChunks}...`
                    });

                    try {
                        const result = await transcribeWavChunkWithGroq(chunk.blob, apiKey, "it");
                        resultsArray[task.index] = { chunkStart, result };
                        completedChunks++;
                        success = true;
                        rateLimitRetries = 0;
                    } catch (err) {
                        const msg = err.message || "";
                        lastErrorMessage = msg;
                        const isRateLimit = msg.toLowerCase().includes("limite") || msg.toLowerCase().includes("rate limit") || msg.includes("429");

                        if (isRateLimit && rateLimitRetries < 2) {
                            rateLimitRetries++;
                            await new Promise(r => setTimeout(r, 6000));
                            continue;
                        }

                        // Fatal or exhausted for this specific key: re-enqueue task for other healthy workers
                        console.warn(`[AITranscriber] Worker ${workerId + 1} disattivato per errore chiave (${msg}). Rimetto blocco ${task.index + 1} in coda.`);
                        queue.unshift(task); // Re-queue chunk so other workers can process it
                        activeWorkersCount--;
                        return; // Exit this worker without aborting the rest of the pool
                    }
                }
            }
        }
        
        // Launch parallel workers
        const workers = apiKeysList.map((key, index) => worker(index, key));
        await Promise.all(workers);

        if (completedChunks < totalChunks) {
            throw new Error(`Trascrizione non completata (${completedChunks}/${totalChunks} blocchi elaborati). Le chiavi API fornite sono non valide o hanno esaurito la quota disponibile. Dettaglio: ${lastErrorMessage || "Quota esaurita"}`);
        }
        
        // Process results chronologically
        for (let i = 0; i < totalChunks; i++) {
            const data = resultsArray[i];
            if (!data || !data.result) continue;
            
            const chunkStart = data.chunkStart;
            const result = data.result;
            
            if (result.segments && Array.isArray(result.segments) && result.segments.length > 0) {
                result.segments.forEach(seg => {
                    const segStart = parseFloat((chunkStart + seg.start).toFixed(2));
                    const segEnd = parseFloat((chunkStart + seg.end).toFixed(2));
                    const segText = seg.text ? seg.text.trim() : "";
                    if (!segText) return;

                    let words = [];
                    if (seg.words && Array.isArray(seg.words) && seg.words.length > 0) {
                        words = seg.words.map(w => ({
                            text: w.word ? w.word.trim() : "",
                            start: parseFloat((chunkStart + w.start).toFixed(2)),
                            end: parseFloat((chunkStart + w.end).toFixed(2))
                        })).filter(w => w.text.length > 0);
                    } else if (result.words && Array.isArray(result.words)) {
                        words = result.words
                            .filter(w => w.start >= seg.start - 0.2 && w.end <= seg.end + 0.2)
                            .map(w => ({
                                text: w.word ? w.word.trim() : "",
                                start: parseFloat((chunkStart + w.start).toFixed(2)),
                                end: parseFloat((chunkStart + w.end).toFixed(2))
                            })).filter(w => w.text.length > 0);
                    }

                    if (words.length === 0) {
                        words = interpolateWordTimestamps(segText, segStart, segEnd);
                    }

                    allWordsCount += words.length;
                    allCues.push({ start: segStart, end: segEnd, text: segText, words: words });
                });
            } else if (result.words && Array.isArray(result.words) && result.words.length > 0) {
                let currentWords = [];
                let sentStart = 0;
                result.words.forEach((w, wIdx) => {
                    const wStart = parseFloat((chunkStart + w.start).toFixed(2));
                    const wEnd = parseFloat((chunkStart + w.end).toFixed(2));
                    const wText = w.word ? w.word.trim() : "";
                    if (!wText) return;

                    if (currentWords.length === 0) sentStart = wStart;
                    currentWords.push({ text: wText, start: wStart, end: wEnd });

                    const isEndPunct = /[.!?]$/.test(wText);
                    if (isEndPunct || currentWords.length >= 10 || wIdx === result.words.length - 1) {
                        allCues.push({
                            start: sentStart,
                            end: wEnd,
                            text: currentWords.map(x => x.text).join(" "),
                            words: [...currentWords]
                        });
                        allWordsCount += currentWords.length;
                        currentWords = [];
                    }
                });
            }
        }

        onProgress({
            stage: "complete",
            percent: 100,
            detail: `Trascrizione completata in parallelo: ${allWordsCount} parole riconosciute!`
        });

        return allCues.sort((a, b) => a.start - b.start);
    }

    // =========================================================================
    // 4. Word Timestamps Helper & Spotify Lyrics Formatting
    // =========================================================================
    function interpolateWordTimestamps(sentenceText, startTime, endTime) {
        if (!sentenceText) return [];
        const words = sentenceText.trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) return [];
        const duration = Math.max(0.6, endTime - startTime);
        const wordDur = duration / words.length;

        return words.map((w, idx) => ({
            text: w,
            start: parseFloat((startTime + idx * wordDur).toFixed(2)),
            end: parseFloat((startTime + (idx + 1) * wordDur).toFixed(2))
        }));
    }

    function ensureWordTimestamps(cue) {
        if (cue.words && Array.isArray(cue.words) && cue.words.length > 0) {
            return cue.words;
        }
        cue.words = interpolateWordTimestamps(cue.text, cue.start, cue.end);
        return cue.words;
    }

    function formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return "00:00";
        const totalSecs = Math.floor(seconds);
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        const s = totalSecs % 60;
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
        }
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }

    // Test Groq API Key connectivity with a 1-second sample to immediately verify in Groq Cloud console
    async function testGroqConnection(apiKey) {
        const cleanKey = (apiKey || "").trim();
        if (!cleanKey) {
            return { success: false, error: "Inserisci prima la tua chiave API (inizia per gsk_...)." };
        }
        if (!cleanKey.startsWith("gsk_")) {
            return { success: false, error: "La chiave API deve iniziare con 'gsk_' (copiata da console.groq.com/keys)." };
        }

        try {
            // Generate a synthetic 1-second 16kHz Mono 16-bit PCM WAV (silence)
            const sampleRate = 16000;
            const durationSec = 1;
            const numSamples = sampleRate * durationSec;
            const wavBuffer = new ArrayBuffer(44 + numSamples * 2);
            const view = new DataView(wavBuffer);

            function writeStr(offset, str) {
                for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
            }
            writeStr(0, "RIFF");
            view.setUint32(4, 36 + numSamples * 2, true);
            writeStr(8, "WAVE");
            writeStr(12, "fmt ");
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true); // PCM
            view.setUint16(22, 1, true); // Mono
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, sampleRate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            writeStr(36, "data");
            view.setUint32(40, numSamples * 2, true);
            for (let i = 0; i < numSamples; i++) {
                view.setInt16(44 + i * 2, 0, true);
            }

            const testBlob = new Blob([view], { type: "audio/wav" });
            const result = await transcribeWavChunkWithGroq(testBlob, cleanKey, "it", "Test PoliMi Enhancer");
            return { success: true, result };
        } catch (err) {
            return { success: false, error: err.message || "Errore sconosciuto durante il test" };
        }
    }

    // Prompt user for their Groq API Key
    function promptForGroqApiKey() {
        return new Promise((resolve) => {
            const currentKey = getApiKey();
            const overlay = document.createElement("div");
            overlay.className = "webex-helper-modal-overlay";
            overlay.innerHTML = `
                <div class="webex-helper-modal" style="width: 530px; max-width: 92vw;">
                    <div class="webex-helper-modal-header">
                        <span class="webex-helper-modal-title">🔑 Configurazione AI Whisper Speech-to-Text</span>
                        <button class="webex-helper-close-btn" id="modal-groq-close">✕</button>
                    </div>
                    <p style="font-size: 12px; color: #94a3b8; margin-bottom: 10px; line-height: 1.5;">
                        Per trascrivere l'intera lezione parola per parola con il modello vocale <b>Whisper-large-v3-turbo</b>, inserisci una chiave API di <a href="https://console.groq.com/keys" target="_blank" style="color: #38bdf8; text-decoration: underline;">Groq (100% Gratuita)</a>:
                    </p>
                    
                    <!-- Free Tier Limits Box (Richiesto dall'utente) -->
                    <div style="background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.28); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; font-size: 11.5px; color: #cbd5e1; line-height: 1.5;">
                        <b style="color: #34d399; font-size: 12px;">📊 Limiti del Piano Gratuito Groq (Free Tier):</b>
                        <ul style="margin: 4px 0 0 16px; padding: 0;">
                            <li><b>Volume Audio:</b> Circa <b>2 ore di lezione all'ora</b> (7.200 secondi/ora) e fino a ~8 ore/giorno (~2.000 richieste). Ideale per studiare 1-2 lezioni al giorno gratis!</li>
                            <li><b>Limite Dimensione:</b> Max <b>25 MB</b> per singola richiesta (l'estensione gestisce questo limite in automatico, spezzando l'audio in blocchi compatti da 3 minuti).</li>
                            <li><b>Rate Limits (RPM):</b> Max <b>20 richieste al minuto</b> (l'estensione elabora i blocchi sequenzialmente con pause automatiche per non sforare mai).</li>
                        </ul>
                    </div>

                                        <div style="background: rgba(56, 189, 248, 0.08); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; font-size: 11.5px; color: #cbd5e1;">
                        💡 <b>MOLTIPLICA LA VELOCITÀ (Novità!):</b> Inserisci più chiavi API create con <b>ACCOUNT GOOGLE DIVERSI</b>. L'algoritmo suddividerà il carico tra di esse inviando i blocchi in parallelo (es. 3 chiavi = trascrizione 3 volte più veloce!). Inserire più chiavi dello stesso account NON serve a nulla.
                        <br>Vai su <a href="https://console.groq.com/keys" target="_blank" style="color: #38bdf8; font-weight: 700;">console.groq.com/keys</a> per generarle.
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-size: 11.5px; font-weight: 700; color: #94a3b8; text-transform: uppercase;">CHIAVI API GROQ (Max 10)</span>
                        <button id="modal-groq-add-key" style="background: rgba(56,189,248,0.2); border: 1px solid rgba(56,189,248,0.4); color: #38bdf8; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 14px; font-weight: bold;">+</button>
                    </div>
                    <div id="modal-groq-keys-container" style="max-height: 180px; overflow-y: auto; margin-bottom: 10px; display: flex; flex-direction: column; gap: 6px;">
                        <!-- Inputs added dynamically -->
                    </div>
                    
                    <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px;">
                        <button class="webex-subtitles-action-btn" id="modal-groq-cancel">Annulla</button>
                        <button class="webex-subtitles-action-btn active" id="modal-groq-save" style="background: #0284c7; color: #fff; font-weight: 700;">Salva</button>
                    </div>
                </div>
            `;
                                    document.body.appendChild(overlay);

            const keysContainer = overlay.querySelector("#modal-groq-keys-container");
            const addKeyBtn = overlay.querySelector("#modal-groq-add-key");
            
            let keysArray = [];
            const rawStored = getApiKey();
            if (rawStored.startsWith("[")) {
                try {
                    keysArray = JSON.parse(rawStored);
                } catch(e) {}
            } else if (rawStored) {
                keysArray = rawStored.split(",").map((k, i) => ({ name: `Chiave ${i+1}`, key: k.trim() })).filter(k => k.key);
            }
            if (keysArray.length === 0) keysArray.push({ name: "Chiave 1", key: "" });

            function renderKeys() {
                keysContainer.innerHTML = "";
                keysArray.forEach((obj, idx) => {
                    const row = document.createElement("div");
                    row.style.display = "flex";
                    row.style.gap = "8px";
                    row.style.alignItems = "center";
                    row.style.background = "rgba(255,255,255,0.03)";
                    row.style.padding = "8px";
                    row.style.borderRadius = "8px";
                    row.style.border = "1px solid rgba(255,255,255,0.05)";
                    
                    const nameInput = document.createElement("input");
                    nameInput.type = "text";
                    nameInput.value = obj.name;
                    nameInput.placeholder = "Nome (es. Mario Rossi)";
                    nameInput.style.width = "140px";
                    nameInput.style.padding = "8px";
                    nameInput.style.background = "rgba(0,0,0,0.3)";
                    nameInput.style.border = "1px solid rgba(255,255,255,0.1)";
                    nameInput.style.borderRadius = "6px";
                    nameInput.style.color = "#fff";
                    nameInput.style.fontSize = "12px";
                    nameInput.style.outline = "none";
                    nameInput.oninput = (e) => { obj.name = e.target.value; };
                    row.appendChild(nameInput);

                    const keyInput = document.createElement("input");
                    keyInput.type = "password";
                    keyInput.value = obj.key;
                    keyInput.placeholder = "gsk_...";
                    keyInput.style.flex = "1";
                    keyInput.style.padding = "8px";
                    keyInput.style.background = "rgba(0,0,0,0.35)";
                    keyInput.style.border = "1px solid rgba(255,255,255,0.18)";
                    keyInput.style.borderRadius = "6px";
                    keyInput.style.color = "#fff";
                    keyInput.style.fontFamily = "monospace";
                    keyInput.style.fontSize = "12px";
                    keyInput.style.outline = "none";
                    keyInput.style.outline = "none";
                    keyInput.oninput = (e) => { obj.key = e.target.value; };
                    row.appendChild(keyInput);

                    const eyeBtn = document.createElement("button");
                    eyeBtn.innerHTML = "👁️";
                    eyeBtn.style.background = "transparent";
                    eyeBtn.style.border = "none";
                    eyeBtn.style.color = "#94a3b8";
                    eyeBtn.style.cursor = "pointer";
                    eyeBtn.style.fontSize = "14px";
                    eyeBtn.onclick = () => {
                        if (keyInput.type === "password") {
                            keyInput.type = "text";
                            eyeBtn.style.opacity = "0.5";
                        } else {
                            keyInput.type = "password";
                            eyeBtn.style.opacity = "1";
                        }
                    };
                    row.appendChild(eyeBtn);

                    const testBtnSingle = document.createElement("button");
                    testBtnSingle.innerHTML = "🧪 Test";
                    testBtnSingle.style.background = "rgba(56, 189, 248, 0.15)";
                    testBtnSingle.style.border = "1px solid rgba(56, 189, 248, 0.35)";
                    testBtnSingle.style.color = "#38bdf8";
                    testBtnSingle.style.borderRadius = "6px";
                    testBtnSingle.style.padding = "6px 10px";
                    testBtnSingle.style.fontSize = "11px";
                    testBtnSingle.style.fontWeight = "bold";
                    testBtnSingle.style.cursor = "pointer";
                    testBtnSingle.onclick = async () => {
                        const k = obj.key.trim();
                        if(!k) { alert("Inserisci una chiave prima di testarla!"); return; }
                        testBtnSingle.disabled = true;
                        testBtnSingle.innerHTML = "⏳...";
                        const res = await testGroqConnection(k);
                        testBtnSingle.disabled = false;
                        if(res.success) {
                            testBtnSingle.innerHTML = "✅ OK";
                            testBtnSingle.style.background = "rgba(16, 185, 129, 0.15)";
                            testBtnSingle.style.borderColor = "rgba(16, 185, 129, 0.4)";
                            testBtnSingle.style.color = "#34d399";
                        } else {
                            testBtnSingle.innerHTML = "❌ Fallito";
                            testBtnSingle.style.background = "rgba(239, 68, 68, 0.15)";
                            testBtnSingle.style.borderColor = "rgba(239, 68, 68, 0.4)";
                            testBtnSingle.style.color = "#ef4444";
                            alert("Errore test: " + res.error);
                        }
                    };
                    row.appendChild(testBtnSingle);

                    const delBtn = document.createElement("button");
                    delBtn.innerHTML = "🗑️";
                    delBtn.style.background = "transparent";
                    delBtn.style.border = "none";
                    delBtn.style.color = "#ef4444";
                    delBtn.style.fontSize = "14px";
                    delBtn.style.cursor = "pointer";
                    delBtn.style.padding = "4px";
                    delBtn.onclick = () => {
                        keysArray.splice(idx, 1);
                        if (keysArray.length === 0) keysArray.push({name: "Chiave 1", key: ""});
                        renderKeys();
                    };
                    row.appendChild(delBtn);
                    
                    keysContainer.appendChild(row);
                });
                addKeyBtn.style.opacity = keysArray.length >= 10 ? "0.5" : "1";
                addKeyBtn.style.pointerEvents = keysArray.length >= 10 ? "none" : "auto";
            }
            renderKeys();

            addKeyBtn.onclick = () => {
                if (keysArray.length < 10) {
                    keysArray.push({name: `Chiave ${keysArray.length+1}`, key: ""});
                    renderKeys();
                }
            };

            overlay.querySelector("#modal-groq-close").onclick = () => { overlay.remove(); resolve(null); };
            overlay.querySelector("#modal-groq-cancel").onclick = () => { overlay.remove(); resolve(null); };

            overlay.querySelector("#modal-groq-save").onclick = () => {
                const validKeys = keysArray.filter(k => k.key.trim() !== "");
                if (validKeys.length > 0) {
                    const finalStr = JSON.stringify(validKeys);
                    setApiKey(finalStr);
                    overlay.remove();
                    resolve(finalStr);
                } else {
                    alert("Inserisci almeno una chiave API valida!");
                }
            };
        });
    }

    return {
        getApiKey,
        setApiKey,
        testGroqConnection,
        promptForGroqApiKey,
        extractAudioTrackFromUrl,
        transcribeAudioTrack,
        ensureWordTimestamps,
        formatTime
    };
})();

// Export for module or background script
if (typeof module !== "undefined" && module.exports) {
    module.exports = AITranscriber;
}


// Auto-sync settings from cloud (chrome.storage.sync)
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(["webex_groq_api_keys", "webex_student_email"], (res) => {
        if (res.webex_groq_api_keys) localStorage.setItem("webex_groq_api_keys", res.webex_groq_api_keys);
        if (res.webex_student_email) localStorage.setItem("webex_student_email", res.webex_student_email);
    });
}
