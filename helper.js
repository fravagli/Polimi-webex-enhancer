/**
 * PoliMi Webex Enhancer - helper.js
 * Ottimizzazione e funzionalità avanzate per le lezioni Webex e SharePoint (PoliMi).
 * Master Liquid Glass theme, controlli nativi integrati nel player, riproduzione del buffer in-page e offline player.
 */

(function () {
    // --- Autologger ---
    if (window.location.hostname.includes("idbroker") || document.title.includes("Accedi - Webex") || document.title.includes("Sign In")) {
        chrome.storage.local.get(['webex_student_email'], (result) => {
            const studentEmail = result.webex_student_email;
            if (!studentEmail) return;

            let attempts = 0;
            const attemptLogin = setInterval(() => {
                attempts++;
                const emailInput = document.getElementById('IDToken1');
                const submitBtn = document.getElementById('IDButton2');
                if (emailInput && submitBtn) {
                    clearInterval(attemptLogin);
                    emailInput.value = studentEmail;
                    emailInput.dispatchEvent(new Event('input', { bubbles: true }));
                    emailInput.dispatchEvent(new Event('blur', { bubbles: true }));
                    submitBtn.disabled = false;

                    if (typeof window.processForm === 'function') {
                        window.processForm();
                    } else {
                        submitBtn.click();
                    }
                } else if (attempts > 30) {
                    clearInterval(attemptLogin);
                }
            }, 300);
        });
        // Non blocchiamo l'esecuzione per permettere ad altro di caricare, anche se su idbroker c'è poco altro.
    }

    // Only execute in top-level window, never inside iframes
    if (window.self !== window.top) return;

    // Avoid double injection
    if (window.__polimi_enhancer_injected) return;
    window.__polimi_enhancer_injected = true;

    // --- State ---
    let lastPreferredSpeed = parseFloat(localStorage.getItem('webex_helper_speed')) || 1.0;
    let hudTimeout = null;
    let isToolbarCollapsed = true;
    let audioCtx = null;
    let gainNode = null;
    let audioSource = null;
    let audioSourceVideo = null;
    const mediaElementSourceMap = new WeakMap();

    function getOrCreateMediaElementSource(vid) {
        if (!vid || !audioCtx) return null;
        if (mediaElementSourceMap.has(vid)) {
            return mediaElementSourceMap.get(vid);
        }
        try {
            const src = audioCtx.createMediaElementSource(vid);
            mediaElementSourceMap.set(vid, src);
            return src;
        } catch (e) {
            console.warn("[PoliMiEnhancer] createMediaElementSource error:", e);
            return null;
        }
    }

    let currentVolumeBoost = 1.0; // 1.0 = 100%, 2.0 = 200%, 3.0 = 300%

    // Advanced study states
    let loopA = null;
    let loopB = null;
    let isLooping = false;
    let zoomLevel = 1.0;
    let panX = 0;
    let panY = 0;
    let isZoomDragging = false;
    let startDragX = 0;
    let startDragY = 0;
    let currentFilterId = "normal";
    let filterIntensity = 100;
    const filterModes = [
        { id: "normal", name: "Normale" },
        { id: "contrast", name: "Contrasto" },
        { id: "bw", name: "B&N" },
        { id: "blue_light", name: "Luce Blu" },
        { id: "negative", name: "Negativo" }
    ];
    let isSilenceSkipActive = false;
    let silenceSkipSpeed = 3.0;
    let silenceToleranceSeconds = parseFloat(localStorage.getItem('webex_silence_tolerance')) || 1.0;
    let silenceAnalyser = null;
    let silenceDataArray = null;
    let isSilenceFast = false;
    let slideMode = localStorage.getItem('webex_slide_mode') || 'copy';
    let autoResumePrompted = false;

    // Buffer state
    let bufferedBlob = null;
    let isDownloadInProgress = false;
    let downloadAbortController = null;

    // --- Fast Video & Player Container Detection ---
    function getAllVideos() {
        if (isBufferPlaybackActive) {
            const bufVid = document.getElementById("webex-inpage-buffer-video");
            if (bufVid) return [bufVid];
        }
        try {
            const vList = document.querySelectorAll('video');
            if (vList && vList.length > 0) return Array.from(vList);
        } catch (e) {}
        return [];
    }

    function getPrimaryVideo() {
        if (isBufferPlaybackActive) {
            const bufVid = document.getElementById("webex-inpage-buffer-video");
            if (bufVid) return bufVid;
        }
        const videos = getAllVideos();
        if (videos.length === 0) return null;
        if (videos.length === 1) return videos[0];

        return videos.slice().sort((a, b) => {
            const aPlaying = !a.paused && !a.ended && a.currentTime > 0;
            const bPlaying = !b.paused && !b.ended && b.currentTime > 0;
            if (aPlaying !== bPlaying) return aPlaying ? -1 : 1;

            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            return (bRect.width * bRect.height) - (aRect.width * aRect.height);
        })[0];
    }

    function getPlayerContainer() {
        if (isBufferPlaybackActive) {
            const overlay = document.getElementById("webex-inpage-buffer-player");
            if (overlay && overlay.parentElement) return overlay.parentElement;
        }
        const video = getPrimaryVideo();
        if (!video) return null;
        return video.closest('.video-js') ||
               video.closest('.playback-video-container') ||
               video.closest('[class*="player-container"]') ||
               video.closest('#player-container') ||
               video.parentElement;
    }

    function getRecordingId() {
        const hexMatch = window.location.href.match(/([a-f0-9]{32})/i);
        if (hexMatch) return hexMatch[1];

        const params = new URLSearchParams(window.location.search);
        const idParam = params.get("recordingId") || params.get("recordId") || params.get("id");
        if (idParam) return idParam;

        const pathParts = window.location.pathname.split("/").filter(Boolean);
        return pathParts[pathParts.length - 1] || "unknown_rec";
    }

    // --- On-Screen Display (HUD) ---
    function showHUD(text, icon = "⚡") {
        let hud = document.getElementById("webex-helper-hud-toast");
        if (!hud) {
            hud = document.createElement("div");
            hud.id = "webex-helper-hud-toast";
            hud.className = "webex-helper-hud";
            document.body.appendChild(hud);
        }

        hud.innerHTML = `<span class="webex-helper-hud-icon">${icon}</span><span>${text}</span>`;
        hud.classList.add("visible");

        if (hudTimeout) clearTimeout(hudTimeout);
        hudTimeout = setTimeout(() => {
            hud.classList.remove("visible");
        }, 1200);
    }

    function showGlassPrompt(title, defaultValue = "", placeholder = "") {
        return new Promise((resolve) => {
            const overlay = document.createElement("div");
            overlay.className = "webex-helper-modal-overlay";
            overlay.style.zIndex = "2147483647";
            overlay.innerHTML = `
                <div class="webex-helper-modal" style="width: 440px; max-width: 90vw; animation: fadeInScale 0.2s ease;">
                    <div class="webex-helper-modal-header">
                        <span class="webex-helper-modal-title">${title}</span>
                        <button class="webex-helper-close-btn" id="glass-prompt-close">✕</button>
                    </div>
                    <div style="margin: 16px 0;">
                        <input type="text" id="glass-prompt-input" value="${defaultValue}" placeholder="${placeholder}"
                            style="width: 100%; box-sizing: border-box; background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 8px; color: #f8fafc; padding: 10px 14px; font-size: 13px; outline: none;" />
                    </div>
                    <div style="display: flex; justify-content: flex-end; gap: 8px;">
                        <button class="webex-subtitles-action-btn" id="glass-prompt-cancel" style="padding: 6px 14px;">Annulla</button>
                        <button class="webex-subtitles-action-btn active" id="glass-prompt-confirm" style="padding: 6px 14px;">Conferma</button>
                    </div>
                </div>
            `;
            const parent = document.fullscreenElement || document.body;
            parent.appendChild(overlay);

            const input = overlay.querySelector("#glass-prompt-input");
            const btnClose = overlay.querySelector("#glass-prompt-close");
            const btnCancel = overlay.querySelector("#glass-prompt-cancel");
            const btnConfirm = overlay.querySelector("#glass-prompt-confirm");

            const cleanup = (val) => {
                if (overlay.parentElement) overlay.parentElement.removeChild(overlay);
                resolve(val);
            };

            btnClose.onclick = () => cleanup(null);
            btnCancel.onclick = () => cleanup(null);
            btnConfirm.onclick = () => cleanup(input.value);

            setTimeout(() => {
                input.focus();
                input.select();
            }, 50);

            input.onkeydown = (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    cleanup(input.value);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    cleanup(null);
                }
            };
        });
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return "00:00";
        const curTime = Math.floor(seconds);
        const hrs = Math.floor(curTime / 3600);
        const mins = Math.floor((curTime % 3600) / 60);
        const secs = curTime % 60;
        return `${hrs > 0 ? hrs + ':' : ''}${(mins < 10 ? '0' : '') + mins}:${(secs < 10 ? '0' : '') + secs}`;
    }

    // --- Playback Controls ---
    function togglePlayPause() {
        if (isBufferPlaybackActive) {
            const bufVid = document.getElementById("webex-inpage-buffer-video");
            if (bufVid) {
                if (bufVid.paused) {
                    bufVid.play().catch(() => {});
                    showHUD("Riproduzione", "▶");
                } else {
                    bufVid.pause();
                    showHUD("Pausa", "⏸");
                }
                const inpagePlayBtn = document.getElementById("webex-inpage-btn-play");
                if (inpagePlayBtn) inpagePlayBtn.innerHTML = bufVid.paused ? "▶ Play" : "⏸ Pausa";
                return;
            }
        }

        const nativePlayBtn =
            document.querySelector('button[aria-label*="Play" i], button[aria-label*="Pause" i]') ||
            document.querySelector('button[aria-label*="Riproduci" i], button[aria-label*="Pausa" i]') ||
            document.querySelector('.play-btn, .pause-btn, #playOrPause, .vjs-play-control') ||
            document.querySelector('[data-testid*="play" i], [data-testid*="pause" i]');

        if (nativePlayBtn) {
            nativePlayBtn.click();
            setTimeout(() => {
                const v = getPrimaryVideo();
                if (v) showHUD(v.paused ? "Pausa" : "Riproduzione", v.paused ? "⏸" : "▶");
            }, 100);
            return;
        }

        const video = getPrimaryVideo();
        if (!video) return;

        if (video.paused) {
            getAllVideos().forEach(v => v.play().catch(() => {}));
            showHUD("Riproduzione", "▶");
        } else {
            getAllVideos().forEach(v => v.pause());
            showHUD("Pausa", "⏸");
        }
    }

    let pendingSeekTarget = null;
    let seekDebounceTimer = null;

    function safeSeek(targetVideo, targetTime, resumeIfPlaying = true) {
        if (!targetVideo) return;
        const dur = (targetVideo.duration && isFinite(targetVideo.duration)) ? targetVideo.duration : 9999999;
        const clampedTime = Math.max(0, Math.min(dur, targetTime));

        // Reset any temporary silence acceleration speed
        if (typeof isSilenceFast !== "undefined" && isSilenceFast) {
            targetVideo.playbackRate = (typeof lastPreferredSpeed !== "undefined" && lastPreferredSpeed) ? lastPreferredSpeed : 1.0;
            isSilenceFast = false;
        }

        try {
            targetVideo.currentTime = clampedTime;
        } catch (e) {
            console.warn("[PoliMiEnhancer] seek error:", e);
        }

        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
        }
        updateSubtitlesHighlight(clampedTime, true);

        if (resumeIfPlaying && targetVideo.paused) {
            targetVideo.play().catch(() => {});
        }
    }

    function seekVideo(seconds) {
        const video = getPrimaryVideo();
        if (!video) return;

        const maxDuration = (video.duration && !isNaN(video.duration) && isFinite(video.duration)) ? video.duration : 9999999;
        const baseTime = (pendingSeekTarget !== null) ? pendingSeekTarget : (video.currentTime || 0);
        const newTime = Math.max(0, Math.min(maxDuration, baseTime + seconds));
        pendingSeekTarget = newTime;

        const totalDelta = newTime - (video.currentTime || 0);
        const sign = totalDelta >= 0 ? `+${Math.round(totalDelta)}s` : `${Math.round(totalDelta)}s`;
        showHUD(`${sign} (${formatTime(newTime)})`, totalDelta >= 0 ? "⏩" : "⏪");

        // Clear debounce timer to accumulate successive rapid clicks smoothly
        if (seekDebounceTimer) clearTimeout(seekDebounceTimer);

        seekDebounceTimer = setTimeout(() => {
            const finalTarget = pendingSeekTarget;
            pendingSeekTarget = null;
            if (finalTarget === null) return;

            safeSeek(video, finalTarget, true);
        }, 120);
    }

    function changeSpeed(delta, target = null) {
        const video = getPrimaryVideo();
        if (!video) return;

        let newSpeed = target !== null ? target : Math.round((video.playbackRate + delta) * 100) / 100;
        newSpeed = Math.max(0.25, Math.min(5.0, newSpeed));
        newSpeed = Math.round(newSpeed * 20) / 20;

        getAllVideos().forEach(v => {
            try { v.playbackRate = newSpeed; } catch (e) {}
        });

        lastPreferredSpeed = newSpeed;
        try { localStorage.setItem('webex_helper_speed', newSpeed.toString()); } catch (e) {}

        showHUD(`${newSpeed.toFixed(2).replace(/\.00$/, '')}x Velocità`, "⚡");
        updateToolbarSpeed(newSpeed);
    }

    function resetOrToggleSpeed() {
        const video = getPrimaryVideo();
        if (!video) return;

        if (Math.abs(video.playbackRate - 1.0) < 0.05) {
            const restore = lastPreferredSpeed > 1.05 ? lastPreferredSpeed : 1.5;
            changeSpeed(0, restore);
        } else {
            changeSpeed(0, 1.0);
        }
    }

    function changeVolume(delta) {
        const video = getPrimaryVideo();
        if (!video) return;

        let newVol = Math.max(0, Math.min(1, video.volume + delta));
        newVol = Math.round(newVol * 20) / 20;
        getAllVideos().forEach(v => { v.volume = newVol; });
        showHUD(`Volume ${Math.round(newVol * 100)}%`, newVol === 0 ? "🔇" : "🔊");
    }

    function toggleMute() {
        const video = getPrimaryVideo();
        if (!video) return;
        const newMuted = !video.muted;
        getAllVideos().forEach(v => { v.muted = newMuted; });
        showHUD(newMuted ? "Muto" : "Audio Attivo", newMuted ? "🔇" : "🔊");
    }

    function toggleFullscreen() {
        const container = getPlayerContainer() || document.documentElement;
        if (!document.fullscreenElement) {
            container.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    }

    // --- Audio Booster (Up to 300%) ---
    function setAudioBoost(multiplier) {
        currentVolumeBoost = multiplier;
        const video = getPrimaryVideo();
        if (!video) return;

        try {
            ensureSilenceAudio();
            if (gainNode && audioCtx) {
                if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
                gainNode.gain.setValueAtTime(multiplier, audioCtx.currentTime);
                showHUD(`🔊 Boost Audio: ${Math.round(multiplier * 100)}%`, "🔊");
                updateNativeBoostButton();
            }
        } catch (e) {
            console.warn("[PoliMiEnhancer] Web Audio boost warning:", e);
        }
    }

    function cycleAudioBoost() {
        const levels = [1.0, 1.5, 2.0, 2.5, 3.0];
        const curIdx = levels.findIndex(l => Math.abs(l - currentVolumeBoost) < 0.1);
        const next = levels[(curIdx + 1) % levels.length];
        setAudioBoost(next);
        const slider = document.getElementById("webex-vol-boost");
        const label = document.getElementById("webex-vol-boost-val");
        if (slider) slider.value = next;
        if (label) label.innerText = `${Math.round(next * 100)}%`;
    }

    // --- HD Screenshot with Clipboard Copy & Multi-Engine Capture ---
    function triggerShutterFlash() {
        const container = getPlayerContainer() || document.body;
        const flash = document.createElement("div");
        flash.className = "webex-shutter-flash";
        container.appendChild(flash);
        setTimeout(() => flash.remove(), 400);
    }

    function triggerBlobDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    async function captureScreenshot() {
        const video = getPrimaryVideo();
        if (!video) {
            showHUD("Nessun video trovato per lo screenshot", "⚠️");
            return;
        }

        triggerShutterFlash();

        const timestamp = formatTime(video.currentTime).replace(/:/g, "-");
        const lectureTitle = (document.title || "PoliMi_Lezione").replace(/[^\w\s\d\-_~]/g, "_").substring(0, 40);
        const filename = `Slide_${lectureTitle}_${timestamp}.png`;
        const mode = slideMode || "copy";

        let blob = null;

        // Strategy 1: Direct Canvas drawing with filters
        try {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth || video.clientWidth || 1920;
            canvas.height = video.videoHeight || video.clientHeight || 1080;
            const ctx = canvas.getContext("2d");

            if (currentFilterId !== "normal" && filterIntensity > 0) {
                const factor = filterIntensity / 100;
                let filterStr = "";
                if (currentFilterId === "contrast") {
                    filterStr = `contrast(${100 + 80 * factor}%) brightness(${100 - 5 * factor}%)`;
                } else if (currentFilterId === "bw") {
                    filterStr = `grayscale(${100 * factor}%) contrast(${100 + 100 * factor}%)`;
                } else if (currentFilterId === "blue_light" || currentFilterId === "night") {
                    filterStr = `sepia(${60 * factor}%) saturate(${100 - 25 * factor}%) hue-rotate(-15deg) brightness(${100 - 10 * factor}%)`;
                } else if (currentFilterId === "negative") {
                    filterStr = `invert(${92 * factor}%) hue-rotate(${180 * factor}deg) contrast(${100 + 25 * factor}%)`;
                }
                if (filterStr) ctx.filter = filterStr;
            }

            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            // Test if canvas is tainted by cross-origin security
            ctx.getImageData(0, 0, 1, 1);

            blob = await new Promise(res => canvas.toBlob(res, "image/png"));
        } catch (taintErr) {
            console.warn("[PoliMiEnhancer] Direct canvas draw tainted, trying background capture:", taintErr);
            blob = null;
        }

        // Strategy 2: Background tab capture (CORS-immune, works on all cross-origin streams)
        if (!blob) {
            try {
                const bgResp = await new Promise((res) => {
                    chrome.runtime.sendMessage({ type: "CAPTURE_VISIBLE_FRAME" }, res);
                });

                if (bgResp && bgResp.dataUrl) {
                    const img = new Image();
                    await new Promise((res, rej) => {
                        img.onload = res;
                        img.onerror = rej;
                        img.src = bgResp.dataUrl;
                    });

                    const vRect = video.getBoundingClientRect();
                    const dpr = window.devicePixelRatio || 1;
                    const cropCanvas = document.createElement("canvas");
                    cropCanvas.width = Math.max(10, Math.round(vRect.width * dpr));
                    cropCanvas.height = Math.max(10, Math.round(vRect.height * dpr));
                    const cropCtx = cropCanvas.getContext("2d");

                    cropCtx.drawImage(
                        img,
                        Math.round(vRect.left * dpr),
                        Math.round(vRect.top * dpr),
                        cropCanvas.width,
                        cropCanvas.height,
                        0,
                        0,
                        cropCanvas.width,
                        cropCanvas.height
                    );

                    blob = await new Promise(res => cropCanvas.toBlob(res, "image/png"));
                }
            } catch (bgErr) {
                console.error("[PoliMiEnhancer] Background tab capture error:", bgErr);
            }
        }

        if (!blob) {
            showHUD("Impossibile catturare lo screenshot", "⚠️");
            return;
        }

        // Execute actions according to mode
        let didCopy = false;
        let didDownload = false;

        if (mode === "copy" || mode === "both") {
            try {
                await navigator.clipboard.write([
                    new ClipboardItem({ "image/png": blob })
                ]);
                didCopy = true;
            } catch (clipErr) {
                console.warn("[PoliMiEnhancer] Clipboard write error, falling back to download:", clipErr);
                if (mode === "copy") {
                    didDownload = true;
                    triggerBlobDownload(blob, filename);
                }
            }
        }

        if (mode === "download" || mode === "both" || (mode === "copy" && !didCopy && didDownload)) {
            if (!didDownload) {
                triggerBlobDownload(blob, filename);
                didDownload = true;
            }
        }

        if (didCopy && didDownload) {
            showHUD("⚡ Slide copiata e scaricata!", "📸");
        } else if (didCopy) {
            showHUD("📸 Slide copiata negli appunti! (Incolla con Ctrl+V)", "📋");
        } else if (didDownload) {
            showHUD(`💾 Slide scaricata: ${filename}`, "💾");
        }
    }

    // --- Picture-in-Picture ---
    async function togglePiP() {
        const video = getPrimaryVideo();
        if (!video) return;

        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                showHUD("PiP Disattivato", "🪟");
            } else if (document.pictureInPictureEnabled) {
                await video.requestPictureInPicture();
                showHUD("PiP Attivato", "🪟");
            }
        } catch (e) {
            console.warn("[PoliMiEnhancer] PiP error:", e);
            showHUD("PiP non disponibile", "⚠️");
        }
    }

    // --- Loop A-B Repeat ---
    function handleLoopA() {
        const video = getPrimaryVideo();
        if (!video) return;

        if (isLooping) {
            clearLoopAB();
            return;
        }

        loopA = Math.floor(video.currentTime);
        showHUD(`🔁 Punto A: ${formatTime(loopA)} (Premi B per Punto B)`, "🔁");
        updateActionButtonsState();
    }

    function handleLoopB() {
        const video = getPrimaryVideo();
        if (!video) return;

        if (loopA === null) {
            addBookmark();
            return;
        }

        const now = Math.floor(video.currentTime);
        loopB = (now <= loopA) ? loopA + 5 : now;
        isLooping = true;
        safeSeek(video, loopA, true);
        showHUD(`🔁 Loop A-B attivo (${formatTime(loopA)} ↔ ${formatTime(loopB)})`, "🔁");
        updateActionButtonsState();
    }

    function clearLoopAB() {
        loopA = null;
        loopB = null;
        isLooping = false;
        showHUD("Loop A-B rimosso", "ℹ️");
        updateActionButtonsState();
    }

    // --- Zoom & Pan on Slides ---
    function applyZoom() {
        const video = getPrimaryVideo();
        if (!video) return;

        if (zoomLevel <= 1.0) {
            video.style.transform = "";
            video.classList.remove("webex-zoomed");
            const parent = video.parentElement;
            if (parent) parent.style.overflow = "";
        } else {
            video.classList.add("webex-zoomed");
            const parent = video.parentElement;
            if (parent) parent.style.overflow = "hidden";
            video.style.transformOrigin = "center center";
            video.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
        }
        updateActionButtonsState();
    }

    function setZoom(level) {
        zoomLevel = Math.max(1.0, Math.min(10.0, Math.round(level * 10) / 10));
        if (zoomLevel <= 1.0) {
            panX = 0;
            panY = 0;
        }
        applyZoom();
        if (zoomLevel > 1.0) {
            showHUD(`🔍 Zoom ${zoomLevel.toFixed(1)}x (Trascina = Pan)`, "🔍");
        } else {
            showHUD("🔍 Zoom ripristinato (1.0x)", "🔍");
        }
    }

    function cycleZoom() {
        if (zoomLevel === 1.0) setZoom(1.5);
        else if (zoomLevel <= 1.5) setZoom(2.0);
        else if (zoomLevel <= 2.0) setZoom(3.0);
        else setZoom(1.0);
    }

    function resetZoom() {
        setZoom(1.0);
    }

    let zoomListenersAttached = false;
    function initZoomMouseListeners() {
        if (zoomListenersAttached) return;
        zoomListenersAttached = true;

        window.addEventListener("wheel", (e) => {
            if (zoomLevel <= 1.0) return;
            const video = getPrimaryVideo();
            if (!video) return;

            const rect = video.getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
                e.preventDefault();
                if (e.deltaY < 0) {
                    setZoom(Math.min(10.0, Math.round((zoomLevel + 0.25) * 10) / 10));
                } else {
                    setZoom(Math.max(1.0, Math.round((zoomLevel - 0.25) * 10) / 10));
                }
            }
        }, { passive: false });

        window.addEventListener("mousedown", (e) => {
            if (zoomLevel <= 1.0) return;
            const video = getPrimaryVideo();
            if (!video) return;
            const rect = video.getBoundingClientRect();
            if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
                isZoomDragging = true;
                startDragX = e.clientX - panX;
                startDragY = e.clientY - panY;
            }
        });

        window.addEventListener("mousemove", (e) => {
            if (!isZoomDragging || zoomLevel <= 1.0) return;
            panX = e.clientX - startDragX;
            panY = e.clientY - startDragY;
            applyZoom();
        });

        window.addEventListener("mouseup", () => {
            isZoomDragging = false;
        });

        window.addEventListener("dblclick", () => {
            if (zoomLevel > 1.0) {
                resetZoom();
            }
        });
    }

    // --- Video Filters & Integrated Dark/Night Mode ---
    function setFilterMode(modeId) {
        currentFilterId = modeId;
        applyVideoFilter();
        const mode = filterModes.find(m => m.id === modeId);
        showHUD(`🎨 Filtro: ${mode ? mode.name : modeId}`, "🎨");
    }

    function setFilterIntensity(intensity) {
        filterIntensity = Math.max(0, Math.min(100, intensity));
        applyVideoFilter();
    }

    function cycleVideoFilter() {
        const idx = filterModes.findIndex(m => m.id === currentFilterId);
        const nextIdx = (idx + 1) % filterModes.length;
        setFilterMode(filterModes[nextIdx].id);
    }

    function applyVideoFilter() {
        const videoList = getAllVideos();
        videoList.forEach(v => {
            v.className = v.className.replace(/\bwebex-filter-\S+/g, '').trim();

            if (currentFilterId === "normal" || filterIntensity <= 0) {
                v.style.filter = "none";
                return;
            }

            const factor = filterIntensity / 100;

            if (currentFilterId === "contrast") {
                v.style.filter = `contrast(${100 + 60 * factor}%) brightness(${100 + 5 * factor}%)`;
            } else if (currentFilterId === "bw") {
                v.style.filter = `grayscale(${100 * factor}%) contrast(${100 + 40 * factor}%)`;
            } else if (currentFilterId === "blue_light") {
                v.style.filter = `sepia(${50 * factor}%) saturate(${100 + 10 * factor}%) brightness(${100 - 8 * factor}%)`;
            } else if (currentFilterId === "negative") {
                v.style.filter = `invert(${92 * factor}%) hue-rotate(180deg) contrast(${100 + 15 * factor}%)`;
            }
        });
        updateActionButtonsState();
    }

    // --- Smart Silence Skip with Speed Selector & Indicator ---
    let silenceMonitorInterval = null;
    let silenceCounter = 0;

    function setSilenceSpeed(speed) {
        silenceSkipSpeed = Math.max(2.0, Math.min(5.0, speed));
        showHUD(`Velocità silenzio: ${silenceSkipSpeed.toFixed(1)}x`, "🤫");
        updateActionButtonsState();
    }

    function setSilenceTolerance(sec) {
        silenceToleranceSeconds = Math.max(0.5, Math.min(3.0, sec));
        try { localStorage.setItem('webex_silence_tolerance', silenceToleranceSeconds.toString()); } catch (e) {}
        const lbl = document.getElementById("webex-silence-tol-lbl");
        if (lbl) lbl.innerText = `Ritardo inizio: ${silenceToleranceSeconds.toFixed(1)}s`;
    }

    function showSilenceIndicator(speed) {
        let el = document.getElementById("webex-silence-indicator");
        if (!el) {
            el = document.createElement("div");
            el.id = "webex-silence-indicator";
            el.className = "webex-silence-indicator";
            const container = getPlayerContainer() || document.body;
            container.appendChild(el);
        }
        el.innerHTML = `⏩ Skipping Silenzio ${speed.toFixed(1)}x`;
        el.classList.add("visible");
    }

    function hideSilenceIndicator() {
        const el = document.getElementById("webex-silence-indicator");
        if (el) el.classList.remove("visible");
    }

    function ensureSilenceAudio() {
        const video = getPrimaryVideo();
        if (!video) return null;
        // Do not intercept or hijack video audio if user does not need volume boost (>100%) or silence skipping
        if (currentVolumeBoost <= 1.0 && !isSilenceSkipActive) {
            return null;
        }
        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === "suspended") {
                audioCtx.resume().catch(() => {});
            }
            if (!gainNode) {
                gainNode = audioCtx.createGain();
                gainNode.gain.setValueAtTime(currentVolumeBoost || 1.0, audioCtx.currentTime);
                gainNode.connect(audioCtx.destination);
            }
            if (!silenceAnalyser) {
                silenceAnalyser = audioCtx.createAnalyser();
                silenceAnalyser.fftSize = 512;
                silenceAnalyser.smoothingTimeConstant = 0.2;
                silenceDataArray = new Uint8Array(silenceAnalyser.frequencyBinCount);
            }

            if (audioSourceVideo !== video) {
                const src = getOrCreateMediaElementSource(video);
                if (src) {
                    audioSource = src;
                    audioSourceVideo = video;
                    try { audioSource.connect(gainNode); } catch (_) {}
                    try { audioSource.connect(silenceAnalyser); } catch (_) {}
                }
            }
        } catch (e) {
            console.warn("[PoliMiEnhancer] ensureSilenceAudio warning:", e);
        }
        return { audioCtx, audioSource, silenceAnalyser, silenceDataArray };
    }

    function readWebexVolumePercent() {
        ensureSilenceAudio();
        if (!silenceAnalyser || !silenceDataArray) return 0;
        const video = getPrimaryVideo();
        if (!video || video.paused || video.ended) return 0;
        silenceAnalyser.getByteFrequencyData(silenceDataArray);
        let sum = 0;
        for (let i = 0; i < silenceDataArray.length; i++) sum += silenceDataArray[i];
        return (sum / silenceDataArray.length / 255) * 100 * 1.5;
    }

    let webexLiveMeterInterval = null;
    function startWebexLiveMeter() {
        if (webexLiveMeterInterval) return;
        ensureSilenceAudio();
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

        webexLiveMeterInterval = setInterval(() => {
            const liveVolEl = document.getElementById("webex-silence-live-vol");
            if (!liveVolEl) return;
            const video = getPrimaryVideo();
            if (!video || video.paused) {
                liveVolEl.innerText = "0.0%";
                liveVolEl.style.color = "#94a3b8";
                return;
            }
            const vol = readWebexVolumePercent();
            liveVolEl.innerText = `${vol.toFixed(1)}%`;
            liveVolEl.style.color = vol < silenceThreshold ? "#38bdf8" : "#4ade80";
        }, 100);
    }

    function stopWebexLiveMeter() {
        if (webexLiveMeterInterval) {
            clearInterval(webexLiveMeterInterval);
            webexLiveMeterInterval = null;
        }
    }

    function toggleSilenceSkip() {
        isSilenceSkipActive = !isSilenceSkipActive;
        const video = getPrimaryVideo();

        if (isSilenceSkipActive) {
            try {
                ensureSilenceAudio();
                showHUD(`🤫 Salto Silenzi Attivo (${silenceSkipSpeed}x, ritardo ${silenceToleranceSeconds.toFixed(1)}s)`, "🤫");
                startSilenceMonitoring();
            } catch (e) {
                console.warn("[PoliMiEnhancer] Silence skip audio warning:", e);
                showHUD("Salto Silenzi attivo", "🤫");
            }
        } else {
            isSilenceFast = false;
            hideSilenceIndicator();
            stopWebexLiveMeter();
            stopSilenceMonitoring();
            if (video) video.playbackRate = lastPreferredSpeed;
            showHUD("🗣 Salto Silenzi Disattivato", "🗣");
        }
        updateActionButtonsState();
    }

    let silenceIntervalId = null;
    let silenceStart = null;
    let corsZeroStartTime = null;
    let silenceThreshold = parseFloat(localStorage.getItem('webex_silence_threshold')) || 3.5;

    function setSilenceThreshold(val) {
        silenceThreshold = Math.max(0, Math.min(10, val));
        try { localStorage.setItem('webex_silence_threshold', silenceThreshold.toString()); } catch (e) {}
    }

    function stopSilenceMonitoring() {
        if (silenceIntervalId) {
            clearInterval(silenceIntervalId);
            silenceIntervalId = null;
        }
        silenceStart = null;
        corsZeroStartTime = null;
    }

    function startSilenceMonitoring() {
        stopSilenceMonitoring();
        
        silenceIntervalId = setInterval(() => {
            if (!isSilenceSkipActive) {
                hideSilenceIndicator();
                stopSilenceMonitoring();
                return;
            }
            
            if (audioCtx && audioCtx.state === "suspended") {
                audioCtx.resume().catch(() => {});
            }

            const video = getPrimaryVideo();
            if (!video || video.paused || video.ended) {
                if (isSilenceFast) {
                    isSilenceFast = false;
                    if (video) video.playbackRate = lastPreferredSpeed;
                    hideSilenceIndicator();
                }
                silenceStart = null;
                corsZeroStartTime = null;
                return;
            }

            const volumePercent = readWebexVolumePercent();
            const now = Date.now();

            // Watchdog anti-CORS (Bug 4.3): If volume is strictly 0.00% continuously for 3.5s during playback
            if (volumePercent <= 0.001) {
                if (corsZeroStartTime === null) {
                    corsZeroStartTime = now;
                } else if (now - corsZeroStartTime >= 3500) {
                    isSilenceSkipActive = false;
                    isSilenceFast = false;
                    hideSilenceIndicator();
                    stopWebexLiveMeter();
                    stopSilenceMonitoring();
                    if (video) video.playbackRate = lastPreferredSpeed;
                    updateActionButtonsState();
                    showHUD("Salto silenzi non disponibile su questo stream (protezione CORS del server Webex)", "⚠️");
                    return;
                }
            } else {
                corsZeroStartTime = null;
            }

            // Update DOM only if silence flyout is open/hovered (Bug 2.2 layout thrashing fix)
            const flyout = document.getElementById("webex-silence-flyout");
            if (flyout && (flyout.classList.contains("is-open") || flyout.matches(":hover"))) {
                const liveVolEl = document.getElementById("webex-silence-live-vol");
                if (liveVolEl) {
                    liveVolEl.innerText = `${volumePercent.toFixed(1)}%`;
                    liveVolEl.style.color = volumePercent < silenceThreshold ? "#38bdf8" : "#4ade80";
                }
            }

            if (volumePercent < silenceThreshold) {
                if (silenceStart === null) silenceStart = now;
                if (!isSilenceFast && (now - silenceStart) >= silenceToleranceSeconds * 1000) {
                    isSilenceFast = true;
                    video.playbackRate = silenceSkipSpeed;
                    showSilenceIndicator(silenceSkipSpeed);
                }
            } else {
                if (isSilenceFast) {
                    isSilenceFast = false;
                    video.playbackRate = lastPreferredSpeed;
                    hideSilenceIndicator();
                }
                silenceStart = null;
            }
        }, 70);
    }

    // --- Notes Modal (Zero Blur, Draggable, Fullscreen Compatible) ---
    function makeDraggable(modalEl, handleEl) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        handleEl.style.cursor = "move";
        handleEl.addEventListener("mousedown", (e) => {
            if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = modalEl.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            modalEl.style.margin = "0";
            modalEl.style.position = "fixed";
            modalEl.style.left = `${initialLeft}px`;
            modalEl.style.top = `${initialTop}px`;
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const maxW = window.innerWidth - modalEl.offsetWidth - 10;
            const maxH = window.innerHeight - modalEl.offsetHeight - 10;
            modalEl.style.left = `${Math.max(10, Math.min(maxW, initialLeft + dx))}px`;
            modalEl.style.top = `${Math.max(10, Math.min(maxH, initialTop + dy))}px`;
        });

        window.addEventListener("mouseup", () => {
            isDragging = false;
        });
    }

    function openNewNoteModal() {
        showNotesModal(true);
    }

    function showNotesModal(focusQuickAdd = false) {
        let existing = document.getElementById("webex-notes-glass-panel");
        if (existing) {
            if (focusQuickAdd) {
                const inp = existing.querySelector("#webex-notes-quick-input");
                if (inp) { inp.focus(); return; }
            }
            existing.remove();
            return;
        }

        const recId = getRecordingId();
        const key = "webex_notes_" + recId;
        let notes = [];
        try { notes = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) {}

        // Asynchronously sync from IndexedDB via background
        if (chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: "GET_LECTURE_NOTES", lectureId: recId }, (res) => {
                if (res && res.success && Array.isArray(res.notes) && res.notes.length > 0) {
                    if (notes.length === 0) {
                        notes = res.notes;
                        try { localStorage.setItem(key, JSON.stringify(notes)); } catch (_) {}
                        renderNotes(searchInput ? searchInput.value : "");
                    }
                }
            });
        }

        const video = getPrimaryVideo();
        const curTime = video ? Math.floor(video.currentTime || 0) : 0;
        const curTimeStr = formatTime(curTime);

        const overlay = document.createElement("div");
        overlay.id = "webex-notes-glass-panel";
        overlay.className = "webex-notes-glass-modal";
        overlay.innerHTML = `
            <div class="webex-notes-glass-header" id="webex-notes-glass-hdr">
                <div class="webex-notes-title-box">
                    <span style="font-size: 16px; filter: drop-shadow(0 0 6px #38bdf8);">📝</span>
                    <span class="webex-notes-title">Note & Commenti</span>
                    <span class="webex-notes-badge" id="webex-notes-count-badge">${notes.length} note</span>
                </div>
                <button class="webex-notes-close-btn" id="webex-notes-close" title="Chiudi">✕</button>
            </div>

            <!-- Quick Inline Add Note Box -->
            <div class="webex-notes-quick-add">
                <textarea id="webex-notes-quick-input" placeholder="Scrivi una nota o appunto per il minuto corrente..."></textarea>
                <div class="webex-notes-quick-add-footer">
                    <span class="webex-notes-curtime-pill" id="webex-notes-time-pill">⏱️ ${curTimeStr}</span>
                    <button class="webex-notes-add-btn" id="webex-notes-quick-btn">+ Salva Nota (Invio)</button>
                </div>
            </div>

            <!-- Live Search Filter -->
            <div class="webex-notes-search-box" id="webex-notes-search-container" style="${notes.length === 0 ? 'display: none;' : ''}">
                <span style="font-size: 12px; color: #94a3b8;">🔍</span>
                <input type="text" class="webex-notes-search-input" id="webex-notes-search-input" placeholder="Filtra tra le note..." />
            </div>

            <!-- Scrollable Notes List -->
            <div class="webex-notes-list" id="webex-notes-items-container"></div>

            <!-- Footer Toolbar -->
            <div class="webex-notes-footer" id="webex-notes-footer-box">
                <button class="webex-notes-footer-btn" id="webex-notes-export-btn" style="${notes.length === 0 ? 'display: none;' : ''}">
                    <span>📥 Esporta Notion / Markdown</span>
                </button>
                <button class="webex-notes-footer-btn danger" id="webex-notes-clear-btn" style="${notes.length === 0 ? 'display: none;' : ''}">
                    <span>🗑️ Elimina tutte</span>
                </button>
            </div>
        `;

        const targetRoot = document.fullscreenElement || document.body;
        targetRoot.appendChild(overlay);

        const header = overlay.querySelector("#webex-notes-glass-hdr");
        makeDraggable(overlay, header);

        const closeBtn = overlay.querySelector("#webex-notes-close");
        closeBtn.onclick = () => overlay.remove();

        const quickInput = overlay.querySelector("#webex-notes-quick-input");
        const quickBtn = overlay.querySelector("#webex-notes-quick-btn");
        const listContainer = overlay.querySelector("#webex-notes-items-container");
        const countBadge = overlay.querySelector("#webex-notes-count-badge");
        const searchInput = overlay.querySelector("#webex-notes-search-input");
        const searchContainer = overlay.querySelector("#webex-notes-search-container");
        const exportBtn = overlay.querySelector("#webex-notes-export-btn");
        const clearBtn = overlay.querySelector("#webex-notes-clear-btn");
        const timePill = overlay.querySelector("#webex-notes-time-pill");

        // Keep current time pill updated if video is playing
        let noteTime = curTime;
        const timeInterval = setInterval(() => {
            if (!document.body.contains(overlay)) {
                clearInterval(timeInterval);
                return;
            }
            const v = getPrimaryVideo();
            if (v && !quickInput.value) {
                noteTime = Math.floor(v.currentTime || 0);
                if (timePill) timePill.innerText = `⏱️ ${formatTime(noteTime)}`;
            }
        }, 1000);

        function escapeNoteHtml(str) {
            return (str || "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }

        function renderNotes(filterText = "") {
            const query = filterText.toLowerCase().trim();
            const filtered = query ? notes.filter(n => (n.text || "").toLowerCase().includes(query)) : notes;

            countBadge.innerText = `${notes.length} note`;
            if (notes.length === 0) {
                searchContainer.style.display = "none";
                exportBtn.style.display = "none";
                clearBtn.style.display = "none";
                listContainer.innerHTML = `
                    <div class="webex-notes-empty">
                        <div class="webex-notes-empty-icon">📝</div>
                        <b style="color: #f1f5f9; font-size: 13.5px; display: block; margin-bottom: 4px;">Nessuna nota per questa lezione</b>
                        <p style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 1.5;">
                            Scrivi un appunto nel riquadro in alto oppure premi <kbd style="background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-weight: 700; color: #38bdf8;">N</kbd> durante la lezione per salvare una nota al volo!
                        </p>
                    </div>
                `;
                return;
            }

            searchContainer.style.display = "flex";
            exportBtn.style.display = "flex";
            clearBtn.style.display = "flex";

            if (filtered.length === 0) {
                listContainer.innerHTML = `
                    <div class="webex-notes-empty" style="padding: 24px 16px;">
                        <span style="font-size: 20px;">🔍</span>
                        <p style="margin: 8px 0 0 0; color: #94a3b8; font-size: 12px;">Nessuna nota corrisponde a "${escapeNoteHtml(filterText)}"</p>
                    </div>
                `;
                return;
            }

            listContainer.innerHTML = filtered.map((n, idx) => {
                const originalIdx = notes.indexOf(n);
                return `
                    <div class="webex-notes-card-item" data-time="${n.time}" data-idx="${originalIdx}" title="Clicca per saltare a questo punto della lezione">
                        <div class="webex-notes-card-header">
                            <span class="webex-notes-card-date">${n.date || 'Lezione'}</span>
                            <div class="webex-notes-card-actions">
                                <button class="webex-notes-card-del-btn" data-idx="${originalIdx}" title="Elimina questa nota">🗑️</button>
                            </div>
                        </div>
                        <div class="webex-notes-card-text">${escapeNoteHtml(n.text)}</div>
                    </div>
                `;
            }).join("");

            // Click card row to jump directly to timestamp without left time column
            listContainer.querySelectorAll(".webex-notes-card-item").forEach(card => {
                card.onclick = (e) => {
                    if (e.target.closest(".webex-notes-card-del-btn")) return;
                    const t = parseFloat(card.dataset.time);
                    if (!isNaN(t)) {
                        const prim = getPrimaryVideo();
                        if (prim) safeSeek(prim, t, true);
                        showHUD(`Salta al momento della nota (${formatTime(t)})`, "📝");
                        card.classList.remove("just-jumped");
                        void card.offsetWidth;
                        card.classList.add("just-jumped");
                    }
                };
            });

            // Delete single note
            listContainer.querySelectorAll(".webex-notes-card-del-btn").forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const i = parseInt(btn.dataset.idx, 10);
                    if (!isNaN(i) && notes[i]) {
                        notes.splice(i, 1);
                        saveNotesToStorage();
                        renderNotes(searchInput ? searchInput.value : "");
                        showHUD("Nota eliminata", "🗑️");
                    }
                };
            });
        }

        function saveNotesToStorage() {
            try {
                localStorage.setItem(key, JSON.stringify(notes));
                chrome.storage?.local?.set({ [key]: notes });
            } catch (_) {}
            if (chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    type: "SAVE_LECTURE_NOTES",
                    lectureId: recId,
                    notes: notes
                }, () => {});
            }
        }

        function saveQuickNote() {
            const val = quickInput.value.trim();
            if (!val) return;

            const newNote = {
                time: noteTime,
                formatted: formatTime(noteTime),
                text: val,
                date: new Date().toLocaleDateString()
            };

            notes.unshift(newNote); // Put newest note on top
            saveNotesToStorage();
            quickInput.value = "";
            renderNotes();
            showHUD(`Nota salvata per ${newNote.formatted}`, "📝");

            // Refocus video time
            const v = getPrimaryVideo();
            if (v) noteTime = Math.floor(v.currentTime || 0);
            if (timePill) timePill.innerText = `⏱️ ${formatTime(noteTime)}`;
        }

        quickBtn.onclick = saveQuickNote;
        quickInput.onkeydown = (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                saveQuickNote();
            }
        };

        if (searchInput) {
            searchInput.oninput = () => renderNotes(searchInput.value);
        }

        exportBtn.onclick = () => exportNotesToMarkdown(notes);
        clearBtn.onclick = () => {
            if (confirm("Vuoi eliminare tutte le note salvate per questa lezione?")) {
                notes = [];
                saveNotesToStorage();
                renderNotes();
                showHUD("Tutte le note eliminate", "🗑️");
            }
        };

        // Render initial notes list
        renderNotes();

        if (focusQuickAdd) {
            setTimeout(() => quickInput.focus(), 80);
        }
    }

    function exportNotesToMarkdown(notes) {
        const title = document.title || "Lezione_Webex";
        let md = `# 📝 Note Lezione: ${title}\n\n`;
        md += `*Data:* ${new Date().toLocaleDateString()}\n`;
        md += `*Link:* [${window.location.href}](${window.location.href})\n\n`;
        md += `## 📌 Punti Salienti e Appunti\n\n`;

        notes.forEach(n => {
            md += `- **[${n.formatted}]**: ${n.text}\n`;
        });

        const bmKey = "webex_bm_" + window.location.pathname;
        let bms = [];
        try { bms = JSON.parse(localStorage.getItem(bmKey) || "[]"); } catch (e) {}
        if (bms.length > 0) {
            md += `\n## 📌 Segnalibri Temporali\n\n`;
            bms.forEach(b => {
                md += `- ⏱ **${b.formatted}** (salvato il ${b.date})\n`;
            });
        }

        const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Note_${title.replace(/[^\w\s\d\-_~]/g, "_")}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showHUD("File Markdown scaricato per Notion/Obsidian! 📝", "📥");
    }

    // --- Auto-Resume & ETA ---
    function checkAutoResume() {
        if (autoResumePrompted) return;
        const video = getPrimaryVideo();
        if (!video) return;

        const recId = getRecordingId();
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem("webex_resume_" + recId) || "null");
        } catch (e) {}

        if (saved && saved.time > 20 && (!video.duration || saved.time < video.duration - 20)) {
            autoResumePrompted = true;
            const banner = document.createElement("div");
            banner.className = "webex-helper-resume-banner";
            banner.innerHTML = `
                <span>📍 Riprendere da <b>${formatTime(saved.time)}</b>?</span>
                <button class="webex-helper-resume-btn" id="webex-resume-yes">Riprendi (Invio)</button>
                <button style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;" id="webex-resume-no">✕</button>
            `;
            document.body.appendChild(banner);
            setTimeout(() => banner.classList.add("visible"), 300);

            const accept = () => {
                video.currentTime = saved.time;
                video.play().catch(() => {});
                banner.classList.remove("visible");
                setTimeout(() => banner.remove(), 400);
                showHUD(`Ripresa da ${formatTime(saved.time)}`, "📍");
            };

            const dismiss = () => {
                banner.classList.remove("visible");
                setTimeout(() => banner.remove(), 400);
            };

            banner.querySelector("#webex-resume-yes").onclick = accept;
            banner.querySelector("#webex-resume-no").onclick = dismiss;

            const onKeyResume = (e) => {
                if (e.key === "Enter" && banner.isConnected) {
                    accept();
                    window.removeEventListener("keydown", onKeyResume);
                }
            };
            window.addEventListener("keydown", onKeyResume);

            setTimeout(() => { if (banner.isConnected) dismiss(); }, 9000);
        }
    }

    function saveResumePosition() {
        const video = getPrimaryVideo();
        if (!video || video.paused || video.currentTime < 5) return;
        const recId = getRecordingId();
        try {
            localStorage.setItem("webex_resume_" + recId, JSON.stringify({
                time: Math.floor(video.currentTime),
                date: Date.now()
            }));
        } catch (e) {}
    }

    function updateETADisplay() {
        const video = getPrimaryVideo();
        const etaEl = document.getElementById("webex-eta-display");
        if (!video || !etaEl || !video.duration) return;

        const remainingSec = Math.max(0, (video.duration - video.currentTime) / (video.playbackRate || 1));
        const hrs = Math.floor(remainingSec / 3600);
        const mins = Math.floor((remainingSec % 3600) / 60);
        const eta = new Date(Date.now() + remainingSec * 1000);
        const etaH = eta.getHours();
        const etaM = eta.getMinutes() < 10 ? '0' + eta.getMinutes() : eta.getMinutes();

        etaEl.innerText = `${hrs > 0 ? hrs + 'h ' : ''}${mins}m (Fine: ${etaH}:${etaM})`;
    }

    // --- Bookmarks & Timeline Diamond Markers ---
    function getBookmarksKey() {
        return 'webex_bm_' + (getRecordingId() || window.location.pathname);
    }

    function getBookmarks() {
        const key = getBookmarksKey();
        let list = [];
        try { list = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
        if (list.length === 0) {
            try { list = JSON.parse(localStorage.getItem('webex_bm_' + window.location.pathname) || '[]'); } catch (_) {}
        }
        return list;
    }

    function saveBookmarks(list) {
        const key = getBookmarksKey();
        try {
            localStorage.setItem(key, JSON.stringify(list));
            localStorage.setItem('webex_bm_' + window.location.pathname, JSON.stringify(list));
            chrome.storage?.local?.set({ [key]: list });
        } catch (e) {}
        if (chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({
                type: "SAVE_LECTURE_BOOKMARKS",
                lectureId: getRecordingId(),
                bookmarks: list
            }, () => {});
        }
        renderTimelineMarkers();
        updateBookmarkFlyout();
    }

    function addBookmark() {
        const video = getPrimaryVideo();
        if (!video) return;

        const time = Math.floor(video.currentTime);
        const hrs = Math.floor(time / 3600);
        const mins = Math.floor((time % 3600) / 60);
        const secs = time % 60;
        const formatted = `${hrs > 0 ? hrs + ':' : ''}${(mins < 10 ? '0' : '') + mins}:${(secs < 10 ? '0' : '') + secs}`;

        const list = getBookmarks();
        list.push({ time, formatted, date: new Date().toLocaleTimeString() });
        saveBookmarks(list);
        showHUD(`Segnalibro aggiunto (${formatted})`, "📌");
    }

    function updateBookmarkFlyout() {
        const list = getBookmarks();
        const quickList = document.getElementById("webex-bm-quick-list");
        const qaQuickList = document.getElementById("webex-qa-bm-list");

        [quickList, qaQuickList].forEach(containerEl => {
            if (!containerEl) return;
            containerEl.innerHTML = "";
            if (list.length === 0) {
                containerEl.innerHTML = `<span style="color:#94a3b8; font-size:11px; padding: 6px; display: block; text-align: center;">Nessun segnalibro</span>`;
                return;
            }
            list.forEach((bm, idx) => {
                const row = document.createElement("div");
                row.className = "webex-bm-quick-item";
                row.innerHTML = `
                    <span class="webex-bm-quick-time" data-time="${bm.time}" style="cursor: pointer;">⏱ ${bm.formatted}</span>
                    <button class="webex-bm-quick-del" data-idx="${idx}" title="Elimina" style="cursor: pointer; background: transparent; border: none; font-size: 11px;">🗑️</button>
                `;
                row.querySelector(".webex-bm-quick-time").onclick = (e) => {
                    e.stopPropagation();
                    const video = getPrimaryVideo();
                    if (video) safeSeek(video, bm.time, true);
                    showHUD(`Saltato a ${bm.formatted}`, "⏱");
                };
                row.querySelector(".webex-bm-quick-del").onclick = (e) => {
                    e.stopPropagation();
                    list.splice(idx, 1);
                    saveBookmarks(list);
                    updateBookmarkFlyout();
                };
                containerEl.appendChild(row);
            });
        });
    }

    function renderTimelineMarkers() {
        const video = getPrimaryVideo();
        if (!video || !video.duration || isNaN(video.duration)) return;

        const progressHolder = document.querySelector('.vjs-progress-holder, .vjs-progress-control, [class*="progress-holder"]');
        if (!progressHolder) return;

        let markersBox = progressHolder.querySelector('.webex-timeline-markers-container');
        if (!markersBox) {
            markersBox = document.createElement('div');
            markersBox.className = 'webex-timeline-markers-container';
            progressHolder.appendChild(markersBox);
        }

        markersBox.innerHTML = '';
        const list = getBookmarks();
        list.forEach((bm) => {
            const pct = Math.min(100, Math.max(0, (bm.time / video.duration) * 100));
            const marker = document.createElement('div');
            marker.className = 'webex-timeline-marker';
            marker.style.left = `${pct}%`;
            marker.title = `⏱ ${bm.formatted} - Segnalibro`;
            marker.onclick = (e) => {
                e.stopPropagation();
                safeSeek(video, bm.time, true);
                showHUD(`Saltato a ${bm.formatted}`, "⏱");
            };
            markersBox.appendChild(marker);
        });
    }

    function showBookmarksModal() {
        const list = getBookmarks();

        const overlay = document.createElement("div");
        overlay.className = "webex-helper-modal-overlay";

        let html = `
            <div class="webex-helper-modal" id="webex-bm-list-card">
                <div class="webex-helper-modal-header" id="webex-bm-list-header">
                    <span class="webex-helper-modal-title">📌 Segnalibri Lezione</span>
                    <button class="webex-helper-close-btn" id="webex-bm-close">✕</button>
                </div>
        `;

        if (list.length === 0) {
            html += `<p style="color: #94a3b8; font-size: 13px; text-align: center; margin: 20px 0;">Nessun segnalibro salvato per questa registrazione.<br>Premi <kbd>B</kbd> durante la lezione per salvarne uno!</p>`;
        } else {
            html += `<div class="webex-helper-bm-list">`;
            list.forEach((bm, idx) => {
                html += `
                    <div class="webex-helper-bm-item webex-bm-clickable-row" data-time="${bm.time}" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; width: 100%;">
                        <div style="font-size: 13px; color: #f1f5f9; font-weight: 500;">📌 Segnalibro ${idx + 1}</div>
                        <div style="display: flex; gap: 8px; align-items: center;">
                            <span style="font-size: 11px; color: #64748b;">${bm.date}</span>
                            <button class="webex-helper-bm-del" data-idx="${idx}">🗑️</button>
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        html += `</div>`;
        overlay.innerHTML = html;
        const targetRoot = document.fullscreenElement || document.body;
        targetRoot.appendChild(overlay);

        const card = overlay.querySelector("#webex-bm-list-card");
        const header = overlay.querySelector("#webex-bm-list-header");
        makeDraggable(card, header);

        overlay.querySelector("#webex-bm-close").onclick = () => overlay.remove();

        overlay.querySelectorAll(".webex-bm-clickable-row").forEach(btn => {
            btn.onclick = (e) => {
                if (e.target.closest(".webex-helper-bm-del")) return;
                const t = parseFloat(btn.dataset.time);
                const prim = getPrimaryVideo();
                if (prim) safeSeek(prim, t, true);
                showHUD(`Saltato a ${formatTime(t)}`, "📌");
                overlay.remove();
            };
        });

        overlay.querySelectorAll(".webex-helper-bm-del").forEach(btn => {
            btn.onclick = () => {
                const idx = parseInt(btn.dataset.idx);
                list.splice(idx, 1);
                saveBookmarks(list);
                overlay.remove();
                showBookmarksModal();
            };
        });
    }

    function showShortcutsModal() {
        const overlay = document.createElement("div");
        overlay.className = "webex-helper-modal-overlay";
        overlay.innerHTML = `
            <div class="webex-helper-modal">
                <div class="webex-helper-modal-header">
                    <span class="webex-helper-modal-title">⌨️ Scorciatoie da Tastiera</span>
                    <button class="webex-helper-close-btn" id="webex-help-close">✕</button>
                </div>
                <table class="webex-helper-shortcut-table">
                    <tr><td><kbd>Spazio</kbd> o <kbd>K</kbd></td><td>Play / Pausa</td></tr>
                    <tr><td><kbd>→</kbd> / <kbd>←</kbd></td><td>Avanti / Indietro 10 secondi</td></tr>
                    <tr><td><kbd>Shift</kbd> + <kbd>→</kbd> / <kbd>←</kbd></td><td>Avanti / Indietro 30 secondi</td></tr>
                    <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>Velocità +0.1x / -0.1x</td></tr>
                    <tr><td><kbd>]</kbd> / <kbd>[</kbd></td><td>Velocità +0.25x / -0.25x</td></tr>
                    <tr><td><kbd>R</kbd></td><td>Ripristina / Alterna 1.0x e velocità preferita</td></tr>
                    <tr><td><kbd>Shift</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd></td><td>Volume +5% / -5%</td></tr>
                    <tr><td><kbd>M</kbd></td><td>Muto / Riattiva audio</td></tr>
                    <tr><td><kbd>S</kbd></td><td>📸 Screenshot istantaneo della slide corrente</td></tr>
                    <tr><td><kbd>P</kbd></td><td>🪟 Picture-in-Picture (video fluttuante)</td></tr>
                    <tr><td><kbd>F</kbd></td><td>Schermo intero (Fullscreen)</td></tr>
                    <tr><td><kbd>B</kbd></td><td>📌 Aggiungi segnalibro al minuto attuale</td></tr>
                    <tr><td><kbd>Z</kbd></td><td>🔍 Zoom slide e trascina con il mouse</td></tr>
                    <tr><td><kbd>I</kbd></td><td>🌙 Dark Mode per slide bianche</td></tr>
                    <tr><td><kbd>C</kbd></td><td>🎨 Filtri contrasto lavagna</td></tr>
                    <tr><td><kbd>A</kbd> / <kbd>B</kbd></td><td>🔁 Loop A-B ripetizione passaggio</td></tr>
                    <tr><td><kbd>X</kbd></td><td>🤫 Salto automatico pause di silenzio</td></tr>
                    <tr><td><kbd>N</kbd></td><td>📝 Prendi nota veloce al minuto corrente</td></tr>
                    <tr><td><kbd>T</kbd></td><td>💬 Sottotitoli & Trascrizione Interattiva (Spotify)</td></tr>
                    <tr><td><kbd>H</kbd></td><td>Mostra / Minimizza barra comandi</td></tr>
                </table>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector("#webex-help-close").onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    }

    // =========================================================================
    // SPOTIFY-STYLE INTERACTIVE SUBTITLES & LIVE TRANSCRIPT
    // =========================================================================
    let subtitlesCues = [];
    let activeCueIdx = -1;
    let isSubtitlesPanelOpen = false;
    let isCCOverlayEnabled = localStorage.getItem("webex_cc_enabled") !== "false";
    let isUserInteractingWithSubtitles = false;
    let subtitleInteractTimeout = null;
    let subtitlesPanelEl = null;
    let ccOverlayEl = null;

    function parseSubtitleText(rawText) {
        if (!rawText || typeof rawText !== "string") return [];
        const text = rawText.trim();
        if (!text) return [];

        // 1. JSON format
        if (text.startsWith("{") || text.startsWith("[")) {
            try {
                const data = JSON.parse(text);
                const list = Array.isArray(data) ? data : (data.cues || data.transcripts || data.transcript || data.items || data.words || []);
                if (Array.isArray(list) && list.length > 0) {
                    return list.map(item => {
                        const start = typeof item.start === "number" ? item.start : (parseFloat(item.startTime || item.begin || 0));
                        const end = typeof item.end === "number" ? item.end : (parseFloat(item.endTime || item.finish || start + 3));
                        const content = item.text || item.content || item.transcript || item.word || "";
                        return { start, end, text: String(content).trim() };
                    }).filter(x => x.text.length > 0).sort((a, b) => a.start - b.start);
                }
            } catch (_) {}
        }

        // 2. WebVTT & SubRip (SRT) format
        const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        const cues = [];
        const timeRegex = /(?:(?:(\d{1,2}):)?(\d{2}):)?(\d{2})[,.](\d{3})\s*-->\s*(?:(?:(\d{1,2}):)?(\d{2}):)?(\d{2})[,.](\d{3})/;

        let i = 0;
        while (i < lines.length) {
            let line = lines[i].trim();
            if (!line || line.startsWith("WEBVTT") || line.startsWith("NOTE")) {
                i++;
                continue;
            }

            let match = line.match(timeRegex);
            if (!match && i + 1 < lines.length) {
                match = lines[i + 1].trim().match(timeRegex);
                if (match) {
                    i++;
                }
            }

            if (match) {
                const parseTime = (h, m, s, ms) => {
                    const hours = h ? parseInt(h, 10) : 0;
                    const minutes = m ? parseInt(m, 10) : 0;
                    const seconds = s ? parseInt(s, 10) : 0;
                    const milliseconds = ms ? parseInt(ms, 10) : 0;
                    return hours * 3600 + minutes * 60 + seconds + (milliseconds / 1000);
                };

                const startTime = parseTime(match[1], match[2], match[3], match[4]);
                const endTime = parseTime(match[5], match[6], match[7], match[8]);

                i++;
                const textLines = [];
                while (i < lines.length && lines[i].trim() !== "" && !lines[i].match(timeRegex)) {
                    const clean = lines[i].replace(/<[^>]+>/g, "").trim();
                    if (clean) textLines.push(clean);
                    i++;
                }

                if (textLines.length > 0) {
                    cues.push({
                        start: startTime,
                        end: endTime > startTime ? endTime : startTime + 2.5,
                        text: textLines.join(" ")
                    });
                }
            } else {
                i++;
            }
        }

        if (cues.length === 0) {
            const singleTimeRegex = /^[\[\(]?(?:(?:(\d{1,2}):)?(\d{2}):)?(\d{2})[\]\)]?[\s:-]+(.*)$/;
            for (let j = 0; j < lines.length; j++) {
                const l = lines[j].trim();
                const m = l.match(singleTimeRegex);
                if (m && m[4] && m[4].trim()) {
                    const h = m[1] ? parseInt(m[1], 10) : 0;
                    const min = m[2] ? parseInt(m[2], 10) : 0;
                    const sec = parseInt(m[3], 10);
                    const startSec = h * 3600 + min * 60 + sec;
                    cues.push({
                        start: startSec,
                        end: startSec + 4,
                        text: m[4].trim()
                    });
                }
            }
            for (let k = 0; k < cues.length - 1; k++) {
                if (cues[k + 1].start > cues[k].start) {
                    cues[k].end = cues[k + 1].start;
                }
            }
        }

        return cues.sort((a, b) => a.start - b.start);
    }

    // Manual Subtitle Rescan / Refresh
    let isSearchingSubtitles = false;

    async function manualRescanSubtitles() {
        if (isSearchingSubtitles) return;
        isSearchingSubtitles = true;
        const recId = getRecordingId();
        if (recId) {
            try { localStorage.removeItem(`webex_subtitles_${recId}`); } catch (_) {}
        }
        subtitlesCues = [];
        activeCueIdx = -1;
        await autoDetectWebexSubtitles(true);
        isSearchingSubtitles = false;
    }

    function showPasteTranscriptModal() {
        const overlay = document.createElement("div");
        overlay.className = "webex-helper-modal-overlay";
        overlay.innerHTML = `
            <div class="webex-helper-modal" style="width: 500px; max-width: 90vw;">
                <div class="webex-helper-modal-header">
                    <span class="webex-helper-modal-title">📋 Incolla Trascrizione / Sottotitoli</span>
                    <button class="webex-helper-close-btn" id="modal-paste-close">✕</button>
                </div>
                <p style="font-size: 11.5px; color: #94a3b8; margin-bottom: 8px; line-height: 1.5;">
                    Incolla il testo con minutaggi (es. <i>00:01:25 introduzione teorema</i> oppure formato <i>.srt / .vtt / Whisper</i>):
                </p>
                <textarea id="modal-paste-textarea" placeholder="00:00:05 Buongiorno a tutti, oggi parleremo di..." style="width: 100%; height: 190px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; color: #f1f5f9; padding: 10px; font-size: 12px; font-family: monospace; resize: vertical; outline: none;"></textarea>
                <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px;">
                    <button class="webex-subtitles-action-btn" id="modal-paste-cancel">Annulla</button>
                    <button class="webex-subtitles-action-btn active" id="modal-paste-save">Carica Trascrizione</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector("#modal-paste-close").onclick = () => overlay.remove();
        overlay.querySelector("#modal-paste-cancel").onclick = () => overlay.remove();
        overlay.querySelector("#modal-paste-save").onclick = () => {
            const text = overlay.querySelector("#modal-paste-textarea").value;
            const parsed = parseSubtitleText(text);
            if (parsed.length > 0) {
                loadSubtitles(parsed, "Testo Incollato");
                try {
                    const recId = getRecordingId();
                    if (recId) localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(parsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(parsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(parsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
}
                } catch (_) {}
                overlay.remove();
            } else {
                showHUD("Nessun minutaggio o testo valido rilevato", "⚠️");
            }
        };
    }

    function initSubtitlesUI() {
        if (subtitlesPanelEl) return;

        // Create Subtitles Modal
        subtitlesPanelEl = document.createElement("div");
        subtitlesPanelEl.className = "webex-subtitles-modal";
        subtitlesPanelEl.id = "webex-subtitles-panel";
        subtitlesPanelEl.style.display = "none";
        subtitlesPanelEl.innerHTML = `
            <div class="webex-subtitles-header" id="webex-subtitles-header">
                <div class="webex-subtitles-title-box">
                    <span class="webex-subtitles-title">Trascrizione</span>
                    <span class="webex-subtitles-status-badge" id="webex-subtitles-count-badge">0 frasi</span>
                </div>
                <div class="webex-subtitles-actions">
                    <button class="webex-subtitles-action-btn ${isCCOverlayEnabled ? 'active' : ''}" id="webex-subtitles-toggle-cc" title="Mostra/Nascondi sottotitoli a schermo (CC)">
                        <span>CC Schermo</span>
                    </button>
                    <button class="webex-subtitles-close-btn" id="webex-subtitles-close" title="Chiudi (T / Esc)">✕ Chiudi</button>
                </div>
            </div>
            <div class="webex-subtitles-search-box">
                <input type="text" class="webex-subtitles-search-input" id="webex-subtitles-search" placeholder="🔍 Cerca qualsiasi parola...">
            </div>
            <div class="webex-subtitles-toolbar" id="webex-subtitles-toolbar" style="display: none;">
                <div style="display: inline-flex; align-items: stretch; gap: 2px;">
                    <button class="webex-subtitles-action-btn" id="webex-subtitles-btn-ai" title="Estrai traccia audio e genera trascrizione vocale AI (senza microfono)" style="background: linear-gradient(135deg, rgba(2, 132, 199, 0.4), rgba(56, 189, 248, 0.25)); border-color: #38bdf8; color: #ffffff; font-weight: 700; border-top-right-radius: 4px; border-bottom-right-radius: 4px;">
                        <span>⚡ Scarica Audio & Trascrivi con AI</span>
                    </button>
                    <button class="webex-subtitles-action-btn" id="webex-subtitles-btn-ai-settings" title="Configurazione AI Whisper (Chiave API, Limiti Free Tier e Guida)" style="background: rgba(56, 189, 248, 0.2); border-color: #38bdf8; color: #38bdf8; border-top-left-radius: 4px; border-bottom-left-radius: 4px; padding: 5px 8px;">
                        <span>⚙️</span>
                    </button>
                </div>
                <button class="webex-subtitles-action-btn" id="webex-subtitles-btn-paste" title="Incolla trascrizione o testo manuale">
                    <span>📋 Incolla Testo</span>
                </button>
                <button class="webex-subtitles-action-btn" id="webex-subtitles-btn-refresh" title="Riprova ricerca automatica sottotitoli Webex">
                    <span>🔄 Cerca da Webex</span>
                </button>
                <label class="webex-subtitles-action-btn" title="Carica file sottotitoli (.vtt, .srt, .sbv, .txt, .json)">
                    <span>📁 Carica File</span>
                    <input type="file" accept=".vtt,.srt,.sbv,.txt,.json" id="webex-subtitles-file-input" style="display: none;">
                </label>
            </div>
            <div class="webex-subtitles-list" id="webex-subtitles-cues-list">
                <!-- Rendered dynamically -->
            </div>
                        <div class="webex-subtitles-footer" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px;">
                <span class="webex-subtitles-footer-info">💡 Clicca su una parola per saltare • T o Esc per chiudere</span>
                                <button class="webex-subtitles-action-btn" id="webex-subtitles-btn-export" title="Esporta trascrizione in un file di testo (.txt)" style="background: rgba(56, 189, 248, 0.15); border-color: rgba(56, 189, 248, 0.4); color: #38bdf8; padding: 4px 8px; margin-right: 8px;">
                    <span>📄 Esporta Testo</span>
                </button>
                <button class="webex-subtitles-action-btn danger-btn" id="webex-subtitles-btn-delete" title="Elimina questa traccia di sottotitoli e torna alla schermata iniziale" style="display: none; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); color: #fca5a5; padding: 4px 8px;">
                    <span>🗑️ Elimina Traccia</span>
                </button>
            </div>
        `;
        document.body.appendChild(subtitlesPanelEl);

        // Create On-Video CC Glass Overlay
        ccOverlayEl = document.createElement("div");
        ccOverlayEl.className = "webex-video-cc-overlay is-hidden";
        ccOverlayEl.id = "webex-video-cc-display";
        
        const targetContainer = getPlayerContainer() || document.body;
        targetContainer.appendChild(ccOverlayEl);


    let isMouseNearBottom = false;
    document.addEventListener("mousemove", (e) => {
        const vid = getPrimaryVideo();
        let hoveringBar = false;
        const qBar = document.getElementById("webex-quick-actions-bar");
        const helperTb = document.getElementById("webex-helper-toolbar-container");
        if (qBar && helperTb && helperTb.classList.contains("collapsed")) {
            const bRect = qBar.getBoundingClientRect();
            if (e.clientX >= bRect.left && e.clientX <= bRect.right && e.clientY >= bRect.top && e.clientY <= bRect.bottom) {
                hoveringBar = true;
            }
        }
        
        if (vid) {
            const rect = vid.getBoundingClientRect();
            // If mouse is within the bottom 140px of the video (where timelines usually are)
            if ((e.clientY > rect.bottom - 140 && e.clientY <= rect.bottom && e.clientX >= rect.left && e.clientX <= rect.right) || hoveringBar) {
                isMouseNearBottom = true;
            } else {
                isMouseNearBottom = false;
            }
        }
    });

        


    function repositionCCOverlay() {
            const vid = getPrimaryVideo();
            if (vid && ccOverlayEl) {
                const rect = vid.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    // Check if native Webex controls are active (user hover) or buffer controls are active
                    const offset = isMouseNearBottom ? 150 : 70;
                    
                    ccOverlayEl.style.left = `${rect.left + rect.width / 2}px`;
                    ccOverlayEl.style.top = `${rect.bottom - offset}px`;
                    ccOverlayEl.style.bottom = "auto";
                }
            }
        }
        window.addEventListener("resize", repositionCCOverlay);
        setInterval(repositionCCOverlay, 1200);

        // Header Dragging
        const header = subtitlesPanelEl.querySelector("#webex-subtitles-header");
        let isDragging = false;
        let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

        header.addEventListener("mousedown", (e) => {
            if (e.target.closest("button") || e.target.closest("label") || e.target.closest("input")) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = subtitlesPanelEl.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            subtitlesPanelEl.style.left = `${Math.max(10, initialLeft + dx)}px`;
            subtitlesPanelEl.style.top = `${Math.max(10, initialTop + dy)}px`;
            subtitlesPanelEl.style.right = "auto";
        });

        window.addEventListener("mouseup", () => {
            isDragging = false;
        });

        // Close buttons (Header & Footer)
        const topCloseBtn = subtitlesPanelEl.querySelector("#webex-subtitles-close");
        if (topCloseBtn) topCloseBtn.onclick = () => toggleSubtitlesPanel(false);


        const btnExport = document.getElementById("webex-subtitles-btn-export");
        if (btnExport) {
            btnExport.onclick = () => {
                if (!subtitlesCues || subtitlesCues.length === 0) return;
                let txt = "Trascrizione Lezione\n\n";
                subtitlesCues.forEach(c => {
                    const h = Math.floor(c.start / 3600).toString().padStart(2, '0');
                    const m = Math.floor((c.start % 3600) / 60).toString().padStart(2, '0');
                    const s = Math.floor(c.start % 60).toString().padStart(2, '0');
                    txt += `[${h}:${m}:${s}] ${c.text}\n`;
                });
                const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `Trascrizione_${(document.title || "Lezione").replace(/[^a-z0-9]/gi, '_')}.txt`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            };
        }
    
        const footerCloseBtn = subtitlesPanelEl.querySelector("#webex-subtitles-footer-close");
        if (footerCloseBtn) footerCloseBtn.onclick = () => toggleSubtitlesPanel(false);

        // AI Transcribe Button in Toolbar
        const btnAi = subtitlesPanelEl.querySelector("#webex-subtitles-btn-ai");
        if (btnAi) btnAi.onclick = () => startAITranscription();

        // AI Settings Button in Toolbar
        const btnAiSettings = subtitlesPanelEl.querySelector("#webex-subtitles-btn-ai-settings");
        if (btnAiSettings) btnAiSettings.onclick = async () => {
            if (typeof AITranscriber !== "undefined" && AITranscriber.promptForGroqApiKey) {
                await AITranscriber.promptForGroqApiKey();
            }
        };

        // Refresh Subtitles Button in Toolbar
        const btnRefresh = subtitlesPanelEl.querySelector("#webex-subtitles-btn-refresh");
        if (btnRefresh) btnRefresh.onclick = () => manualRescanSubtitles();

        // Paste Button in Toolbar
        const btnPaste = subtitlesPanelEl.querySelector("#webex-subtitles-btn-paste");
        if (btnPaste) btnPaste.onclick = showPasteTranscriptModal;

        // Delete Subtitles Track Button in Toolbar
        const btnDelete = subtitlesPanelEl.querySelector("#webex-subtitles-btn-delete");
        if (btnDelete) btnDelete.onclick = () => deleteCurrentSubtitlesTrack();

        // Toggle CC
        const btnToggleCC = subtitlesPanelEl.querySelector("#webex-subtitles-toggle-cc");
        btnToggleCC.onclick = () => {
            isCCOverlayEnabled = !isCCOverlayEnabled;
            localStorage.setItem("webex_cc_enabled", isCCOverlayEnabled ? "true" : "false");
            btnToggleCC.classList.toggle("active", isCCOverlayEnabled);
            if (!isCCOverlayEnabled && ccOverlayEl) {
                ccOverlayEl.classList.add("is-hidden");
            }
            showHUD(isCCOverlayEnabled ? "Sottotitoli a schermo: Attivi" : "Sottotitoli a schermo: Disattivati", "💬");
        };

        // File Input
        const fileInp = subtitlesPanelEl.querySelector("#webex-subtitles-file-input");
        fileInp.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (evt) => {
                    const parsed = parseSubtitleText(evt.target.result);
                    if (parsed.length > 0) {
                        loadSubtitles(parsed, file.name);
                        try {
                            const recId = getRecordingId();
                            if (recId) localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(parsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(parsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(parsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
}
                        } catch (_) {}
                    } else {
                        showHUD("Formato sottotitoli non riconosciuto", "⚠️");
                    }
                };
                reader.readAsText(file);
            }
        };

        // Search Input
        const searchInp = subtitlesPanelEl.querySelector("#webex-subtitles-search");
        searchInp.oninput = () => {
            const q = searchInp.value.trim().toLowerCase();
            if (!q) {
                renderSubtitlesList();
            } else {
                const filtered = subtitlesCues.filter(c => c.text.toLowerCase().includes(q));
                renderSubtitlesList(filtered);
            }
        };

        // Hover & Scroll detection to avoid auto-scroll fighting user reading
        const listEl = subtitlesPanelEl.querySelector("#webex-subtitles-cues-list");
        listEl.addEventListener("scroll", () => {
            isUserInteractingWithSubtitles = true;
            clearTimeout(subtitleInteractTimeout);
            subtitleInteractTimeout = setTimeout(() => {
                isUserInteractingWithSubtitles = false;
            }, 3000);
        });
        listEl.addEventListener("mouseenter", () => {
            isUserInteractingWithSubtitles = true;
        });
        listEl.addEventListener("mouseleave", () => {
            clearTimeout(subtitleInteractTimeout);
            subtitleInteractTimeout = setTimeout(() => {
                isUserInteractingWithSubtitles = false;
            }, 2000);
        });
    }

    function renderSubtitlesList(filteredCues = null) {
        initSubtitlesUI();
        const listEl = document.getElementById("webex-subtitles-cues-list");
        if (!listEl) return;
        const cuesToRender = filteredCues || subtitlesCues;

        if (cuesToRender.length === 0) {
            listEl.innerHTML = `
                <div class="webex-subtitles-empty">
                    <b>Nessuna frase trovata</b><br>
                    ${subtitlesCues.length === 0 ? "Carica un file .srt o .vtt con il pulsante <b>📁 Carica</b> in alto." : "Nessun risultato per la ricerca inserita."}
                </div>
            `;
            return;
        }

        listEl.innerHTML = "";
        cuesToRender.forEach((cue) => {
            const row = document.createElement("div");
            row.className = "webex-transcript-cue";
            row.dataset.start = cue.start;
            row.dataset.end = cue.end;

            const textSpan = document.createElement("span");
            textSpan.className = "cue-text";

            // Extract or interpolate exact word timestamps so every single word is interactive
            const words = (typeof AITranscriber !== "undefined" && AITranscriber.ensureWordTimestamps)
                ? AITranscriber.ensureWordTimestamps(cue)
                : (cue.words || []);

            if (words && words.length > 0) {
                words.forEach((w) => {
                    const wordSpan = document.createElement("span");
                    wordSpan.className = "spotify-word";
                    wordSpan.dataset.start = w.start;
                    wordSpan.dataset.end = w.end;
                    wordSpan.innerText = w.text;
                    wordSpan.title = `Salta a "${w.text}" (${formatTime(w.start)})`;

                    // Click on word jumps directly to that exact word timestamp
                    wordSpan.onclick = (e) => {
                        e.stopPropagation();
                        const vid = getPrimaryVideo();
                        if (vid) {
                            safeSeek(vid, w.start, true);
                            showHUD(`"${w.text}" (${formatTime(w.start)})`, "💬");
                        }
                    };

                    textSpan.appendChild(wordSpan);
                    textSpan.appendChild(document.createTextNode(" "));
                });
            } else {
                textSpan.innerText = cue.text;
            }

            row.appendChild(textSpan);

            // Clicking outside individual words jumps to beginning of sentence
            row.onclick = () => {
                const vid = getPrimaryVideo();
                if (vid) {
                    safeSeek(vid, cue.start, true);
                    showHUD(`Salta a ${formatTime(cue.start)}`, "💬");
                }
            };

            listEl.appendChild(row);
        });

        const currentVid = getPrimaryVideo();
        if (currentVid) updateSubtitlesHighlight(currentVid.currentTime, true);
    }

    function updateSubtitlesHighlight(currentTime, forceScroll = false) {
        if (subtitlesCues.length === 0) return;

        const newIdx = subtitlesCues.findIndex(c => currentTime >= c.start && currentTime <= c.end);

        // Update On-Video CC Overlay
        if (ccOverlayEl) {
            if (isCCOverlayEnabled && newIdx !== -1) {
                ccOverlayEl.innerText = subtitlesCues[newIdx].text;
                ccOverlayEl.classList.remove("is-hidden");
            } else {
                ccOverlayEl.classList.add("is-hidden");
            }
        }

        const listEl = document.getElementById("webex-subtitles-cues-list");
        if (!listEl) return;

        const cueChanged = (newIdx !== activeCueIdx) || forceScroll;
        if (cueChanged) {
            activeCueIdx = newIdx;
            
            // Re-evalute ALL rows to ensure past sentences are white and future are gray
            const allRows = listEl.querySelectorAll(".webex-transcript-cue");
            allRows.forEach((el, index) => {
                el.classList.remove("is-active");
                
                // Clear any individual word JS highlights
                el.querySelectorAll(".spotify-word").forEach(w => w.classList.remove("is-speaking", "is-past", "is-future"));

                const start = parseFloat(el.dataset.start);
                const end = parseFloat(el.dataset.end);

                if (newIdx !== -1) {
                    if (index < newIdx) {
                        el.classList.add("cue-past");
                        el.classList.remove("cue-future");
                    } else if (index > newIdx) {
                        el.classList.add("cue-future");
                        el.classList.remove("cue-past");
                    } else {
                        el.classList.remove("cue-past", "cue-future");
                    }
                } else {
                    if (currentTime >= end) {
                        el.classList.add("cue-past");
                        el.classList.remove("cue-future");
                    } else if (currentTime <= start) {
                        el.classList.add("cue-future");
                        el.classList.remove("cue-past");
                    }
                }
            });

            if (newIdx !== -1) {
                const activeCue = subtitlesCues[newIdx];
                const activeRow = listEl.querySelector(`.webex-transcript-cue[data-start="${activeCue.start}"]`);
                if (activeRow) {
                    activeRow.classList.add("is-active");
                    if (!isUserInteractingWithSubtitles || forceScroll) {
                        activeRow.scrollIntoView({ behavior: "smooth", block: "center" });
                    }
                }
            }
        }

        // Spotify Word-Level Dynamic Highlight (Word-by-word active glow)
        if (newIdx !== -1) {
            const activeRow = listEl.querySelector(".webex-transcript-cue.is-active");
            if (activeRow) {
                const wordSpans = activeRow.querySelectorAll(".spotify-word");
                wordSpans.forEach(wSpan => {
                    const wStart = parseFloat(wSpan.dataset.start);
                    const wEnd = parseFloat(wSpan.dataset.end);
                    if (currentTime >= wStart && currentTime <= wEnd) {
                        wSpan.classList.add("is-speaking");
                        wSpan.classList.remove("is-past", "is-future");
                    } else if (currentTime > wEnd) {
                        wSpan.classList.add("is-past");
                        wSpan.classList.remove("is-speaking", "is-future");
                    } else {
                        wSpan.classList.add("is-future");
                        wSpan.classList.remove("is-speaking", "is-past");
                    }
                });
            }
        }
    }

    function sanitizeWebexTitle(rawTitle) {
        if (!rawTitle || typeof rawTitle !== "string") return "";
        let t = rawTitle.trim();
        t = t.replace(/^(?:cisco\s*)?webex(?:\s*(?:enterprise|recordings?|player|meeting|lezione))?\s*[-–—|:]\s*/i, "");
        t = t.replace(/\s*[-–—|:]\s*(?:cisco\s*)?webex(?:\s*(?:enterprise|recordings?|player|meeting))?$/i, "");
        t = t.replace(/\.mp4$|\.webm$|\.mkv$/i, "");
        t = t.trim();
        return t || rawTitle.trim();
    }

    async function saveSubtitlesPermanently(recId, cues, sourceTitle = null) {
        if (!recId || !Array.isArray(cues) || cues.length === 0) return;
        const strData = JSON.stringify(cues);
        const pTitle = sanitizeWebexTitle(sourceTitle || document.title || "") || recId;
        const cleanTitle = pTitle.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const normTitle = pTitle.toLowerCase().replace(/\b(polimi|webex|lezione|videolezione|recording|enhancer)\b/gi, '').replace(/[-_~|:/\\]/g, ' ').replace(/\.mp4$|\.webm$|\.mkv$/i, '').replace(/\s+/g, ' ').trim().replace(/[^a-z0-9]/g, '_');

        try { localStorage.setItem(`webex_subtitles_${recId}`, strData); } catch (_) {}
        try {
            if (chrome.storage && chrome.storage.local) {
                const storeObj = {};
                storeObj[`webex_subtitles_${recId}`] = strData;
                if (cleanTitle) storeObj[`webex_subtitles_title_${cleanTitle}`] = strData;
                if (normTitle) storeObj[`webex_subtitles_norm_${normTitle}`] = strData;
                chrome.storage.local.set(storeObj);
            }
        } catch (_) {}

        if (window.WebexOfflineDB) {
            try {
                let lec = await window.WebexOfflineDB.getLecture(recId);
                if (!lec && pTitle) {
                    lec = await window.WebexOfflineDB.findLecture({ recordingId: recId, pageTitle: pTitle, pageUrl: window.location?.href });
                }
                if (lec) {
                    lec.subtitlesData = strData;
                    lec.transcript = strData;
                    if (!lec.originalTitle) lec.originalTitle = pTitle;
                    await window.WebexOfflineDB.saveLecture(lec);
                } else {
                    await window.WebexOfflineDB.saveLecture({
                        id: recId,
                        webexRecordingId: recId,
                        title: pTitle,
                        originalTitle: pTitle,
                        url: window.location?.href || "",
                        subtitlesData: strData,
                        transcript: strData,
                        date: new Date().toISOString()
                    });
                }
            } catch (err) {
                console.warn("[WebexHelper] Error saving subtitles to WebexOfflineDB:", err);
            }
        }

        // Cross-tab / cross-window sync with offline player
        try {
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    type: "SUBTITLES_UPDATED",
                    lectureId: recId,
                    title: pTitle,
                    cues: cues
                }).catch(() => {});
            }
        } catch (_) {}
    }

    function loadSubtitles(cues, sourceName = "") {
        if (typeof cues === "string") {
            try { cues = JSON.parse(cues); } catch (_) {}
        }
        if (!Array.isArray(cues) || cues.length === 0) return;
        subtitlesCues = cues.sort((a, b) => a.start - b.start);
        activeCueIdx = -1;

        initSubtitlesUI();

        const badge = document.getElementById("webex-subtitles-count-badge");
        if (badge) badge.innerText = `${subtitlesCues.length} frasi`;

        const delBtn = document.getElementById("webex-subtitles-btn-delete");
        if (delBtn) delBtn.style.display = "inline-flex";

        const searchBox = document.querySelector(".webex-subtitles-search-box");
        if (searchBox) searchBox.style.display = "block";
        
        const toolbarBox = document.getElementById("webex-subtitles-toolbar");
        if (toolbarBox) toolbarBox.style.display = "none";

        const recId = getRecordingId() || "webex_lesson";
        try { localStorage.removeItem(`webex_subtitles_user_deleted_${recId}`); } catch (_) {}
        saveSubtitlesPermanently(recId, subtitlesCues);

        renderSubtitlesList();
        showHUD(`Trascrizione caricata: ${sourceName || subtitlesCues.length + ' frasi'}`, "💬");

        const btnSub = document.getElementById("webex-action-subtitles");
        if (btnSub) btnSub.classList.toggle("active", !!isSubtitlesPanelOpen);
        const btnQaSub = document.getElementById("webex-qa-subtitles");
        if (btnQaSub) btnQaSub.classList.toggle("active", !!isSubtitlesPanelOpen);
    }

    async function deleteCurrentSubtitlesTrack() {
        const recId = getRecordingId() || "webex_lesson";
        const rawTitle = sanitizeWebexTitle(document.title || "");
        const cleanTitle = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const normTitle = rawTitle.toLowerCase().replace(/\b(polimi|webex|lezione|videolezione|recording|enhancer)\b/gi, '').replace(/[-_~|:/\\]/g, ' ').replace(/\.mp4$|\.webm$|\.mkv$/i, '').replace(/\s+/g, ' ').trim().replace(/[^a-z0-9]/g, '_');

        subtitlesCues = [];
        activeCueIdx = -1;
        try {
            localStorage.removeItem(`webex_subtitles_${recId}`);
            sessionStorage.removeItem(`webex_subtitles_${recId}`);
            localStorage.setItem(`webex_subtitles_user_deleted_${recId}`, "true");
            if (cleanTitle) localStorage.setItem(`webex_subtitles_user_deleted_${cleanTitle}`, "true");
            if (normTitle) localStorage.setItem(`webex_subtitles_user_deleted_${normTitle}`, "true");
        } catch (_) {}

        try {
            if (chrome.storage && chrome.storage.local) {
                const keysToRemove = [`webex_subtitles_${recId}`];
                if (cleanTitle) keysToRemove.push(`webex_subtitles_title_${cleanTitle}`);
                if (normTitle) keysToRemove.push(`webex_subtitles_norm_${normTitle}`);
                chrome.storage.local.remove(keysToRemove);
            }
        } catch (_) {}

        if (window.WebexOfflineDB) {
            try {
                if (recId) await window.WebexOfflineDB.deleteSubtitles(recId);
                let lec = await window.WebexOfflineDB.getLecture(recId);
                if (!lec && rawTitle) {
                    lec = await window.WebexOfflineDB.findLecture({ recordingId: recId, pageTitle: rawTitle, pageUrl: window.location?.href });
                }
                if (lec && lec.id) {
                    await window.WebexOfflineDB.deleteSubtitles(lec.id);
                }
            } catch (err) {
                console.warn("[WebexHelper] Error deleting subtitles from WebexOfflineDB:", err);
            }
        }

        const badge = document.getElementById("webex-subtitles-count-badge");
        if (badge) badge.innerText = "0 frasi";

        const delBtn = document.getElementById("webex-subtitles-btn-delete");
        if (delBtn) delBtn.style.display = "none";

        const searchBox = document.querySelector(".webex-subtitles-search-box");
        if (searchBox) searchBox.style.display = "none";

        const toolbarBox = document.getElementById("webex-subtitles-toolbar");
        if (toolbarBox) toolbarBox.style.display = "none";

        if (ccOverlayEl) {
            ccOverlayEl.innerText = "";
            ccOverlayEl.classList.add("is-hidden");
        }

        const btnSub = document.getElementById("webex-action-subtitles");
        if (btnSub) btnSub.classList.remove("active");
        const btnQaSub = document.getElementById("webex-qa-subtitles");
        if (btnQaSub) btnQaSub.classList.remove("active");

        renderSubtitlesEmptyState();
        showHUD("Traccia sottotitoli eliminata", "🗑️");

        // Broadcast deletion event
        try {
            if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({
                    type: "SUBTITLES_DELETED",
                    lectureId: recId,
                    title: rawTitle
                }).catch(() => {});
            }
        } catch (_) {}
    }

    function renderSubtitlesEmptyState() {
        const listEl = document.getElementById("webex-subtitles-cues-list");
        if (!listEl) return;
        listEl.innerHTML = `
            <div class="webex-subtitles-empty" id="webex-subtitles-empty-msg">
                <div style="font-size: 32px; margin-bottom: 10px;">🎙️</div>
                <b style="font-size: 14px; color: #f1f5f9;">Nessuna trascrizione caricata</b>
                <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 16px 0; line-height: 1.5; max-width: 440px; margin-left: auto; margin-right: auto;">
                    Scegli una delle opzioni:
                </p>
                <div style="display: flex; flex-direction: column; gap: 8px; max-width: 250px; margin: 0 auto; margin-bottom: 15px;">
                    <div style="display: flex; gap: 2px;">
                        <button class="webex-subtitles-action-btn" id="empty-btn-ai" style="flex: 1; justify-content: center; padding: 10px; border-top-right-radius: 4px; border-bottom-right-radius: 4px; background: linear-gradient(135deg, rgba(2, 132, 199, 0.4), rgba(56, 189, 248, 0.25)); border-color: #38bdf8; color: #ffffff; font-weight: 700;">⚡ Scarica e trascrivi con AI</button>
                        <button class="webex-subtitles-action-btn" id="empty-btn-ai-settings" title="Configurazione AI (API Key e Limiti)" style="background: rgba(56, 189, 248, 0.2); border-color: #38bdf8; color: #38bdf8; border-top-left-radius: 4px; border-bottom-left-radius: 4px; padding: 10px 12px;">⚙️</button>
                    </div>
                    <button class="webex-subtitles-action-btn" id="empty-btn-paste" style="width: 100%; justify-content: center; padding: 10px;">📋 Incolla testo</button>
                    <button class="webex-subtitles-action-btn" id="empty-btn-refresh" style="width: 100%; justify-content: center; padding: 10px;">🔍 Cerca da Webex</button>
                    <button class="webex-subtitles-action-btn" id="empty-btn-file" style="width: 100%; justify-content: center; padding: 10px;">📁 Carica file</button>
                </div>
            </div>
        `;
        
        // Attach click listeners to avoid CSP inline handler blocks
        setTimeout(() => {
            const btnAi = document.getElementById("empty-btn-ai");
            if (btnAi) btnAi.onclick = () => document.getElementById("webex-subtitles-btn-ai").click();
            
            const btnAiSettings = document.getElementById("empty-btn-ai-settings");
            if (btnAiSettings) btnAiSettings.onclick = () => document.getElementById("webex-subtitles-btn-ai-settings").click();
            
            const btnPaste = document.getElementById("empty-btn-paste");
            if (btnPaste) btnPaste.onclick = () => document.getElementById("webex-subtitles-btn-paste").click();
            
            const btnRefresh = document.getElementById("empty-btn-refresh");
            if (btnRefresh) btnRefresh.onclick = () => document.getElementById("webex-subtitles-btn-refresh").click();
            
            const btnFile = document.getElementById("empty-btn-file");
            if (btnFile) btnFile.onclick = () => document.getElementById("webex-subtitles-file-input").click();
        }, 50);

        const delBtn = document.getElementById("webex-subtitles-btn-delete");
        if (delBtn) delBtn.style.display = "none";
        
        const searchBox = document.querySelector(".webex-subtitles-search-box");
        if (searchBox) searchBox.style.display = "none";
        
        const toolbarBox = document.getElementById("webex-subtitles-toolbar");
        if (toolbarBox) toolbarBox.style.display = "none";
    }

    async function toggleSubtitlesPanel(forcedState = null) {
        initSubtitlesUI();
        isSubtitlesPanelOpen = forcedState !== null ? forcedState : (subtitlesPanelEl.style.display === "none");
        subtitlesPanelEl.style.display = isSubtitlesPanelOpen ? "flex" : "none";

        const btnSub = document.getElementById("webex-action-subtitles");
        if (btnSub) btnSub.classList.toggle("active", isSubtitlesPanelOpen);
        const btnQaSub = document.getElementById("webex-qa-subtitles");
        if (btnQaSub) btnQaSub.classList.toggle("active", isSubtitlesPanelOpen);

        if (isSubtitlesPanelOpen) {
            if (subtitlesCues.length === 0) {
                await autoDetectWebexSubtitles();
            }
            const vid = getPrimaryVideo();
            if (vid) updateSubtitlesHighlight(vid.currentTime, true);
        }
    }

    async function autoDetectWebexSubtitles() {
        if (subtitlesCues && subtitlesCues.length > 0) return true;

        const listEl = document.getElementById("webex-subtitles-cues-list");
        if (listEl) {
            listEl.innerHTML = `
                <div class="webex-subtitles-empty">
                    <div style="font-size: 24px; margin-bottom: 8px;">🔍</div>
                    <b style="color: #38bdf8;">Ricerca sottotitoli Webex in corso...</b><br>
                    <span style="font-size: 11px; color: #94a3b8;">Controllo server Cisco, tracce audio e canali di rete</span>
                </div>
            `;
        }

        const recId = getRecordingId();
        const rawTitle = sanitizeWebexTitle(document.title || "");
        const cleanTitle = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const normTitle = rawTitle.toLowerCase().replace(/\b(polimi|webex|lezione|videolezione|recording|enhancer)\b/gi, '').replace(/[-_~|:/\\]/g, ' ').replace(/\.mp4$|\.webm$|\.mkv$/i, '').replace(/\s+/g, ' ').trim().replace(/[^a-z0-9]/g, '_');

        if ((recId && localStorage.getItem(`webex_subtitles_user_deleted_${recId}`) === "true") ||
            (cleanTitle && localStorage.getItem(`webex_subtitles_user_deleted_${cleanTitle}`) === "true") ||
            (normTitle && localStorage.getItem(`webex_subtitles_user_deleted_${normTitle}`) === "true")) {
            console.log("[PoliMiEnhancer] Subtitles explicitly deleted by user, showing empty state.");
            renderSubtitlesEmptyState();
            return false;
        }

        // 1. Check WebexOfflineDB first
        if (window.WebexOfflineDB) {
            try {
                let lec = recId ? await window.WebexOfflineDB.getLecture(recId) : null;
                if (!lec && rawTitle) {
                    lec = await window.WebexOfflineDB.findLecture({ recordingId: recId, pageTitle: rawTitle, pageUrl: window.location.href });
                }
                if (lec && (lec.subtitlesData || lec.transcript || lec.subtitles)) {
                    const rawData = lec.subtitlesData || lec.transcript || lec.subtitles;
                    const parsed = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        loadSubtitles(parsed, "Database Locale");
                        return true;
                    }
                }
            } catch (err) {
                console.warn("[PoliMiEnhancer] WebexOfflineDB subtitle lookup error:", err);
            }
        }

        // 2. Check chrome.storage.local by ID, normTitle, cleanTitle
        if (chrome.storage && chrome.storage.local) {
            try {
                const keys = [];
                if (recId) keys.push(`webex_subtitles_${recId}`);
                if (normTitle) keys.push(`webex_subtitles_norm_${normTitle}`);
                if (cleanTitle) keys.push(`webex_subtitles_title_${cleanTitle}`);
                const res = await new Promise(r => chrome.storage.local.get(keys, r));
                for (const k of keys) {
                    if (res[k]) {
                        const parsed = typeof res[k] === "string" ? JSON.parse(res[k]) : res[k];
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            loadSubtitles(parsed, "Memoria Sincronizzata");
                            return true;
                        }
                    }
                }
            } catch (_) {}
        }

        // 3. Check localStorage
        try {
            if (recId) {
                let cached = localStorage.getItem(`webex_subtitles_${recId}`);
                if (cached) {
                    const parsed = JSON.parse(cached);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        loadSubtitles(parsed, "Cache Locale");
                        return true;
                    }
                }
            }
        } catch (_) {}

        // 2. Query Cisco Webex REST APIs for this recording
        if (recId) {
            const regex = /^https?:\/\/(.+?)\.webex\.com\/(?:recordingservice|webappng)\/sites\/([^\/]+)\/.*?([a-f0-9]{32})/i;
            const match = regex.exec(window.location.href);
            const subdomain = match ? match[1] : "polimi";

            const apiEndpoints = [
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recId}/transcripts`,
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recId}/transcript`,
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recId}/captions`,
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recId}/stream`,
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recId}`,
                `https://${subdomain}.webex.com/recordingservice/sites/${subdomain}/recording/playback/${recId}/transcripts`,
                `https://${subdomain}.webex.com/recordingservice/sites/${subdomain}/recording/playback/${recId}/transcript`
            ];

            const token = sessionStorage.getItem("jwtToken") || sessionStorage.getItem("token") || localStorage.getItem("token") || "";
            const apiHeaders = {
                "Accept": "application/json, text/vtt, text/plain, */*",
                "clientType": "web",
                "appFrom": "pb"
            };
            if (token) apiHeaders["Authorization"] = `Bearer ${token}`;

            for (const ep of apiEndpoints) {
                try {
                    const res = await fetch(ep, {
                        headers: apiHeaders,
                        credentials: "include"
                    });
                    if (res.ok) {
                        const cType = res.headers.get("content-type") || "";
                        if (cType.includes("vtt") || cType.includes("plain")) {
                            const txt = await res.text();
                            const parsed = parseSubtitleText(txt);
                            if (parsed.length > 0) {
                                loadSubtitles(parsed, "Webex Server (WebVTT)");
                                try { localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(parsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(parsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(parsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
} } catch (_) {}
                                return true;
                            }
                        } else {
                            const data = await res.json();
                            const direct = parseSubtitleText(JSON.stringify(data));
                            if (direct.length > 0) {
                                loadSubtitles(direct, "Webex Server API");
                                try { localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(direct)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(direct) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(direct);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
} } catch (_) {}
                                return true;
                            }

                            const subUrl = data.transcriptInfo?.transcriptUrl || 
                                           data.transcriptInfo?.vttUrl ||
                                           data.downloadRecordingInfo?.downloadInfo?.transcriptURL ||
                                           data.downloadRecordingInfo?.downloadInfo?.ccURL ||
                                           data.ccInfo?.ccUrl ||
                                           data.vttURL ||
                                           data.transcriptURL;
                            if (subUrl && typeof subUrl === "string") {
                                const subRes = await fetch(subUrl, { credentials: "include" });
                                if (subRes.ok) {
                                    const subTxt = await subRes.text();
                                    const subParsed = parseSubtitleText(subTxt);
                                    if (subParsed.length > 0) {
                                        loadSubtitles(subParsed, "Webex Server Transcripts");
                                        try { localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(subParsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(subParsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(subParsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
} } catch (_) {}
                                        return true;
                                    }
                                }
                            }
                        }
                    }
                } catch (err) {
                    // Try next endpoint
                }
            }
        }

        // 3. Ask background.js for sniffed transcript URL
        try {
            const bgTr = await new Promise(resolve => {
                chrome.runtime.sendMessage({ type: "GET_CAPTURED_TRANSCRIPT" }, resolve);
            });
            if (bgTr && bgTr.transcript && bgTr.transcript.url) {
                const trRes = await fetch(bgTr.transcript.url, { credentials: "include" });
                if (trRes.ok) {
                    const trTxt = await trRes.text();
                    const trParsed = parseSubtitleText(trTxt);
                    if (trParsed.length > 0) {
                        loadSubtitles(trParsed, "Rilevamento di Rete");
                        if (recId) {
                            try { localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(trParsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(trParsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(trParsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
} } catch (_) {}
                        }
                        return true;
                    }
                }
            }
        } catch (_) {}

        // 4. Check HTML5 Video TextTracks (Enforcing hidden mode to load cues)
        const vid = getPrimaryVideo();
        if (vid && vid.textTracks && vid.textTracks.length > 0) {
            for (let i = 0; i < vid.textTracks.length; i++) {
                const track = vid.textTracks[i];
                if (track.mode === "disabled") {
                    track.mode = "hidden";
                }
                if (track.cues && track.cues.length > 0) {
                    const parsed = [];
                    for (let j = 0; j < track.cues.length; j++) {
                        const c = track.cues[j];
                        parsed.push({ start: c.startTime, end: c.endTime, text: c.text });
                    }
                    if (parsed.length > 0) {
                        loadSubtitles(parsed, "Tracce Video Webex");
                        if (recId) {
                            try { localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(parsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(parsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(parsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
} } catch (_) {}
                        }
                        return true;
                    }
                }
            }
        }

        // 5. Check DOM <track> elements
        const trackEls = document.querySelectorAll("video track, track");
        for (const t of trackEls) {
            if (t.src) {
                try {
                    const res = await fetch(t.src);
                    if (res.ok) {
                        const txt = await res.text();
                        const parsed = parseSubtitleText(txt);
                        if (parsed.length > 0) {
                            loadSubtitles(parsed, "Traccia WebVTT");
                            if (recId) {
                                try { localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(parsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(parsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(parsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
} } catch (_) {}
                            }
                            return true;
                        }
                    }
                } catch (_) {}
            }
        }

        // 6. Check Webex DOM transcript elements
        const domTranscriptItems = document.querySelectorAll(".transcript-item, .recording-transcript-item, [data-testid*='transcript']");
        if (domTranscriptItems.length > 0) {
            const parsed = [];
            domTranscriptItems.forEach(item => {
                const timeEl = item.querySelector(".time, .timestamp, [class*='time']");
                const textEl = item.querySelector(".text, .content, [class*='text']");
                if (timeEl && textEl) {
                    const timeParts = timeEl.innerText.trim().split(":").map(Number);
                    let secs = 0;
                    if (timeParts.length === 2) secs = timeParts[0] * 60 + timeParts[1];
                    else if (timeParts.length === 3) secs = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
                    parsed.push({ start: secs, end: secs + 3, text: textEl.innerText.trim() });
                }
            });
            if (parsed.length > 0) {
                loadSubtitles(parsed, "Trascrizione Pagina Webex");
                if (recId) {
                    try { localStorage.setItem(`webex_subtitles_${recId}`, JSON.stringify(parsed)); try { chrome.storage.local.set({ [`webex_subtitles_${recId}`]: JSON.stringify(parsed) }); } catch (_) {}
if (window.WebexOfflineDB) {
    window.WebexOfflineDB.getLecture(recId).then(lec => {
        if (lec) {
            lec.subtitlesData = JSON.stringify(parsed);
            window.WebexOfflineDB.saveLecture(lec);
        }
    }).catch(()=>{});
} } catch (_) {}
                }
                return true;
            }
        }

        // 7. If no server transcript exists: Render clean empty state
        renderSubtitlesEmptyState();
        return false;
    }

    // =========================================================================
    // AI Audio Speech-to-Text Runner (Zero Microphone)
    // =========================================================================
    let isAITranscribing = false;

    async function startAITranscription() {
        if (isAITranscribing) {
            showHUD("Trascrizione AI già in corso...", "⏳");
            return;
        }
        
        const recId = getRecordingId() || "webex_lesson";
        try { localStorage.removeItem(`webex_subtitles_user_deleted_${recId}`); } catch (_) {}

        // Unified Database check: Load transcript if already exists in offline_db
        if (window.WebexOfflineDB) {
            try {
                let lesson = await window.WebexOfflineDB.getLecture(recId);
                if (!lesson) {
                    const rawTitle = sanitizeWebexTitle(document.title || "");
                    lesson = await window.WebexOfflineDB.findLecture({ recordingId: recId, pageTitle: rawTitle, pageUrl: window.location?.href });
                }
                if (lesson && (lesson.subtitlesData || lesson.transcript)) {
                    let parsed = null;
                    try {
                        const raw = lesson.subtitlesData || lesson.transcript;
                        parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
                    } catch (_) {}
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        showHUD("Trascrizione caricata dal database unificato!", "💾");
                        initSubtitlesUI();
                        if (!isSubtitlesPanelOpen) toggleSubtitlesPanel(true);
                        loadSubtitles(parsed, "Trascrizione Offline DB");
                        return;
                    }
                }
            } catch (e) {
                console.warn("[PoliMiEnhancer] Error reading offline DB for subtitles", e);
            }
        }

        const vid = getPrimaryVideo();
        if (!vid) {
            showHUD("Nessun video trovato nella pagina", "⚠️");
            return;
        }

        initSubtitlesUI();
        if (!isSubtitlesPanelOpen) toggleSubtitlesPanel(true);

        // Find audio source: check memory buffer, indexedDB, or stream URL
        showHUD("Preparazione traccia audio digitale (zero microfono)...", "⚡");

        let audioSrc = null;
        if (bufferedBlob) {
            audioSrc = URL.createObjectURL(bufferedBlob);
        } else if (window.WebexOfflineDB && recId) {
            try {
                const lecture = await WebexOfflineDB.findLecture({ recordingId: recId });
                if (lecture && lecture.blob) {
                    audioSrc = URL.createObjectURL(lecture.blob);
                }
            } catch (_) {}
        }

        if (!audioSrc) {
            const stream = await getStreamUrl(true);
            if (stream && stream.url) {
                audioSrc = stream.url;
            }
        }

        if (!audioSrc && vid.src && !vid.src.includes(".m3u8") && !vid.src.startsWith("blob:")) {
            audioSrc = vid.src;
        }

        if (!audioSrc && bufferedBlob) {
            audioSrc = URL.createObjectURL(bufferedBlob);
        }

        if (!audioSrc) {
            showHUD("Flusso multimediale non ancora agganciato. Avvia la lezione e riprova!", "⚠️");
            return;
        }

        isAITranscribing = true;

        const listEl = document.getElementById("webex-subtitles-cues-list");
        if (listEl) {
            listEl.innerHTML = `
                <div class="webex-subtitles-ai-progress" style="padding: 28px 20px; text-align: center;">
                    <div style="font-size: 34px; margin-bottom: 12px; filter: drop-shadow(0 0 10px #38bdf8);">⚡</div>
                    <b style="color: #38bdf8; font-size: 15px;" id="ai-progress-title">Avvio Trascrizione Vocale AI...</b>
                    <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 16px 0; line-height: 1.4;" id="ai-progress-detail">Connessione digitale alla traccia audio (zero microfono)...</p>
                    <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin-bottom: 10px;">
                        <div id="ai-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #0284c7, #38bdf8); transition: width 0.3s ease;"></div>
                    </div>
                    <span id="ai-progress-pct" style="font-size: 12px; color: #cbd5e1; font-weight: 700;">0%</span>
                    <div style="font-size: 11px; color: #64748b; margin-top: 10px; margin-bottom: 15px;">💡 Elaborazione a blocchi di 3 min (&lt; 25 MB) • rispetto dei 20 req/min Free Tier</div>
                    <button class="webex-subtitles-action-btn danger-btn" id="webex-subtitles-btn-stop-ai" style="margin: 0 auto; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); color: #fca5a5;">
                        <span>🛑 Ferma Trascrizione AI</span>
                    </button>
                </div>
            `;
            
            setTimeout(() => {
                const stopBtn = document.getElementById("webex-subtitles-btn-stop-ai");
                if (stopBtn) {
                    stopBtn.onclick = () => {
                        isAITranscribing = false;
                        if (typeof AITranscriber !== 'undefined' && AITranscriber.abort) {
                            AITranscriber.abort();
                        }
                        renderSubtitlesEmptyState();
                        showHUD("Trascrizione AI interrotta.", "🛑");
                    };
                }
            }, 50);
        }

        const updateProgress = ({ stage, percent, detail }) => {
            const bar = document.getElementById("ai-progress-bar");
            const pct = document.getElementById("ai-progress-pct");
            const det = document.getElementById("ai-progress-detail");
            const title = document.getElementById("ai-progress-title");
            if (bar) bar.style.width = `${percent}%`;
            if (pct) pct.innerText = `${percent}%`;
            if (det) det.innerText = detail;
            if (title) {
                if (stage === "download") title.innerText = "1/3 Download Traccia Audio Digitale...";
                else if (stage === "decode" || stage === "resample") title.innerText = "2/3 Decodifica Digitale & Ricampionamento...";
                else if (stage === "transcribing") title.innerText = "3/3 Riconoscimento Vocale AI (Whisper)...";
                else if (stage === "complete") title.innerText = "Trascrizione Completata!";
            }
        };

        try {
            // 1. Digital audio track extraction (ZERO MICROPHONE) with Webex auth token
            const token = getWebexAuthToken();
            const audioData = await AITranscriber.extractAudioTrackFromUrl(audioSrc, updateProgress, token);

            // 2. AI Transcription with word-level timestamps
            const cues = await AITranscriber.transcribeAudioTrack(audioData, updateProgress);

            if (cues && cues.length > 0) {
                await saveSubtitlesPermanently(recId, cues, sanitizeWebexTitle(document.title || ""));
                loadSubtitles(cues, "Trascrizione AI (Whisper Vocale)");
                showHUD(`Trascrizione completata: ${cues.length} segmenti con parole sincronizzate!`, "✨");
            } else {
                showHUD("Nessun parlato rilevato nella registrazione.", "⚠️");
                renderSubtitlesList();
            }
        } catch (err) {
            console.error("[PoliMiEnhancer] AI Transcription error:", err);
            showHUD("Errore trascrizione: " + err.message, "❌");
            if (listEl) {
                listEl.innerHTML = `
                    <div class="webex-subtitles-empty">
                        <div style="font-size: 28px; margin-bottom: 8px;">⚠️</div>
                        <b style="color: #ef4444; font-size: 14px;">Trascrizione Non Riuscita</b>
                        <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 16px 0; line-height: 1.5;">
                            ${err.message}
                        </p>
                        <div style="display: flex; gap: 8px; justify-content: center;">
                            <button class="webex-subtitles-action-btn active" id="btn-retry-ai" style="padding: 8px 16px;">
                                <span>🔄 Riprova Trascrizione</span>
                            </button>
                            <button class="webex-subtitles-action-btn" id="btn-change-groq-key" style="padding: 8px 16px;">
                                <span>🔑 Configurazione Chiave AI</span>
                            </button>
                        </div>
                    </div>
                `;
                const retryBtn = listEl.querySelector("#btn-retry-ai");
                if (retryBtn) retryBtn.onclick = () => startAITranscription();
                const keyBtn = listEl.querySelector("#btn-change-groq-key");
                if (keyBtn) keyBtn.onclick = async () => {
                    await AITranscriber.promptForGroqApiKey();
                    startAITranscription();
                };
            }
        } finally {
            isAITranscribing = false;
        }
    }

    // Helper to retrieve Webex session auth token from any storage location
    function getWebexAuthToken() {
        const candidates = [
            sessionStorage.getItem("jwtToken"),
            sessionStorage.getItem("token"),
            sessionStorage.getItem("access_token"),
            sessionStorage.getItem("recording_token"),
            sessionStorage.getItem("pb_token"),
            localStorage.getItem("jwtToken"),
            localStorage.getItem("token"),
            localStorage.getItem("access_token"),
            window.jwtToken
        ];
        for (const c of candidates) {
            if (c && typeof c === "string" && c.trim().length > 10) return c.trim();
        }
        return "";
    }

    // --- Stream Detection (Separates Video MP4 from Audio-Only Tracks) ---
    async function getStreamUrl(allowAudio = false) {
        const recId = getRecordingId();
        const hexMatch = window.location.href.match(/([a-f0-9]{32})/i);
        const recordingId = (hexMatch ? hexMatch[1] : "") || recId;
        const subdomain = window.location.hostname.split('.')[0] || "politecnicomilano";
        const pathParts = window.location.pathname.split("/").filter(Boolean);
        const site = (pathParts.length > 2 && pathParts[1] === "sites") ? pathParts[2] : subdomain;

        const token = getWebexAuthToken();
        const apiHeaders = {
            "Accept": "application/json, text/plain, */*",
            "clientType": "web",
            "appFrom": "pb"
        };
        if (token) apiHeaders["Authorization"] = `Bearer ${token}`;

        // Priority 1: Webex Recording Stream API endpoints
        if (recordingId && recordingId !== "unknown_rec") {
            const apiCandidates = [
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recordingId}/stream?siteurl=${site}`,
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recordingId}/stream`,
                `https://${subdomain}.webex.com/recordingservice/api/v1/recordings/${recordingId}/stream?siteurl=${site}`,
                `https://${subdomain}.webex.com/recordingservice/api/v1/recordings/${recordingId}/stream`,
                `https://${subdomain}.webex.com/webappng/api/v1/recordings/${recordingId}`,
                `https://${subdomain}.webex.com/recordingservice/sites/${site}/recording/playback/${recordingId}`
            ];

            for (const apiUrl of apiCandidates) {
                try {
                    const res = await fetch(apiUrl, {
                        headers: apiHeaders,
                        credentials: "include"
                    });
                    if (res.ok) {
                        const data = await res.json();
                        
                        // 1. Audio-only stream check FIRST if audio requested (Only ~20MB instead of 1GB MP4)
                        if (allowAudio) {
                            const audio = data.downloadRecordingInfo?.downloadInfo?.audioURL ||
                                          data.downloadRecordingInfo?.downloadInfo?.mp3URL ||
                                          data.downloadRecordingInfo?.downloadInfo?.m4aURL ||
                                          data.downloadInfo?.audioURL ||
                                          data.downloadInfo?.mp3URL ||
                                          data.downloadInfo?.m4aURL ||
                                          data.audioURL ||
                                          data.mp3URL ||
                                          data.m4aURL;
                            if (audio && typeof audio === "string" && !audio.includes(".m3u8")) {
                                return { url: audio, isAudioOnly: true, title: data.recordName || document.title };
                            }
                        }

                        // 2. MASTER MULTIPLEXED MP4 STREAM (Contains BOTH frame-accurate Video & AAC Audio)
                        const mp4 = data.downloadRecordingInfo?.downloadInfo?.mp4URL ||
                                    data.downloadInfo?.mp4URL ||
                                    data.mp4URL ||
                                    data.fallbackPlaySrc ||
                                    data.downloadUrl ||
                                    data.streamURL;
                        if (mp4 && typeof mp4 === "string" && !mp4.includes(".m3u8")) {
                            const lower = mp4.toLowerCase();
                            // If video requested, reject audio-only files
                            if (allowAudio || (!lower.includes("audio") && !lower.includes(".m4a") && !lower.includes(".mp3"))) {
                                return { url: mp4, isAudioOnly: false, title: data.recordName || document.title };
                            }
                        }

                        // 3. Video fallback only if no multiplexed MP4 exists and audio not requested
                        if (!allowAudio) {
                            const vidStream = data.videoStreamUrl || data.streamOption?.videoStreamUrl;
                            if (vidStream && typeof vidStream === "string" && !vidStream.includes(".m3u8")) {
                                const lower = vidStream.toLowerCase();
                                if (!lower.includes("audio") && !lower.includes(".m4a") && !lower.includes(".mp3")) {
                                    return { url: vidStream, isAudioOnly: false, title: data.recordName || document.title };
                                }
                            }
                        }
                    }
                } catch (e) {
                    // Try next candidate
                }
            }
        }

        // Priority 2: Check captured streams from background service worker (sniffed web requests)
        try {
            const bgResp = await new Promise(res => {
                chrome.runtime.sendMessage({ type: "GET_CAPTURED_STREAM" }, res);
            });
            if (bgResp && bgResp.stream && bgResp.stream.url && !bgResp.stream.url.includes(".m3u8")) {
                const lower = bgResp.stream.url.toLowerCase();
                const isAudioTrack = lower.includes("audio") || lower.includes(".m4a") || lower.includes(".mp3");
                if (allowAudio && isAudioTrack) {
                    return { url: bgResp.stream.url, isAudioOnly: true, title: document.title };
                }
                if (!allowAudio && !isAudioTrack) {
                    return { url: bgResp.stream.url, isAudioOnly: false, title: document.title };
                }
            }
        } catch (e) {}

        // Priority 3: Check Performance Entries for real streams
        try {
            const entries = performance.getEntriesByType("resource");
            for (let i = entries.length - 1; i >= 0; i--) {
                const name = entries[i].name.toLowerCase();
                const isAudioTrack = name.includes("audio") || name.includes(".m4a") || name.includes(".mp3");
                if (allowAudio && isAudioTrack && !name.includes(".m3u8")) {
                    return { url: entries[i].name, isAudioOnly: true, title: document.title };
                }
                if (!allowAudio && !isAudioTrack && (name.includes(".mp4") || name.includes("/stream?") || name.includes("videoplayback")) && !name.includes(".m3u8")) {
                    return { url: entries[i].name, isAudioOnly: false, title: document.title };
                }
            }
        } catch (e) {}

        // Priority 4: Video element source ONLY if it is an actual MP4 video file
        const video = getPrimaryVideo();
        if (video && video.currentSrc && !video.currentSrc.startsWith("blob:") && !video.currentSrc.includes(".m3u8")) {
            const lower = video.currentSrc.toLowerCase();
            if (allowAudio || (!lower.includes("audio") && !lower.includes(".m4a") && !lower.includes(".mp3"))) {
                return { url: video.currentSrc, isAudioOnly: false, title: document.title };
            }
        }
        if (video && video.src && !video.src.startsWith("blob:") && !video.src.includes(".m3u8")) {
            const lower = video.src.toLowerCase();
            if (allowAudio || (!lower.includes("audio") && !lower.includes(".m4a") && !lower.includes(".mp3"))) {
                return { url: video.src, isAudioOnly: false, title: document.title };
            }
        }

        return null;
    }

    // ==========================================================================
    // Play Local Buffered Blob DIRECTLY in the Webex Player (Zero Internet Mode) & Toggle
    // ==========================================================================
    let isBufferPlaybackActive = false;
    let activeBufferBlobUrl = null;
    let bufferScrubCleanups = [];

    function revertBufferPlaybackToOriginal() {
        if (!isBufferPlaybackActive) return;
        isBufferPlaybackActive = false;

        const bufVideo = document.getElementById("webex-inpage-buffer-video");
        const curTime = bufVideo ? (bufVideo.currentTime || 0) : 0;
        const curRate = bufVideo ? (bufVideo.playbackRate || 1.0) : 1.0;
        const curVol = bufVideo ? bufVideo.volume : 1.0;

        // 1. Remove overlay player
        const overlay = document.getElementById("webex-inpage-buffer-player");
        if (overlay) overlay.remove();

        // 2. Revoke blob URL
        if (activeBufferBlobUrl) {
            try { URL.revokeObjectURL(activeBufferBlobUrl); } catch (_) {}
            activeBufferBlobUrl = null;
        }

        // 3. Run scrub cleanups
        bufferScrubCleanups.forEach(fn => { try { fn(); } catch (_) {} });
        bufferScrubCleanups = [];

        // 4. Resume original Webex video exactly where left off without modifying its stream
        const webexVid = getPrimaryVideo();
        if (webexVid) {
            try {
                webexVid.muted = false;
                webexVid.volume = curVol;
                webexVid.playbackRate = curRate;
                if (curTime > 0) webexVid.currentTime = curTime;
                webexVid.play().catch(() => {});
            } catch (_) {}
        }
        getAllVideos().forEach(v => {
            try { v.muted = false; } catch (_) {}
        });
        document.querySelectorAll('audio').forEach(a => {
            try {
                a.muted = false;
                if (curTime > 0) a.currentTime = curTime;
                if (webexVid && !webexVid.paused) a.play().catch(() => {});
            } catch (_) {}
        });

        // 5. Update Toggle Button back to cyan
        const useBtn = document.getElementById("webex-btn-use-buffer-page");
        if (useBtn) {
            useBtn.className = "webex-helper-buffer-link-btn primary-use-buffer";
            useBtn.innerHTML = "▶️ Usa Buffer in questa pagina";
            useBtn.onclick = () => useBufferInThisPage();
        }

        renderTimelineMarkers();
        updateOfflineButtonsReady(true);
        repositionQuickActionsBar();
        showHUD("Ripristinato streaming originale Webex", "↩️");
    }

    function applyLocalBlobToWebexPlayer(blob) {
        if (!blob || blob.size < 500000) {
            showHUD("Errore: buffer non valido o incompleto.", "⚠️");
            return;
        }

        const originalVid = getPrimaryVideo();
        const curTime = originalVid ? (originalVid.currentTime || 0) : 0;

        // Pause original Webex videos & audios so they don't play in background
        if (originalVid) {
            try { originalVid.pause(); } catch (_) {}
        }
        getAllVideos().forEach(v => {
            try { v.pause(); v.muted = true; } catch (_) {}
        });
        document.querySelectorAll('audio').forEach(a => {
            try { a.pause(); a.muted = true; } catch (_) {}
        });

        isBufferPlaybackActive = true;

        if (activeBufferBlobUrl) {
            try { URL.revokeObjectURL(activeBufferBlobUrl); } catch (_) {}
        }
        activeBufferBlobUrl = URL.createObjectURL(blob);

        // Find player container
        const playerContainer = (originalVid && originalVid.parentElement) ? originalVid.parentElement : (getPlayerContainer() || document.querySelector('.video-js, .playback-video-container, #player-container') || document.body);
        if (getComputedStyle(playerContainer).position === 'static') {
            playerContainer.style.position = 'relative';
        }

        let overlay = document.getElementById("webex-inpage-buffer-player");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "webex-inpage-buffer-player";
            if (originalVid && originalVid.parentElement) {
                originalVid.parentElement.insertBefore(overlay, originalVid.nextSibling);
            } else {
                playerContainer.appendChild(overlay);
            }
        }

        overlay.innerHTML = `
            <video id="webex-inpage-buffer-video" playsinline></video>
            <div class="webex-inpage-controls-bar" id="webex-inpage-controls-bar">
                <div class="webex-inpage-timeline-row">
                    <span class="webex-inpage-time" id="webex-inpage-current-time">00:00</span>
                    <div class="webex-inpage-timeline-track" id="webex-inpage-timeline-track">
                        <div class="webex-inpage-timeline-fill" id="webex-inpage-timeline-fill"></div>
                        <div class="webex-inpage-timeline-handle" id="webex-inpage-timeline-handle"></div>
                        <div class="webex-inpage-timeline-tooltip" id="webex-inpage-timeline-tooltip">00:00</div>
                    </div>
                    <span class="webex-inpage-time" id="webex-inpage-duration-time">00:00</span>
                </div>
                <div class="webex-inpage-buttons-row">
                    <div class="inpage-btn-group-left">
                        <button type="button" class="inpage-btn" id="webex-inpage-btn-play" title="Play/Pausa (Spazio)">▶ Play</button>
                        <button type="button" class="inpage-btn" id="webex-inpage-btn-rwd30" title="Indietro 30s (Shift+←)">-30s</button>
                        <button type="button" class="inpage-btn inpage-btn-primary" id="webex-inpage-btn-rwd10" title="Indietro 10s (←)">-10s</button>
                        <button type="button" class="inpage-btn inpage-btn-primary" id="webex-inpage-btn-fwd10" title="Avanti 10s (→)">+10s</button>
                        <button type="button" class="inpage-btn" id="webex-inpage-btn-fwd30" title="Avanti 30s (Shift+→)">+30s</button>
                        <div class="inpage-volume-box">
                            <span style="font-size: 13px; cursor: pointer;" id="webex-inpage-vol-icon" title="Muto / Riattiva Audio">🔊</span>
                            <input type="range" class="inpage-vol-slider" id="webex-inpage-vol-slider" min="0" max="1" step="0.05" value="1" title="Volume">
                        </div>
                        <span class="inpage-speed-badge" id="webex-inpage-speed-badge" title="Velocità riproduzione (Click per cambiare)">1.0x</span>
                    </div>
                    <div class="inpage-btn-group-right">
                        <button type="button" class="inpage-revert-btn" id="webex-inpage-revert-btn" title="Esci dalla modalità buffer e ripristina Webex">
                            🔴 Esci dal Buffer (Torna a Webex)
                        </button>
                    </div>
                </div>
            </div>
        `;

        const bufVideo = overlay.querySelector("#webex-inpage-buffer-video");
        const controlsBar = overlay.querySelector("#webex-inpage-controls-bar");
        const track = overlay.querySelector("#webex-inpage-timeline-track");
        const fill = overlay.querySelector("#webex-inpage-timeline-fill");
        const handle = overlay.querySelector("#webex-inpage-timeline-handle");
        const tooltip = overlay.querySelector("#webex-inpage-timeline-tooltip");
        const curTimeEl = overlay.querySelector("#webex-inpage-current-time");
        const durTimeEl = overlay.querySelector("#webex-inpage-duration-time");
        const btnPlay = overlay.querySelector("#webex-inpage-btn-play");
        const btnRwd30 = overlay.querySelector("#webex-inpage-btn-rwd30");
        const btnRwd10 = overlay.querySelector("#webex-inpage-btn-rwd10");
        const btnFwd10 = overlay.querySelector("#webex-inpage-btn-fwd10");
        const btnFwd30 = overlay.querySelector("#webex-inpage-btn-fwd30");
        const volSlider = overlay.querySelector("#webex-inpage-vol-slider");
        const volIcon = overlay.querySelector("#webex-inpage-vol-icon");
        const speedBadge = overlay.querySelector("#webex-inpage-speed-badge");
        const btnRevert = overlay.querySelector("#webex-inpage-revert-btn");

        bufVideo.src = activeBufferBlobUrl;
        bufVideo.volume = 1.0;
        bufVideo.muted = false;

        // Auto-silence ANY background Webex video/audio that tries to play while buffer mode is active
        const silenceBackgroundMedia = (e) => {
            if (isBufferPlaybackActive && e.target && e.target.id !== "webex-inpage-buffer-video") {
                try {
                    e.target.pause();
                    e.target.muted = true;
                    e.target.volume = 0;
                } catch (_) {}
            }
        };
        document.addEventListener("play", silenceBackgroundMedia, true);
        document.addEventListener("playing", silenceBackgroundMedia, true);
        bufferScrubCleanups.push(() => {
            document.removeEventListener("play", silenceBackgroundMedia, true);
            document.removeEventListener("playing", silenceBackgroundMedia, true);
        });

        // Resume AudioContext if volume boost is active
        bufVideo.addEventListener("play", () => {
            if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        });
        bufVideo.addEventListener("playing", () => {
            if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        });

        // Click on video to toggle play / pause
        bufVideo.addEventListener("click", () => {
            togglePlayPause();
        });

        // Set initial playback timestamp from original video
        bufVideo.addEventListener("loadedmetadata", () => {
            if (curTime > 0) bufVideo.currentTime = curTime;
            bufVideo.play().catch(() => {});
            renderTimelineMarkers();
            const dur = (bufVideo.duration && isFinite(bufVideo.duration)) ? bufVideo.duration : 3600;
            durTimeEl.textContent = formatTime(dur);
            updateToolbarSpeed(bufVideo.playbackRate || 1.0);
        }, { once: true });

        // Update dedicated timeline UI
        let isScrubbing = false;
        let wasPlayingBeforeScrub = false;
        let scrubRaf = null;

        function updateTimelineUI(cur, dur) {
            if (dur <= 0 || isNaN(dur)) dur = (bufVideo.duration && isFinite(bufVideo.duration) && bufVideo.duration > 0) ? bufVideo.duration : 3600;
            const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
            fill.style.width = `${pct}%`;
            handle.style.left = `${pct}%`;
            curTimeEl.textContent = formatTime(cur);
            durTimeEl.textContent = formatTime(dur);
        }

        function scrubToRatio(ratio, commit = false) {
            const dur = (bufVideo.duration && isFinite(bufVideo.duration) && bufVideo.duration > 0) ? bufVideo.duration : 3600;
            const targetTime = Math.max(0, Math.min(dur, ratio * dur));
            updateTimelineUI(targetTime, dur);
            if (commit) {
                safeSeek(bufVideo, targetTime, wasPlayingBeforeScrub);
                showHUD(`⏱ ${formatTime(targetTime)}`, "⏩");
            }
        }

        function getTrackRatio(clientX) {
            const rect = track.getBoundingClientRect();
            if (rect.width <= 0) return 0;
            return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        }

        const onTimeUpdate = () => {
            if (!isScrubbing) {
                updateTimelineUI(bufVideo.currentTime, bufVideo.duration);
            }
            updateSubtitlesHighlight(bufVideo.currentTime);
        };
        bufVideo.addEventListener("timeupdate", onTimeUpdate);
        bufferScrubCleanups.push(() => bufVideo.removeEventListener("timeupdate", onTimeUpdate));

        bufVideo.addEventListener("seeked", () => {
            updateSubtitlesHighlight(bufVideo.currentTime, true);
        });

        // Interactive Timeline Scrubbing
        const onPointerDown = (e) => {
            isScrubbing = true;
            wasPlayingBeforeScrub = !bufVideo.paused;
            try { bufVideo.pause(); } catch (_) {}
            track.classList.add("is-scrubbing");

            const ratio = getTrackRatio(e.clientX);
            scrubToRatio(ratio, false);

            const onPointerMove = (moveEvt) => {
                if (!isScrubbing) return;
                const r = getTrackRatio(moveEvt.clientX);
                if (scrubRaf) cancelAnimationFrame(scrubRaf);
                scrubRaf = requestAnimationFrame(() => {
                    scrubToRatio(r, false);
                });
            };

            const onPointerUp = (upEvt) => {
                if (isScrubbing) {
                    isScrubbing = false;
                    track.classList.remove("is-scrubbing");
                    if (scrubRaf) cancelAnimationFrame(scrubRaf);
                    const r = getTrackRatio(upEvt.clientX);
                    const dur = (bufVideo.duration && isFinite(bufVideo.duration) && bufVideo.duration > 0) ? bufVideo.duration : 3600;
                    const targetTime = Math.max(0, Math.min(dur, r * dur));
                    safeSeek(bufVideo, targetTime, wasPlayingBeforeScrub);
                    showHUD(`⏱ ${formatTime(targetTime)}`, "⏩");
                }
                window.removeEventListener("pointermove", onPointerMove);
                window.removeEventListener("pointerup", onPointerUp);
            };

            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
        };

        track.addEventListener("pointerdown", onPointerDown);
        track.addEventListener("click", (e) => {
            if (!isScrubbing) {
                const r = getTrackRatio(e.clientX);
                const dur = (bufVideo.duration && isFinite(bufVideo.duration) && bufVideo.duration > 0) ? bufVideo.duration : 3600;
                const targetTime = Math.max(0, Math.min(dur, r * dur));
                safeSeek(bufVideo, targetTime, !bufVideo.paused);
                showHUD(`⏱ ${formatTime(targetTime)}`, "⏩");
            }
        });

        track.addEventListener("mousemove", (e) => {
            const rect = track.getBoundingClientRect();
            if (rect.width <= 0) return;
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const dur = (bufVideo.duration && isFinite(bufVideo.duration) && bufVideo.duration > 0) ? bufVideo.duration : 3600;
            const hoverTime = ratio * dur;
            tooltip.textContent = formatTime(hoverTime);
            tooltip.style.left = `${ratio * 100}%`;
            tooltip.style.opacity = "1";
        });
        track.addEventListener("mouseleave", () => {
            if (!isScrubbing) tooltip.style.opacity = "0";
        });

        // Controls Bar Play/Pause Button
        if (btnPlay) {
            btnPlay.onclick = (e) => {
                e.stopPropagation();
                togglePlayPause();
            };
        }

        // Skip buttons
        if (btnRwd30) btnRwd30.onclick = (e) => { e.stopPropagation(); seekVideo(-30); };
        if (btnRwd10) btnRwd10.onclick = (e) => { e.stopPropagation(); seekVideo(-10); };
        if (btnFwd10) btnFwd10.onclick = (e) => { e.stopPropagation(); seekVideo(10); };
        if (btnFwd30) btnFwd30.onclick = (e) => { e.stopPropagation(); seekVideo(30); };

        // Volume control
        if (volSlider) {
            volSlider.oninput = (e) => {
                e.stopPropagation();
                const val = parseFloat(volSlider.value);
                bufVideo.volume = val;
                bufVideo.muted = (val === 0);
                if (volIcon) volIcon.textContent = val === 0 ? "🔇" : (val < 0.5 ? "🔉" : "🔊");
            };
        }
        if (volIcon) {
            volIcon.onclick = (e) => {
                e.stopPropagation();
                bufVideo.muted = !bufVideo.muted;
                if (volIcon) volIcon.textContent = bufVideo.muted ? "🔇" : (bufVideo.volume < 0.5 ? "🔉" : "🔊");
            };
        }

        // Speed badge (click to cycle speeds)
        const speeds = [1.0, 1.25, 1.5, 1.75, 2.0, 0.75];
        if (speedBadge) {
            speedBadge.onclick = (e) => {
                e.stopPropagation();
                const curRate = bufVideo.playbackRate || 1.0;
                let next = speeds.find(s => s > curRate + 0.05);
                if (!next) next = speeds[0];
                changeSpeed(0, next);
            };
        }

        bufVideo.addEventListener("ratechange", () => {
            const r = (bufVideo.playbackRate || 1.0).toFixed(2).replace(/\.00$/, '');
            if (speedBadge) speedBadge.textContent = `${r}x`;
        });

        bufVideo.addEventListener("play", () => {
            if (btnPlay) btnPlay.innerHTML = "⏸ Pausa";
            showControls();
        });
        bufVideo.addEventListener("pause", () => {
            if (btnPlay) btnPlay.innerHTML = "▶ Play";
            if (controlsBar) controlsBar.classList.remove("is-hidden");
            if (hideTimeout) clearTimeout(hideTimeout);
        });

        // Auto-hide controls bar on mouse inactivity
        let hideTimeout = null;
        function showControls() {
            if (!controlsBar) return;
            controlsBar.classList.remove("is-hidden");
            if (hideTimeout) clearTimeout(hideTimeout);
            if (!bufVideo.paused && !isScrubbing) {
                hideTimeout = setTimeout(() => {
                    controlsBar.classList.add("is-hidden");
                }, 2800);
            }
        }
        overlay.addEventListener("mousemove", showControls);
        overlay.addEventListener("mouseenter", showControls);

        bufferScrubCleanups.push(() => {
            if (hideTimeout) clearTimeout(hideTimeout);
        });

        // Revert button
        if (btnRevert) {
            btnRevert.onclick = (e) => {
                e.stopPropagation();
                revertBufferPlaybackToOriginal();
            };
        }

        // Update Toggle Button to Red Stop State
        const useBtn = document.getElementById("webex-btn-use-buffer-page");
        if (useBtn) {
            useBtn.className = "webex-helper-buffer-link-btn active-stop-buffer";
            useBtn.innerHTML = "🔴 Non usare il buffer in questa pagina";
            useBtn.onclick = () => revertBufferPlaybackToOriginal();
        }

        updateOfflineButtonsReady(true);
        repositionQuickActionsBar();
        showHUD("▶️ Riproduzione da Buffer Locale attiva (Zero Internet)! ⚡", "✅");
    }

    // --- Buffer Download Handler ---
    async function startBufferDownload(fraction = 1.0, folder = "") {
        const recordingId = getRecordingId();
        const btn = document.getElementById("webex-btn-download-buffer");
        const statusEl = document.getElementById("webex-buffer-status");
        const progressBar = document.getElementById("webex-buffer-bar");
        const progressFill = document.getElementById("webex-buffer-fill");

        if (isDownloadInProgress) {
            chrome.runtime.sendMessage({
                type: "CANCEL_BACKGROUND_DOWNLOAD",
                lectureId: recordingId
            });
            isDownloadInProgress = false;
            if (statusEl) statusEl.innerHTML = `<span>Download annullato</span>`;
            if (btn) {
                btn.innerText = "📥 Scarica Buffer";
                btn.style.background = "#38bdf8";
                btn.style.color = "#0f172a";
            }
            return;
        }

        if (!navigator.onLine) {
            showHUD("Impossibile scaricare: nessuna connessione a internet.", "⚠️");
            if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">Connessione a internet assente</span>`;
            return;
        }

        const stream = await getStreamUrl(false);
        if (!stream || !stream.url) {
            showHUD("Flusso video non trovato. Avvia prima la riproduzione.", "⚠️");
            if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">Avvia la riproduzione del video per rilevare il flusso</span>`;
            return;
        }

        const video = getPrimaryVideo();
        const duration = video?.duration || 0;
        const title = sanitizeWebexTitle(stream.title || document.title);
        const streamUrl = stream.url;

        isDownloadInProgress = true;

        if (progressBar) progressBar.style.display = "block";
        if (progressFill) progressFill.style.width = "0%";
        if (btn) {
            btn.innerText = "✕ Annulla";
            btn.style.background = "#ef4444";
            btn.style.color = "#ffffff";
        }
        if (statusEl) statusEl.innerHTML = `<span>Avvio download in background...</span>`;
        showHUD("Download del buffer avviato in background...", "📥");

        // Delegate entire download to background service worker (immune to CORS restrictions)
        chrome.runtime.sendMessage({
            type: "START_BACKGROUND_DOWNLOAD",
            streamUrl: streamUrl,
            title: title,
            id: recordingId,
            fraction: fraction,
            duration: duration,
            url: window.location.href,
            folder: (folder && folder !== "Generale") ? folder : ""
        }, (res) => {
            if (chrome.runtime.lastError || (res && !res.success)) {
                isDownloadInProgress = false;
                if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">Errore avvio download</span>`;
                if (btn) {
                    btn.innerText = "📥 Scarica Buffer";
                    btn.style.background = "#38bdf8";
                    btn.style.color = "#0f172a";
                }
            }
        });
    }

    function base64ToUint8Array(b64) {
        const binary = atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function streamLectureBlobFromBackground(lectureId, pageUrl, pageTitle, onProgress) {
        return new Promise((resolve, reject) => {
            const port = chrome.runtime.connect({ name: "GET_LECTURE_BLOB_STREAM" });
            const chunks = [];
            let mime = "video/mp4";
            let total = 0;
            let received = 0;

            port.onMessage.addListener((msg) => {
                if (msg.type === "BLOB_START") {
                    total = msg.totalBytes;
                    mime = msg.mimeType || "video/mp4";
                    if (onProgress) onProgress(0, total);
                } else if (msg.type === "BLOB_CHUNK") {
                    let bytes = null;
                    if (msg.base64Chunk) {
                        bytes = base64ToUint8Array(msg.base64Chunk);
                    } else if (msg.buffer && msg.buffer.byteLength) {
                        bytes = new Uint8Array(msg.buffer);
                    }
                    if (bytes && bytes.byteLength > 0) {
                        chunks.push(bytes);
                        received += bytes.byteLength;
                    }
                    if (onProgress && total > 0) {
                        const pct = Math.min(100, Math.round((received / total) * 100));
                        onProgress(pct, total);
                    }
                } else if (msg.type === "BLOB_END") {
                    try { port.disconnect(); } catch (_) {}
                    const fullBlob = new Blob(chunks, { type: mime });
                    console.log(`[WebexHelper] Successfully received full blob: ${fullBlob.size} bytes (${Math.round(fullBlob.size / (1024*1024))} MB)`);
                    resolve(fullBlob);
                } else if (msg.type === "BLOB_ERROR") {
                    try { port.disconnect(); } catch (_) {}
                    reject(new Error(msg.error || "Errore trasferimento blob"));
                }
            });

            port.onDisconnect.addListener(() => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Disconnesso"));
                }
            });

            port.postMessage({
                type: "REQUEST_BLOB",
                lectureId,
                pageUrl,
                pageTitle
            });
        });
    }

    async function useBufferInThisPage() {
        if (bufferedBlob && bufferedBlob.size >= 500000) {
            applyLocalBlobToWebexPlayer(bufferedBlob);
            return;
        }

        const recId = getRecordingId();
        const pUrl = window.location.href;
        const pTitle = sanitizeWebexTitle(document.title || "");

        // Fast path: Check if in-page WebexOfflineDB already has this lecture blob
        if (window.WebexOfflineDB) {
            try {
                let localLec = await window.WebexOfflineDB.getLecture(recId);
                if (!localLec) localLec = await window.WebexOfflineDB.findLecture({ recordingId: recId, pageUrl: pUrl, pageTitle: pTitle });
                if (localLec && localLec.blob && localLec.blob.size >= 500000) {
                    bufferedBlob = localLec.blob;
                    applyLocalBlobToWebexPlayer(bufferedBlob);
                    const statusEl = document.getElementById("webex-buffer-status");
                    if (statusEl) statusEl.innerHTML = `<span style="color: #10b981; font-weight:700;">✅ In riproduzione dal buffer locale</span>`;
                    return;
                }
            } catch (_) {}
        }

        showHUD("Caricamento buffer locale...", "⏳");
        const statusEl = document.getElementById("webex-buffer-status");
        if (statusEl) statusEl.innerHTML = `<span>Caricamento video dal buffer...</span>`;

        try {
            const blob = await streamLectureBlobFromBackground(recId, pUrl, pTitle, (pct, total) => {
                if (statusEl) {
                    const mb = Math.round(total / (1024 * 1024));
                    statusEl.innerHTML = `<span>Caricamento buffer: ${pct}% di ${mb} MB...</span>`;
                }
            });

            if (blob && blob.size >= 500000) {
                bufferedBlob = blob;
                // Cache into page's local IndexedDB for instant future playback
                if (window.WebexOfflineDB) {
                    try {
                        const vid = getPrimaryVideo();
                        const existingSub = (subtitlesCues && subtitlesCues.length > 0) ? JSON.stringify(subtitlesCues) : localStorage.getItem('webex_subtitles_' + recId);
                        await window.WebexOfflineDB.saveLecture({
                            id: recId,
                            title: pTitle,
                            url: pUrl,
                            blob: blob,
                            size: blob.size,
                            duration: vid?.duration || 0,
                            date: new Date().toISOString(),
                            subtitlesData: existingSub || undefined
                        });
                    } catch (_) {}
                }
                applyLocalBlobToWebexPlayer(bufferedBlob);
                if (statusEl) statusEl.innerHTML = `<span style="color: #10b981; font-weight:700;">✅ In riproduzione dal buffer locale</span>`;
            } else {
                throw new Error("Buffer video non valido o incompleto");
            }
        } catch (err) {
            console.error("[WebexHelper] Error loading buffer blob:", err);
            showHUD("Errore: impossibile caricare il buffer locale", "⚠️");
            if (statusEl) statusEl.innerHTML = `<span style="color:#ef4444;">Impossibile caricare il video (${err.message})</span>`;
        }
    }

    function updateOfflineButtonsReady(hasSaved = true) {
        const btn = document.getElementById("webex-btn-download-buffer");
        const linksBox = document.querySelector(".webex-helper-buffer-links");
        const qaBufferBtn = document.getElementById("webex-qa-buffer");

        if (btn) {
            if (hasSaved) {
                btn.innerText = "✓ Scaricato";
                btn.style.background = "#10b981";
                btn.style.color = "#ffffff";
            } else {
                btn.innerText = "📥 Scarica Buffer";
                btn.style.background = "#38bdf8";
                btn.style.color = "#0f172a";
            }
        }

        if (qaBufferBtn) {
            // User requested: When in buffer mode, DO NOT show "Usa buffer qui" button (it's redundant).
            // Only show when buffer is saved AND we are NOT in buffer mode!
            if (hasSaved && !isBufferPlaybackActive) {
                qaBufferBtn.style.setProperty("display", "flex", "important");
                qaBufferBtn.innerHTML = `<span class="icon" style="margin-right: 6px;">⚡</span> Usa Buffer qui`;
                qaBufferBtn.style.background = "rgba(16, 185, 129, 0.25)";
                qaBufferBtn.onclick = (e) => { e.stopPropagation(); useBufferInThisPage(); };
            } else {
                // If not saved OR already in buffer mode: hide completely
                qaBufferBtn.style.setProperty("display", "none", "important");
            }
        }

        if (linksBox) {
            let useBtn = document.getElementById("webex-btn-use-buffer-page");
            if (hasSaved) {
                if (!useBtn) {
                    useBtn = document.createElement("button");
                    useBtn.id = "webex-btn-use-buffer-page";
                    linksBox.insertBefore(useBtn, linksBox.firstChild);
                }
                if (isBufferPlaybackActive) {
                    useBtn.className = "webex-helper-buffer-link-btn active-stop-buffer";
                    useBtn.innerHTML = "🔴 Non usare il buffer in questa pagina";
                    useBtn.onclick = () => revertBufferPlaybackToOriginal();
                } else {
                    useBtn.className = "webex-helper-buffer-link-btn primary-use-buffer";
                    useBtn.innerHTML = "▶️ Usa Buffer in questa pagina";
                    useBtn.onclick = () => useBufferInThisPage();
                }
            } else if (useBtn) {
                useBtn.remove();
            }
        }
    }

    async function downloadFullMp4() {
        const stream = await getStreamUrl(false);
        const title = (stream?.title || document.title).replace(/[^\w\s\d\-_~]/g, "_");
        const filename = `${title}.mp4`;

        if (bufferedBlob) {
            const url = URL.createObjectURL(bufferedBlob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showHUD(`Salvataggio MP4 in corso... (${filename})`, "💾");
            return;
        }

        if (stream && stream.url) {
            chrome.runtime.sendMessage({
                type: "DOWNLOAD_FILE",
                url: stream.url,
                filename: filename
            }, (res) => {
                if (res && res.success) {
                    showHUD(`Download MP4 avviato! (${filename})`, "💾");
                } else {
                    showHUD("Errore avvio download MP4", "⚠️");
                }
            });
        } else {
            showHUD("Flusso video non trovato per il download", "⚠️");
        }
    }

    // Check if lecture is already in IndexedDB
    async function checkSavedLectureOnLoad() {
        const recordingId = getRecordingId();
        const pageTitle = sanitizeWebexTitle(document.title || "");
        const pageUrl = window.location.href;

        // 1. Direct local lookup first via smart findLecture
        if (window.WebexOfflineDB) {
            try {
                const localData = await window.WebexOfflineDB.findLecture({
                    recordingId: recordingId,
                    pageUrl: pageUrl,
                    pageTitle: pageTitle
                });
                if (localData && (localData.blob || localData.fileHandle)) {
                    const blob = localData.blob || (localData.fileHandle ? await localData.fileHandle.getFile() : null);
                    if (blob) {
                        bufferedBlob = blob;
                        const statusEl = document.getElementById("webex-buffer-status");
                        const progressBar = document.getElementById("webex-buffer-bar");
                        const progressFill = document.getElementById("webex-buffer-fill");

                        if (progressBar) progressBar.style.display = "block";
                        if (progressFill) progressFill.style.width = "100%";
                        if (statusEl) statusEl.innerHTML = `<span style="color: #10b981; font-weight:700;">✅ Già in memoria locale (${Math.round((localData.size || blob.size) / (1024*1024))} MB)</span>`;

                        updateOfflineButtonsReady(blob);
                        return;
                    }
                }
            } catch (e) {
                console.warn("[WebexHelper] Local DB lookup warning:", e);
            }
        }

        // 2. Query Background service worker with smart cascade parameters
        chrome.runtime.sendMessage({
            type: "CHECK_SAVED_LECTURE",
            lectureId: recordingId,
            pageUrl: pageUrl,
            pageTitle: pageTitle
        }, async (res) => {
            if (res && res.saved) {
                if (window.WebexOfflineDB) {
                    try {
                        const targetId = res.lectureId || recordingId;
                        const data = await window.WebexOfflineDB.getLecture(targetId);
                        if (data && (data.blob || data.fileHandle)) {
                            const blob = data.blob || (data.fileHandle ? await data.fileHandle.getFile() : null);
                            if (blob) {
                                bufferedBlob = blob;
                                const statusEl = document.getElementById("webex-buffer-status");
                                const progressBar = document.getElementById("webex-buffer-bar");
                                const progressFill = document.getElementById("webex-buffer-fill");

                                if (progressBar) progressBar.style.display = "block";
                                if (progressFill) progressFill.style.width = "100%";
                                if (statusEl) statusEl.innerHTML = `<span style="color: #10b981; font-weight:700;">✅ Già in memoria locale (${Math.round((data.size || blob.size) / (1024*1024))} MB)</span>`;

                                updateOfflineButtonsReady(blob);
                                return;
                            }
                        }
                    } catch (e) {}
                }

                const statusEl = document.getElementById("webex-buffer-status");
                const progressBar = document.getElementById("webex-buffer-bar");
                const progressFill = document.getElementById("webex-buffer-fill");

                if (progressBar) progressBar.style.display = "block";
                if (progressFill) progressFill.style.width = "100%";
                if (statusEl) statusEl.innerHTML = `<span style="color: #10b981; font-weight:700;">✅ Disponibile nell'Offline Player (${res.sizeMB} MB)</span>`;
            } else {
                // If not saved, ONLY reset current page UI state - NEVER DELETE ANY DB ENTRY!
                bufferedBlob = null;
                const statusEl = document.getElementById("webex-buffer-status");
                const progressBar = document.getElementById("webex-buffer-bar");
                const progressFill = document.getElementById("webex-buffer-fill");
                const btn = document.getElementById("webex-btn-download-buffer");

                if (progressBar) progressBar.style.display = "none";
                if (progressFill) progressFill.style.width = "0%";
                if (statusEl) statusEl.innerHTML = `<span>Pronto per il pre-caricamento offline</span>`;
                if (btn) {
                    btn.innerText = "📥 Scarica Buffer";
                    btn.style.background = "#38bdf8";
                    btn.style.color = "#0f172a";
                }
            }
        });
    }

    // --- Webex Control Bar Native Injection (-30s, +30s, Speed, Audio Boost) ---
    function injectNativeControlBarControls() {
        if (document.getElementById("webex-native-btn-minus-30")) return;

        const controlBar = document.querySelector('.vjs-control-bar, [class*="control-bar"], [class*="playback-controls"]');
        if (!controlBar) return;

        const allButtons = Array.from(controlBar.querySelectorAll('button, div[role="button"]'));
        let minus10Btn = null;
        let plus10Btn = null;

        for (const btn of allButtons) {
            try {
                if (!btn) continue;
                const rawTitle = typeof btn.title === 'string' ? btn.title : (btn.title && typeof btn.title.baseVal === 'string' ? btn.title.baseVal : '');
                const rawAria = typeof btn.getAttribute === 'function' ? (btn.getAttribute('aria-label') || '') : '';
                const rawInner = typeof btn.innerText === 'string' ? btn.innerText : '';
                const rawHtml = typeof btn.innerHTML === 'string' ? btn.innerHTML : '';
                const text = String(rawInner || rawAria || rawTitle || rawHtml || '').toLowerCase();
                if ((text.includes('10') || text.includes('ten')) && (text.includes('back') || text.includes('rewind') || text.includes('indietro') || text.includes('-') || text.includes('previous') || text.includes('rwd'))) {
                    if (!minus10Btn) minus10Btn = btn;
                } else if ((text.includes('10') || text.includes('ten')) && (text.includes('fwd') || text.includes('forward') || text.includes('avanti') || text.includes('+') || text.includes('next'))) {
                    if (!plus10Btn) plus10Btn = btn;
                }
            } catch (_) {}
        }

        if (!minus10Btn || !plus10Btn) {
            const tens = allButtons.filter(b => (typeof b.innerHTML === 'string' && b.innerHTML.includes('10')));
            if (tens.length >= 2) {
                minus10Btn = tens[0];
                plus10Btn = tens[1];
            }
        }

        // 1. -30s button
        if (minus10Btn && !document.getElementById("webex-native-btn-minus-30")) {
            const btnMinus30 = document.createElement("button");
            btnMinus30.id = "webex-native-btn-minus-30";
            btnMinus30.className = "vjs-control vjs-button webex-injected-native-btn";
            btnMinus30.title = "Indietro 30 secondi (Shift+←)";
            btnMinus30.innerHTML = `
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                    <path d="M3 3v5h5"/>
                    <text x="12" y="15.5" font-size="8" font-weight="bold" fill="currentColor" stroke="none" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, sans-serif">30</text>
                </svg>
            `;
            btnMinus30.onclick = (e) => {
                e.stopPropagation();
                seekVideo(-30);
            };
            minus10Btn.insertAdjacentElement('beforebegin', btnMinus30);
        }

        // 2. +30s button
        if (plus10Btn && !document.getElementById("webex-native-btn-plus-30")) {
            const btnPlus30 = document.createElement("button");
            btnPlus30.id = "webex-native-btn-plus-30";
            btnPlus30.className = "vjs-control vjs-button webex-injected-native-btn";
            btnPlus30.title = "Avanti 30 secondi (Shift+→)";
            btnPlus30.innerHTML = `
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.99 6.57 2.6L21 8"/>
                    <path d="M21 3v5h-5"/>
                    <text x="12" y="15.5" font-size="8" font-weight="bold" fill="currentColor" stroke="none" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, sans-serif">30</text>
                </svg>
            `;
            btnPlus30.onclick = (e) => {
                e.stopPropagation();
                seekVideo(+30);
            };
            plus10Btn.insertAdjacentElement('afterend', btnPlus30);
        }

        // 3. Speed pill
        if (!document.getElementById("webex-native-speed-container")) {
            const speedContainer = document.createElement("div");
            speedContainer.id = "webex-native-speed-container";
            speedContainer.className = "webex-native-speed-container";

            const video = getPrimaryVideo();
            const currentSpeedStr = (video ? video.playbackRate : 1.0).toFixed(2).replace(/\.00$/, '') + "x";

            speedContainer.innerHTML = `
                <button class="webex-native-speed-btn" id="webex-native-speed-minus" title="Riduci" style="border-radius: 9999px 0 0 9999px; padding-right: 6px;">
                    <span>-</span>
                </button>
                <button class="webex-native-speed-btn" id="webex-native-speed-pill" title="Cambia velocità di riproduzione" style="border-radius: 0; border-left: none; border-right: none;">
                    <span>⚡</span>
                    <span id="webex-native-speed-label">${currentSpeedStr}</span>
                </button>
                <button class="webex-native-speed-btn" id="webex-native-speed-plus" title="Aumenta" style="border-radius: 0 9999px 9999px 0; padding-left: 6px;">
                    <span>+</span>
                </button>
                <div class="webex-native-speed-menu" id="webex-native-speed-dropdown">
                    <button class="webex-native-speed-option" data-speed="0.8">0.80x</button>
                    <button class="webex-native-speed-option" data-speed="0.9">0.90x</button>
                    <button class="webex-native-speed-option" data-speed="1.0">1.0x</button>
                    <button class="webex-native-speed-option" data-speed="1.1">1.10x</button>
                    <button class="webex-native-speed-option" data-speed="1.25">1.25x</button>
                    <button class="webex-native-speed-option" data-speed="1.5">1.50x</button>
                    <button class="webex-native-speed-option" data-speed="1.75">1.75x</button>
                    <button class="webex-native-speed-option" data-speed="2.0">2.0x</button>
                </div>
            `;

            const anchor = document.getElementById("webex-native-btn-plus-30") || plus10Btn || controlBar.querySelector('.vjs-playback-rate');
            if (anchor) {
                anchor.insertAdjacentElement('afterend', speedContainer);
            } else {
                controlBar.appendChild(speedContainer);
            }

            const pill = speedContainer.querySelector("#webex-native-speed-pill");
            const menu = speedContainer.querySelector("#webex-native-speed-dropdown");

            pill.onclick = (e) => {
                e.stopPropagation();
                menu.classList.toggle("visible");
            };

            document.addEventListener("click", () => menu.classList.remove("visible"));
            
            const minusBtn = speedContainer.querySelector("#webex-native-speed-minus");
            if (minusBtn) minusBtn.onclick = (e) => { e.stopPropagation(); changeSpeed(-0.1); };
            
            const plusBtn = speedContainer.querySelector("#webex-native-speed-plus");
            if (plusBtn) plusBtn.onclick = (e) => { e.stopPropagation(); changeSpeed(0.1); };

            speedContainer.querySelectorAll(".webex-native-speed-option").forEach(opt => {
                opt.onclick = (e) => {
                    e.stopPropagation();
                    const s = parseFloat(opt.dataset.speed);
                    changeSpeed(0, s);
                    menu.classList.remove("visible");
                };
            });
        }

        // 4. Boost button
        if (!document.getElementById("webex-native-boost-btn")) {
            const volPanel = controlBar.querySelector('.vjs-volume-panel, [class*="volume"]');
            const boostBtn = document.createElement("button");
            boostBtn.id = "webex-native-boost-btn";
            boostBtn.className = "webex-native-boost-btn";
            boostBtn.title = "Amplificatore audio Webex (Clicca per aumentare 100% -> 300%)";
            boostBtn.innerHTML = `<span>🔊</span><span id="webex-native-boost-text">Boost 100%</span>`;
            boostBtn.onclick = (e) => {
                e.stopPropagation();
                cycleAudioBoost();
            };

            if (volPanel) {
                volPanel.insertAdjacentElement('afterend', boostBtn);
            } else {
                controlBar.appendChild(boostBtn);
            }
        }
        
        // 5. Custom Group (Zoom, Silence, Comments, Adv Bar)
        if (!document.getElementById("webex-native-custom-group")) {
            const grp = document.createElement("div");
            grp.id = "webex-native-custom-group";
            grp.style.display = "inline-flex";
            grp.style.alignItems = "center";
            grp.style.marginLeft = "4px";

            const zoomBtn = document.createElement("button");
            zoomBtn.className = "webex-native-boost-btn";
            zoomBtn.title = "Zoom Video (Z)";
            zoomBtn.innerHTML = `<span>🔍</span>`;
            zoomBtn.onclick = (e) => { e.stopPropagation(); cycleZoom(); };
            grp.appendChild(zoomBtn);

            const silenceBtn = document.createElement("button");
            silenceBtn.className = "webex-native-boost-btn";
            silenceBtn.title = "Controlli Salta Silenzi (S)";
            silenceBtn.innerHTML = `<span>✂️</span>`;
            silenceBtn.onclick = (e) => { e.stopPropagation(); toggleSilenceSkip(); };
            grp.appendChild(silenceBtn);

            const commentsBtn = document.createElement("button");
            commentsBtn.className = "webex-native-boost-btn";
            commentsBtn.title = "Note & Commenti (N)";
            commentsBtn.innerHTML = `<span>📝</span>`;
            commentsBtn.onclick = (e) => { e.stopPropagation(); showNotesModal(); };
            grp.appendChild(commentsBtn);

            const advBtn = document.createElement("button");
            advBtn.className = "webex-native-boost-btn";
            advBtn.title = "Mostra Barra Avanzata (B)";
            advBtn.innerHTML = `<span>🛠️</span>`;
            advBtn.onclick = (e) => { 
                e.stopPropagation(); 
                const tb = document.getElementById("webex-helper-toolbar-container");
                if (tb) {
                    if (tb.style.display === "none" || tb.style.display === "") {
                        tb.style.display = "flex";
                        tb.classList.add("visible");
                    } else {
                        tb.style.display = "none";
                        tb.classList.remove("visible");
                    }
                }
            };
            grp.appendChild(advBtn);

            const boost = document.getElementById("webex-native-boost-btn");
            if (boost) boost.insertAdjacentElement('afterend', grp);
        }
    }

    function updateNativeSpeedDisplay(speed) {
        const lbl = document.getElementById("webex-native-speed-label");
        if (lbl) lbl.innerText = speed.toFixed(2).replace(/\.00$/, '') + "x";

        document.querySelectorAll(".webex-native-speed-option").forEach(opt => {
            const s = parseFloat(opt.dataset.speed);
            opt.classList.toggle("active", Math.abs(s - speed) < 0.03);
        });
    }

    function updateNativeBoostButton() {
        const txt = document.getElementById("webex-native-boost-text");
        const btn = document.getElementById("webex-native-boost-btn");
        if (txt) txt.innerText = `Boost ${Math.round(currentVolumeBoost * 100)}%`;
        if (btn) btn.classList.toggle("boosted", currentVolumeBoost > 1.05);
    }

    // --- Dynamic Toolbar Positioning: Always Docked & Centered (Never Cut Off) ---
    function updateToolbarPosition() {
        const toolbar = document.getElementById("webex-helper-toolbar-container");
        if (!toolbar) return;

        // Position: Always docked at bottom center of viewport, never off-screen
        toolbar.style.top = "";
        toolbar.style.bottom = "18px";
        toolbar.style.left = "50%";
        toolbar.style.transform = "translateX(-50%)";

        const windowW = window.innerWidth;
        const player = getPlayerContainer();
        let targetW = 960;
        if (player) {
            const rect = player.getBoundingClientRect();
            targetW = Math.min(rect.width - 24, 960);
        }
        targetW = Math.min(targetW, windowW - 32);
        toolbar.style.width = `${Math.max(340, targetW)}px`;
    }

    function updateToolbarSpeed(speed) {
        const valEl = document.getElementById("webex-helper-speed-display");
        const pillEl = document.getElementById("webex-helper-pill-text");
        const formatted = speed.toFixed(2).replace(/\.00$/, '') + "x";
        if (valEl) valEl.innerText = formatted;
        if (pillEl) pillEl.innerText = formatted;
        const qaSpeedEl = document.getElementById("webex-qa-speed-val");
        if (qaSpeedEl) qaSpeedEl.innerText = formatted;

        document.querySelectorAll(".webex-helper-chip").forEach(chip => {
            const chipSpeed = parseFloat(chip.dataset.speed);
            chip.classList.toggle("active", Math.abs(chipSpeed - speed) < 0.03);
        });

        updateNativeSpeedDisplay(speed);
    }

    function updateActionButtonsState() {
        // Zoom Button & Flyout
        const btnZoom = document.getElementById("webex-action-zoom");
        const lblZoom = document.getElementById("webex-action-zoom-lbl");
        const zoomFlyout = document.getElementById("webex-zoom-flyout");
        const zoomSlider = document.getElementById("webex-zoom-slider");
        const zoomSliderVal = document.getElementById("webex-zoom-slider-val");
        const zoomSliderBox = document.getElementById("webex-zoom-slider-box");

        const isZoomActive = zoomLevel > 1.0;
        if (btnZoom && lblZoom) {
            btnZoom.classList.toggle("active", isZoomActive);
            lblZoom.innerText = isZoomActive ? `Zoom ${zoomLevel.toFixed(1)}x` : "Zoom";
        }
        if (zoomFlyout) {
            zoomFlyout.querySelectorAll(".webex-flyout-chip").forEach(chip => {
                const z = parseFloat(chip.dataset.zoom);
                chip.classList.toggle("active", Math.abs(z - zoomLevel) < 0.05);
            });
        }
        if (zoomSlider) zoomSlider.value = zoomLevel;
        if (zoomSliderVal) zoomSliderVal.innerText = `Ingrandimento: ${zoomLevel.toFixed(1)}x`;
        if (zoomSliderBox) zoomSliderBox.style.display = "flex";

        // Filter Button & Flyout
        const btnFilter = document.getElementById("webex-action-filter");
        const lblFilter = document.getElementById("webex-action-filter-lbl");
        const filterFlyout = document.getElementById("webex-filter-flyout");
        const filterSlider = document.getElementById("webex-filter-slider");
        const filterSliderVal = document.getElementById("webex-filter-slider-val");
        const filterSliderBox = document.getElementById("webex-filter-slider-box");

        const isFilterActive = currentFilterId !== "normal" && filterIntensity > 0;
        if (btnFilter && lblFilter) {
            btnFilter.classList.toggle("active", isFilterActive);
            lblFilter.innerText = "Filtro";
        }
        if (filterFlyout) {
            filterFlyout.querySelectorAll(".webex-flyout-chip").forEach(chip => {
                chip.classList.toggle("active", chip.dataset.filter === currentFilterId);
            });
        }
        if (filterSlider) filterSlider.value = filterIntensity;
        if (filterSliderVal) filterSliderVal.innerText = `Intensità: ${filterIntensity}%`;
        if (filterSliderBox) filterSliderBox.style.display = "flex";

        // Silence Skip & Tolerance
        const btnSilence = document.getElementById("webex-action-silence");
        const silenceFlyout = document.getElementById("webex-silence-flyout");
        const silenceTolSlider = document.getElementById("webex-silence-tol-slider");
        const silenceTolLbl = document.getElementById("webex-silence-tol-lbl");
        if (btnSilence) btnSilence.classList.toggle("active", isSilenceSkipActive);
        if (silenceFlyout) {
            silenceFlyout.querySelectorAll(".webex-flyout-chip").forEach(chip => {
                const s = parseFloat(chip.dataset.silenceSpeed);
                chip.classList.toggle("active", Math.abs(s - silenceSkipSpeed) < 0.1);
            });
        }
        if (silenceTolSlider) silenceTolSlider.value = silenceToleranceSeconds;
        if (silenceTolLbl) silenceTolLbl.innerText = `Ritardo inizio: ${silenceToleranceSeconds.toFixed(2)}s`;

        // Slide Flyout Chips
        const slideFlyout = document.getElementById("webex-slide-flyout");
        if (slideFlyout) {
            slideFlyout.querySelectorAll(".webex-flyout-chip").forEach(chip => {
                chip.classList.toggle("active", chip.dataset.slideMode === slideMode);
            });
        }

        // Loop A-B
        const btnLoop = document.getElementById("webex-action-loop");
        const lblLoop = document.getElementById("webex-action-loop-lbl");
        const loopTitle = document.getElementById("webex-loop-status-title");
        if (btnLoop && lblLoop) {
            btnLoop.classList.toggle("active", isLooping || loopA !== null);
            if (isLooping) {
                lblLoop.innerText = `Loop (${formatTime(loopA)} ↔ ${formatTime(loopB)})`;
            } else if (loopA !== null) {
                lblLoop.innerText = `A: ${formatTime(loopA)}`;
            } else {
                lblLoop.innerText = "Loop";
            }
        }
        if (loopTitle) {
            if (isLooping) {
                loopTitle.innerText = `Loop Attivo: ${formatTime(loopA)} ↔ ${formatTime(loopB)}`;
            } else if (loopA !== null) {
                loopTitle.innerText = `Punto A: ${formatTime(loopA)} (Imposta B)`;
            } else {
                loopTitle.innerText = "Loop Ripetizione A-B";
            }
        }

        // Subtitles (Spotify Style)
        const btnSub = document.getElementById("webex-action-subtitles");
        if (btnSub) {
            btnSub.classList.toggle("active", !!isSubtitlesPanelOpen);
        }
        const btnQaSub = document.getElementById("webex-qa-subtitles");
        if (btnQaSub) {
            btnQaSub.classList.toggle("active", !!isSubtitlesPanelOpen);
        }
    }


    // --- Dynamic Quick Actions Bar Positioning (Docked Bottom-Left of Player) ---
    function repositionQuickActionsBar() {
        const qBar = document.getElementById("webex-quick-actions-bar");
        if (!qBar) return;

        // If the main toolbar container is expanded/open, hide quick actions bar so it never overlaps!
        const tbContainer = document.getElementById("webex-helper-toolbar-container");
        if (tbContainer && !tbContainer.classList.contains("collapsed")) {
            qBar.style.setProperty("display", "none", "important");
            return;
        }

        const container = getPlayerContainer();
        const vid = getPrimaryVideo();
        const rect = container ? container.getBoundingClientRect() : (vid ? vid.getBoundingClientRect() : null);

        if (rect && rect.width > 0 && rect.height > 0) {
            const isFullscreen = !!(document.fullscreenElement && (document.fullscreenElement === container || document.fullscreenElement === vid)) || 
                                 (window.innerWidth === screen.width && window.innerHeight === screen.height);
            const spaceBelow = window.innerHeight - rect.bottom;

            if (isFullscreen) {
                // In fullscreen: align bottom-left above the native timeline
                qBar.style.setProperty("bottom", "75px", "important");
                qBar.style.setProperty("top", "auto", "important");
                qBar.style.setProperty("left", "24px", "important");
                qBar.style.setProperty("right", "auto", "important");
            } else if (spaceBelow < 55) {
                // Video fills screen (non-fullscreen): dock at bottom-left inside player, above native controls
                qBar.style.setProperty("bottom", "58px", "important");
                qBar.style.setProperty("top", "auto", "important");
                qBar.style.setProperty("left", `${Math.max(16, rect.left + 16)}px`, "important");
                qBar.style.setProperty("right", "auto", "important");
            } else {
                // Space exists under the player: place it neatly below the player on the left
                qBar.style.setProperty("top", `${rect.bottom + 8}px`, "important");
                qBar.style.setProperty("bottom", "auto", "important");
                qBar.style.setProperty("left", `${Math.max(16, rect.left)}px`, "important");
                qBar.style.setProperty("right", "auto", "important");
            }
        } else {
            // Safe fallback: docked at bottom-left
            qBar.style.setProperty("bottom", "58px", "important");
            qBar.style.setProperty("top", "auto", "important");
            qBar.style.setProperty("left", "16px", "important");
            qBar.style.setProperty("right", "auto", "important");
        }
        qBar.style.setProperty("display", "flex", "important");
        qBar.style.setProperty("position", "fixed", "important");
        qBar.style.setProperty("z-index", "2147483647", "important");
    }
    window.addEventListener("resize", repositionQuickActionsBar);
    if (typeof ResizeObserver !== "undefined") {
        let playerResizeObserver = null;
        let lastObservedTarget = null;
        const observeTarget = () => {
            const target = getPlayerContainer() || getPrimaryVideo();
            if (target && target !== lastObservedTarget) {
                if (playerResizeObserver) playerResizeObserver.disconnect();
                playerResizeObserver = new ResizeObserver(() => {
                    repositionQuickActionsBar();
                });
                playerResizeObserver.observe(target);
                lastObservedTarget = target;
            }
        };
        observeTarget();
        // Check once a couple seconds after load in case container wasn't ready
        setTimeout(observeTarget, 1000);
        setTimeout(observeTarget, 3000);
    }

    // Auto-hide Quick Actions Bar in Fullscreen on mouse inactivity
    let qaFullscreenIdleTimeout = null;
    function handleQABarFullscreenActivity() {
        const qBar = document.getElementById("webex-quick-actions-bar");
        if (!qBar) return;
        const isFullscreen = !!document.fullscreenElement || (window.innerWidth === screen.width && window.innerHeight === screen.height);
        
        if (!isFullscreen) {
            qBar.style.opacity = "1";
            qBar.style.pointerEvents = "auto";
            return;
        }

        // On mouse movement in fullscreen, immediately reveal the bar
        qBar.style.opacity = "1";
        qBar.style.pointerEvents = "auto";

        clearTimeout(qaFullscreenIdleTimeout);
        qaFullscreenIdleTimeout = setTimeout(() => {
            const isFsNow = !!document.fullscreenElement || (window.innerWidth === screen.width && window.innerHeight === screen.height);
            if (isFsNow && qBar) {
                // Don't hide if user is hovering over the bar or its flyouts
                if (qBar.matches(":hover") || qBar.querySelector(":hover")) {
                    handleQABarFullscreenActivity();
                    return;
                }
                qBar.style.opacity = "0";
                qBar.style.pointerEvents = "none";
            }
        }, 2500);
    }

    document.addEventListener("mousemove", handleQABarFullscreenActivity);
    document.addEventListener("fullscreenchange", () => {
        repositionQuickActionsBar();
        handleQABarFullscreenActivity();
    });

    // --- Create Docked Master Liquid Glass Toolbar ---
    function createToolbar() {
        if (document.getElementById("webex-helper-toolbar-container")) return;

        const container = document.createElement("div");
        container.id = "webex-helper-toolbar-container";
        container.className = "webex-helper-toolbar-container collapsed";

        container.innerHTML = `
            <div class="webex-quick-actions-bar" id="webex-quick-actions-bar">
                <!-- 1. Velocità Video -->
                <div class="webex-floating-box webex-qa-speed-group">
                    <button type="button" id="webex-qa-speed-minus" title="Riduci velocità (↓)">−</button>
                    <span id="webex-qa-speed-val">1.00x</span>
                    <button type="button" id="webex-qa-speed-plus" title="Aumenta velocità (↑)">+</button>
                </div>

                <!-- 2. Usa Buffer in questa pagina (quando presente) -->
                <div class="webex-floating-box webex-qa-btn" id="webex-qa-buffer" title="Usa il buffer scaricato in questa pagina" style="display: none;">
                    <span class="icon" style="margin-right: 6px;">⚡</span> Usa Buffer in questa pagina
                </div>

                <!-- 3. PiP -->
                <div class="webex-floating-box webex-qa-icon-btn" id="webex-qa-pip" title="Picture in Picture (P)">🪟</div>

                <!-- 4. Screenshot / Slide con Flyout -->
                <div class="webex-tool-with-flyout webex-qa-tool-wrapper">
                    <div class="webex-floating-box webex-qa-icon-btn" id="webex-qa-snap" title="Cattura Slide (S)">📸</div>
                    <div class="webex-action-flyout webex-qa-flyout" id="webex-qa-slide-flyout">
                        <div class="webex-flyout-title">Azione Slide</div>
                        <div class="webex-flyout-chips">
                            <button class="webex-flyout-chip" data-slide-mode="copy">📋 Solo Appunti</button>
                            <button class="webex-flyout-chip" data-slide-mode="download">💾 Solo Download</button>
                            <button class="webex-flyout-chip" data-slide-mode="both">⚡ Entrambi</button>
                        </div>
                    </div>
                </div>

                <!-- 5. Zoom con Flyout -->
                <div class="webex-tool-with-flyout webex-qa-tool-wrapper">
                    <div class="webex-floating-box webex-qa-icon-btn" id="webex-qa-zoom" title="Zoom & Pan lavagna (Z)">🔍</div>
                    <div class="webex-action-flyout webex-qa-flyout" id="webex-qa-zoom-flyout">
                        <div class="webex-flyout-title">Ingrandimento Lavagna</div>
                        <div class="webex-flyout-chips">
                            <button class="webex-flyout-chip" data-zoom="1.5">1.5x</button>
                            <button class="webex-flyout-chip" data-zoom="2.0">2.0x</button>
                            <button class="webex-flyout-chip" data-zoom="3.0">3.0x</button>
                            <button class="webex-flyout-chip" data-zoom="1.0">Reset</button>
                        </div>
                        <div class="webex-flyout-slider-row" style="margin-top: 6px;">
                            <span class="webex-flyout-slider-lbl" id="webex-qa-zoom-val">Zoom: 1.0x</span>
                            <input type="range" class="webex-helper-vol-slider" id="webex-qa-zoom-slider" min="1.0" max="5.0" step="0.1" value="1.0">
                        </div>
                    </div>
                </div>

                <!-- 6. Note -->
                <div class="webex-floating-box webex-qa-icon-btn" id="webex-qa-notes" title="Note & Commenti (N)">📝</div>

                <!-- 7. Segnalibro con Flyout -->
                <div class="webex-tool-with-flyout webex-qa-tool-wrapper">
                    <div class="webex-floating-box webex-qa-icon-btn" id="webex-qa-bm" title="Aggiungi Segnalibro al minuto corrente (B)">📌</div>
                    <div class="webex-action-flyout webex-qa-flyout" id="webex-qa-bm-flyout">
                        <div class="webex-flyout-header-row" style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 6px;">
                            <span class="webex-flyout-title" style="margin: 0;">Segnalibri</span>
                            <button class="webex-flyout-add-btn" id="webex-qa-bm-add" style="background: #38bdf8; color: #0f172a; border: none; border-radius: 6px; padding: 2px 7px; font-weight: 700; font-size: 10px; cursor: pointer;">+ Aggiungi ora</button>
                        </div>
                        <div class="webex-bm-quick-list" id="webex-qa-bm-list"></div>
                    </div>
                </div>

                <!-- 8. Audio Boost con Flyout -->
                <div class="webex-tool-with-flyout webex-qa-tool-wrapper">
                    <div class="webex-floating-box webex-qa-icon-btn" id="webex-qa-boost" title="Amplificatore Volume Boost">🔊</div>
                    <div class="webex-action-flyout webex-qa-boost-flyout" id="webex-qa-boost-flyout">
                        <div class="webex-flyout-title">Amplificatore Volume</div>
                        <div class="webex-flyout-slider-row" style="margin-top: 6px; display: flex; align-items: center; gap: 8px;">
                            <input type="range" class="webex-helper-vol-slider" id="webex-qa-boost-slider" min="1.0" max="3.0" step="0.25" value="1.0">
                            <span class="webex-flyout-slider-lbl" id="webex-qa-boost-val" style="min-width: 44px; text-align: right; font-weight: 700; color: #38bdf8;">100%</span>
                        </div>
                    </div>
                </div>

                <!-- 9. Trascrizione -->
                <div class="webex-floating-box webex-qa-icon-btn" id="webex-qa-subtitles" title="Trascrizione e Sottotitoli (T)">💬</div>

                <!-- 10. Toggle Sottotitoli (CC) -->
                <div class="webex-floating-box webex-qa-icon-btn ${isCCOverlayEnabled ? 'active' : ''}" id="webex-qa-cc" title="Sottotitoli a schermo (CC)">CC</div>

                <!-- 11. Ingrandisci la barra (Frecce verso l'esterno) -->
                <button type="button" class="webex-floating-box webex-qa-icon-btn" id="webex-qa-expand" title="Espandi comandi PoliMi (H)" style="border: 1px solid rgba(255,255,255,0.15);">
                    <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <polyline points="9 21 3 21 3 15"></polyline>
                        <line x1="21" y1="3" x2="14" y2="10"></line>
                        <line x1="3" y1="21" x2="10" y2="14"></line>
                    </svg>
                </button>
            </div>

            <div class="webex-helper-panel" id="webex-helper-panel">
                <div class="webex-helper-panel-header">
                    <div class="webex-helper-title">
                        <img src="${chrome.runtime.getURL('images/logo32.png')}" style="width: 20px; height: 20px; border-radius: 5px;" onerror="this.style.display='none'">
                        <span>PoliMi Webex Enhancer</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <div class="webex-helper-eta-row">
                            <span>⏳ Fine stimata:</span>
                            <span class="webex-helper-eta-val" id="webex-eta-display">--:--</span>
                        </div>
                        <button class="webex-helper-close-btn" id="webex-helper-collapse" title="Minimizza comandi (H)">
                            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;">
                                <polyline points="4 14 10 14 10 20"></polyline>
                                <polyline points="20 10 14 10 14 4"></polyline>
                                <line x1="14" y1="10" x2="21" y2="3"></line>
                                <line x1="10" y1="14" x2="3" y2="21"></line>
                            </svg>
                        </button>
                    </div>
                </div>

                <!-- Row 1: Seeking, Speeds & Audio Boost -->
                <div class="webex-helper-row-top">
                    <!-- Seek Capsule -->
                    <div class="webex-helper-seek-group">
                        <button class="webex-helper-seek-btn" id="webex-seek-b30" title="-30s (Shift+←)">−30s</button>
                        <button class="webex-helper-seek-btn webex-helper-seek-primary" id="webex-seek-b10" title="-10s (←)">−10s</button>
                        <button class="webex-helper-seek-btn webex-helper-seek-primary" id="webex-seek-f10" title="+10s (→)">+10s</button>
                        <button class="webex-helper-seek-btn" id="webex-seek-f30" title="+30s (Shift+→)">+30s</button>
                    </div>

                    <!-- Speed Fine-Tuning -->
                    <div class="webex-helper-speed-row">
                        <button class="webex-helper-speed-btn" id="webex-speed-minus" title="Riduci velocità (↓)">−</button>
                        <span class="webex-helper-speed-val" id="webex-helper-speed-display">1.0x</span>
                        <button class="webex-helper-speed-btn" id="webex-speed-plus" title="Aumenta velocità (↑)">+</button>
                    </div>

                    <!-- Speed Preset Chips -->
                    <div class="webex-helper-chips">
                        <div class="webex-helper-chip" data-speed="0.9">0.90x</div>
                        <div class="webex-helper-chip" data-speed="1.0">1.0x</div>
                        <div class="webex-helper-chip" data-speed="1.1">1.10x</div>
                        <div class="webex-helper-chip" data-speed="1.25">1.25x</div>
                        <div class="webex-helper-chip" data-speed="1.5">1.50x</div>
                        <div class="webex-helper-chip" data-speed="1.75">1.75x</div>
                        <div class="webex-helper-chip" data-speed="2.0">2.0x</div>
                    </div>

                    <!-- Volume Boost Slider -->
                    <div class="webex-helper-vol-row">
                        <span>🔊 Boost:</span>
                        <input type="range" class="webex-helper-vol-slider" id="webex-vol-boost" min="1.0" max="3.0" step="0.25" value="1.0" title="Amplificatore volume microfono">
                        <span class="webex-helper-vol-val" id="webex-vol-boost-val">100%</span>
                    </div>
                </div>

                <!-- Row 2: Study Tools by Category (Visualizzazione, Appunti, Avanzate) -->
                <div class="webex-helper-categories-row">
                    <!-- Category 1: Visualizzazione (Prominent Group) -->
                    <div class="webex-cat-group cat-visualizzazione" id="webex-cat-visual">
                        <div class="webex-cat-title">Visualizzazione</div>
                        <div class="webex-cat-tools">
                            <!-- PiP (Compact) -->
                            <button class="webex-helper-action-btn webex-btn-compact" id="webex-action-pip" title="Picture in Picture (P)">
                                <span class="icon">🪟</span>
                                <span>PiP</span>
                            </button>

                            <!-- Zoom (Hero) -->
                            <div class="webex-tool-with-flyout" id="webex-zoom-tool-wrapper">
                                <button class="webex-helper-action-btn webex-btn-hero" id="webex-action-zoom" title="Zoom & Pan lavagna (Z)">
                                    <span class="icon">🔍</span>
                                    <span id="webex-action-zoom-lbl">Zoom</span>
                                </button>
                                <div class="webex-action-flyout" id="webex-zoom-flyout">
                                    <div class="webex-flyout-title">Ingrandimento Lavagna</div>
                                    <div class="webex-flyout-chips">
                                        <button class="webex-flyout-chip" data-zoom="1.5">1.5x</button>
                                        <button class="webex-flyout-chip" data-zoom="2.0">2.0x</button>
                                        <button class="webex-flyout-chip" data-zoom="3.0">3.0x</button>
                                        <button class="webex-flyout-chip" data-zoom="1.0">Reset</button>
                                    </div>
                                    <div class="webex-flyout-slider-row" id="webex-zoom-slider-box">
                                        <span class="webex-flyout-slider-lbl" id="webex-zoom-slider-val">Ingrandimento: 1.0x</span>
                                        <input type="range" class="webex-helper-vol-slider" id="webex-zoom-slider" min="1.0" max="10.0" step="0.1" value="1.0">
                                    </div>
                                </div>
                            </div>

                            <!-- Filtro (Hero) -->
                            <div class="webex-tool-with-flyout" id="webex-filter-tool-wrapper">
                                <button class="webex-helper-action-btn webex-btn-hero" id="webex-action-filter" title="Filtri visivi, luce blu e negativo (C)">
                                    <span class="icon">🎨</span>
                                    <span id="webex-action-filter-lbl">Filtro</span>
                                </button>
                                <div class="webex-action-flyout" id="webex-filter-flyout">
                                    <div class="webex-flyout-title">Filtri Visivi Lavagna</div>
                                    <div class="webex-flyout-chips">
                                        <button class="webex-flyout-chip" data-filter="normal">Normale</button>
                                        <button class="webex-flyout-chip" data-filter="contrast">Contrasto</button>
                                        <button class="webex-flyout-chip" data-filter="bw">B&N</button>
                                        <button class="webex-flyout-chip" data-filter="blue_light">Luce Blu</button>
                                        <button class="webex-flyout-chip" data-filter="negative">Negativo</button>
                                    </div>
                                    <div class="webex-flyout-slider-row" id="webex-filter-slider-box">
                                        <span class="webex-flyout-slider-lbl" id="webex-filter-slider-val">Intensità: 100%</span>
                                        <input type="range" class="webex-helper-vol-slider" id="webex-filter-slider" min="0" max="100" step="5" value="100">
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Category 2: Appunti -->
                    <div class="webex-cat-group cat-appunti" id="webex-cat-notes">
                        <div class="webex-cat-title">Appunti</div>
                        <div class="webex-cat-tools">
                            <!-- Slide (Hero with Flyout) -->
                            <div class="webex-tool-with-flyout" id="webex-slide-tool-wrapper">
                                <button class="webex-helper-action-btn webex-btn-hero" id="webex-action-snap" title="Copia o scarica slide HD (S)">
                                    <span class="icon">📸</span>
                                    <span id="webex-action-slide-lbl">Slide</span>
                                </button>
                                <div class="webex-action-flyout" id="webex-slide-flyout">
                                    <div class="webex-flyout-title">Azione Slide</div>
                                    <div class="webex-flyout-chips">
                                        <button class="webex-flyout-chip" data-slide-mode="copy">📋 Solo Appunti</button>
                                        <button class="webex-flyout-chip" data-slide-mode="download">💾 Solo Download</button>
                                        <button class="webex-flyout-chip" data-slide-mode="both">⚡ Entrambi</button>
                                    </div>
                                </div>
                            </div>

                            <!-- Note (Compact) -->
                            <button class="webex-helper-action-btn webex-btn-compact" id="webex-action-notes" title="Prendi note con export Markdown (N)">
                                <span class="icon">📝</span>
                                <span>Note</span>
                            </button>

                            <!-- Segnalibro (Compact) -->
                            <div class="webex-tool-with-flyout" id="webex-bm-tool-wrapper">
                                <button class="webex-helper-action-btn webex-btn-compact" id="webex-action-bm" title="Aggiungi segnalibro al minuto attuale (B)">
                                    <span class="icon">📌</span>
                                    <span id="webex-action-bm-lbl">Segnalibro</span>
                                </button>
                                <div class="webex-action-flyout" id="webex-bm-flyout">
                                    <div class="webex-flyout-header-row">
                                        <span class="webex-flyout-title">Segnalibri Lezione</span>
                                        <button class="webex-flyout-add-btn" id="webex-bm-quick-add">+ Aggiungi ora</button>
                                    </div>
                                    <div class="webex-bm-quick-list" id="webex-bm-quick-list"></div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Category 3: Avanzate -->
                    <div class="webex-cat-group cat-avanzate" id="webex-cat-advanced">
                        <div class="webex-cat-title">Avanzate</div>
                        <div class="webex-cat-tools">
                            <!-- Silenzi (Standard Hierarchy) -->
                            <div class="webex-tool-with-flyout" id="webex-silence-tool-wrapper">
                                <button class="webex-helper-action-btn webex-btn-standard" id="webex-action-silence" title="Salto automatico pause di silenzio (X)">
                                    <span class="icon">🤫</span>
                                    <span id="webex-action-silence-lbl">Silenzi</span>
                                </button>
                                <div class="webex-action-flyout webex-silence-flyout-box" id="webex-silence-flyout">
                                    <div class="webex-flyout-title" style="display: flex; justify-content: space-between; align-items: center;">
                                        <span>Salto Silenzi</span>
                                        <button type="button" class="webex-silence-info-toggle-btn" id="webex-silence-info-btn" title="Guida agli slider" style="background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 50%; width: 20px; height: 20px; font-size: 11px; font-weight: bold; color: #38bdf8; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; line-height: 1; padding: 0;">ℹ️</button>
                                    </div>
                                    <div class="webex-silence-info-card" id="webex-silence-info-card" style="display: none;">
                                        <div style="font-weight: 700; color: #38bdf8; margin-bottom: 5px;">ℹ️ Guida agli Slider:</div>
                                        <div style="margin-bottom: 5px;"><b style="color: #fff;">1. Velocità:</b> Velocità di riproduzione durante il silenzio (es. 3x-8x per superare le pause rapidamente).</div>
                                        <div style="margin-bottom: 5px;"><b style="color: #fff;">2. Soglia:</b> Livello audio sotto il quale è considerato silenzio. Guarda la % <span style="color: #38bdf8; font-weight: 600;">Attuale</span> mentre il docente non parla per impostarlo appena sopra quel valore.</div>
                                        <div><b style="color: #fff;">3. Ritardo Inizio:</b> Secondi di silenzio continuativo prima di accelerare (evita scatti tra una parola e l'altra).</div>
                                    </div>
                                    <div class="webex-flyout-slider-row">
                                        <span class="webex-flyout-slider-lbl" id="webex-silence-speed-lbl">Velocità: 3.0x</span>
                                        <input type="range" class="webex-helper-vol-slider" id="webex-silence-speed-slider" min="2.0" max="16.0" step="0.5" value="3.0">
                                    </div>
                                    <div class="webex-flyout-slider-row" style="margin-top: 8px;">
                                        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;"><span class="webex-flyout-slider-lbl" id="webex-silence-thresh-lbl">Soglia: 3.5%</span><span style="font-size: 10px; color: #38bdf8;">Attuale: <b id="webex-silence-live-vol">0.0%</b></span></div>
                                        <input type="range" class="webex-helper-vol-slider" id="webex-silence-thresh-slider" min="0" max="10" step="0.5" value="2">
                                    </div>
                                    <div class="webex-flyout-slider-row" style="margin-top: 8px;">
                                        <span class="webex-flyout-slider-lbl" id="webex-silence-tol-lbl">Ritardo Inizio: 1.0s</span>
                                        <input type="range" class="webex-helper-vol-slider" id="webex-silence-tol-slider" min="0.1" max="3.0" step="0.1" value="1.0">
                                    </div>
                                </div>
                            </div>

                            <!-- Loop A-B (Equal Standard Hierarchy) -->
                            <div class="webex-tool-with-flyout" id="webex-loop-tool-wrapper">
                                <button class="webex-helper-action-btn webex-btn-standard" id="webex-action-loop" title="Loop ripetizione A-B (A/B)">
                                    <span class="icon">🔁</span>
                                    <span id="webex-action-loop-lbl">Loop</span>
                                </button>
                                <div class="webex-action-flyout" id="webex-loop-flyout">
                                    <div class="webex-flyout-title" id="webex-loop-status-title">Loop Ripetizione A-B</div>
                                    <div class="webex-flyout-step-row">
                                        <button class="webex-flyout-step-btn" id="webex-loop-set-a">📍 Punto A</button>
                                        <button class="webex-flyout-step-btn" id="webex-loop-set-b">📍 Punto B</button>
                                        <button class="webex-flyout-step-btn danger" id="webex-loop-reset">✕ Reset</button>
                                    </div>
                                </div>
                            </div>
                            <!-- Sottotitoli / Trascrizione Interattiva (Spotify Style) -->
                            <button class="webex-helper-action-btn webex-btn-standard" id="webex-action-subtitles" title="Trascrizione e Sottotitoli (T)">
                                <span class="icon">💬</span>
                                <span id="webex-action-subtitles-lbl">Trascrizione</span>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Row 3: Modalità Offline (Card con In-Page Player & Standalone) -->
                <div class="webex-helper-buffer-box">
                    <div class="webex-helper-buffer-title">
                        <span>📦 Modalità Offline</span>
                        <span id="webex-buffer-tag" style="font-size: 10px; background: rgba(56, 189, 248, 0.2); color:#38bdf8; padding: 2px 7px; border-radius: 5px; font-weight:700;">Memoria Locale</span>
                    </div>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;">
                        <div style="flex: 1; display: flex; gap: 8px; min-width: 260px;">
                            <!-- Liquid Glass Buffer Amount Selector -->
                            <div class="webex-buffer-glass-select-wrapper" id="webex-buffer-amount-wrapper">
                                <button type="button" class="webex-buffer-glass-pill" id="webex-buffer-amount-pill">
                                    <span class="pill-label" id="webex-buffer-amount-label">⏳ Tutta la lezione (100%)</span>
                                    <span class="chevron">▼</span>
                                </button>
                                <div class="webex-buffer-glass-menu" id="webex-buffer-amount-menu">
                                    <div class="webex-buffer-glass-item is-selected" data-val="1.0">⏳ Tutta la lezione (100%)</div>
                                    <div class="webex-buffer-glass-item" data-val="0.5">⏳ Metà lezione (50%)</div>
                                    <div class="webex-buffer-glass-item" data-val="60">⏱️ 60 minuti</div>
                                    <div class="webex-buffer-glass-item" data-val="30">⏱️ 30 minuti</div>
                                    <div class="webex-buffer-glass-item" data-val="15">⏱️ 15 minuti</div>
                                </div>
                                <select id="webex-buffer-select" style="display: none;">
                                    <option value="1.0" selected>Tutta la lezione (100%)</option>
                                    <option value="0.5">Metà lezione (50%)</option>
                                    <option value="60">60 minuti</option>
                                    <option value="30">30 minuti</option>
                                    <option value="15">15 minuti</option>
                                </select>
                            </div>

                            <!-- Liquid Glass Folder Destination Selector -->
                            <div class="webex-buffer-glass-select-wrapper" id="webex-buffer-folder-wrapper">
                                <button type="button" class="webex-buffer-glass-pill" id="webex-buffer-folder-pill">
                                    <span class="pill-label" id="webex-buffer-folder-label">📁 Tutte le lezioni</span>
                                    <span class="chevron">▼</span>
                                </button>
                                <div class="webex-buffer-glass-menu" id="webex-buffer-folder-menu">
                                    <!-- Rendered dynamically -->
                                </div>
                                <select id="webex-buffer-folder-select" style="display: none;">
                                    <option value="" selected>📁 Tutte le lezioni</option>
                                </select>
                            </div>
                        </div>
                        <button class="webex-helper-buffer-btn" id="webex-btn-download-buffer" style="flex-shrink: 0;">📥 Scarica Buffer</button>
                    </div>
                    <div class="webex-helper-buffer-progress-bar" id="webex-buffer-bar">
                        <div class="webex-helper-buffer-progress-fill" id="webex-buffer-fill"></div>
                    </div>
                    <div class="webex-helper-buffer-status" id="webex-buffer-status">
                        <span>Pronto per il pre-caricamento offline</span>
                    </div>
                    <div class="webex-helper-buffer-links">
                        <button class="webex-helper-buffer-link-btn" id="webex-btn-open-offline">📂 Player Offline</button>
                        <button class="webex-helper-buffer-link-btn" id="webex-btn-save-mp4">💾 Salva File MP4</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(container);
        const qaBar = container.querySelector("#webex-quick-actions-bar");
        if (qaBar) { document.body.appendChild(qaBar); repositionQuickActionsBar(); }

        // Toggle Expand / Collapse
        const expandBtn = qaBar ? qaBar.querySelector("#webex-qa-expand") : container.querySelector("#webex-qa-expand");
        const collapseBtn = container.querySelector("#webex-helper-collapse");

        const toggleCollapse = () => {
            isToolbarCollapsed = !isToolbarCollapsed;
            container.classList.toggle("collapsed", isToolbarCollapsed);
            repositionQuickActionsBar();
        };

        if(expandBtn) expandBtn.onclick = toggleCollapse;
        if(collapseBtn) collapseBtn.onclick = toggleCollapse;

        // --- Quick Actions Bar Events ---
        const btnQaMinus = qaBar ? qaBar.querySelector("#webex-qa-speed-minus") : null;
        const btnQaPlus = qaBar ? qaBar.querySelector("#webex-qa-speed-plus") : null;
        if(btnQaMinus) btnQaMinus.onclick = (e) => { e.stopPropagation(); changeSpeed(-0.1); };
        if(btnQaPlus) btnQaPlus.onclick = (e) => { e.stopPropagation(); changeSpeed(+0.1); };

        const btnQaBuffer = qaBar ? qaBar.querySelector("#webex-qa-buffer") : null;
        if(btnQaBuffer) btnQaBuffer.onclick = (e) => { e.stopPropagation(); useBufferInThisPage(); };

        const btnQaPip = qaBar ? qaBar.querySelector("#webex-qa-pip") : null;
        if(btnQaPip) btnQaPip.onclick = (e) => { e.stopPropagation(); togglePiP(); };

        const btnQaSnap = qaBar ? qaBar.querySelector("#webex-qa-snap") : null;
        if(btnQaSnap) btnQaSnap.onclick = (e) => { e.stopPropagation(); captureScreenshot(); };

        // Flyout hover grace period to prevent abrupt closing
        qaBar?.querySelectorAll(".webex-qa-tool-wrapper").forEach(wrapper => {
            let leaveTimer = null;
            const openFlyout = () => {
                clearTimeout(leaveTimer);
                qaBar.querySelectorAll(".webex-qa-tool-wrapper").forEach(w => {
                    if (w !== wrapper) {
                        w.classList.remove("is-open");
                        const f = w.querySelector(".webex-action-flyout");
                        if (f) f.classList.remove("is-open");
                    }
                });
                wrapper.classList.add("is-open");
                const flyout = wrapper.querySelector(".webex-action-flyout");
                if (flyout) flyout.classList.add("is-open");
            };
            const closeFlyout = () => {
                leaveTimer = setTimeout(() => {
                    wrapper.classList.remove("is-open");
                    const flyout = wrapper.querySelector(".webex-action-flyout");
                    if (flyout) flyout.classList.remove("is-open");
                }, 300);
            };
            wrapper.addEventListener("mouseenter", openFlyout);
            wrapper.addEventListener("mouseleave", closeFlyout);
        });

        // Quick Actions Slide Flyout Chips (Select mode & capture immediately)
        qaBar?.querySelectorAll("#webex-qa-slide-flyout .webex-flyout-chip").forEach(chip => {
            chip.onclick = (e) => {
                e.stopPropagation();
                slideMode = chip.dataset.slideMode || "copy";
                try { localStorage.setItem("webex_slide_mode", slideMode); } catch (_) {}
                qaBar.querySelectorAll("#webex-qa-slide-flyout .webex-flyout-chip").forEach(c => {
                    c.classList.toggle("active", c === chip);
                });
                const modeNames = {
                    copy: "Solo Appunti 📋",
                    download: "Solo Download 💾",
                    both: "Entrambi ⚡"
                };
                showHUD(`Slide: ${modeNames[slideMode] || slideMode}`, "📸");
                captureScreenshot();
            };
        });

        // Quick Actions Zoom Button & Flyout
        const btnQaZoom = qaBar ? qaBar.querySelector("#webex-qa-zoom") : null;
        if(btnQaZoom) btnQaZoom.onclick = (e) => { e.stopPropagation(); cycleZoom(); };

        const qaZoomVal = qaBar ? qaBar.querySelector("#webex-qa-zoom-val") : null;
        const qaZoomSlider = qaBar ? qaBar.querySelector("#webex-qa-zoom-slider") : null;

        const updateQaZoomUI = (lvl) => {
            if (qaZoomVal) qaZoomVal.innerText = `Zoom: ${lvl.toFixed(1)}x`;
            if (qaZoomSlider) qaZoomSlider.value = lvl;
            qaBar?.querySelectorAll("#webex-qa-zoom-flyout .webex-flyout-chip").forEach(c => {
                const z = parseFloat(c.dataset.zoom);
                c.classList.toggle("active", Math.abs(z - lvl) < 0.05);
            });
        };

        qaBar?.querySelectorAll("#webex-qa-zoom-flyout .webex-flyout-chip").forEach(chip => {
            chip.onclick = (e) => {
                e.stopPropagation();
                const z = parseFloat(chip.dataset.zoom);
                setZoom(z);
                updateQaZoomUI(z);
            };
        });
        if(qaZoomSlider) {
            qaZoomSlider.oninput = (e) => {
                const z = parseFloat(e.target.value);
                setZoom(z);
                updateQaZoomUI(z);
            };
        }

        // Quick Actions Notes Button
        const btnQaNotes = qaBar ? qaBar.querySelector("#webex-qa-notes") : null;
        if(btnQaNotes) btnQaNotes.onclick = (e) => { e.stopPropagation(); showNotesModal(); };

        // Quick Actions Bookmark Button & Flyout
        const btnQaBm = qaBar ? qaBar.querySelector("#webex-qa-bm") : null;
        if(btnQaBm) btnQaBm.onclick = (e) => { e.stopPropagation(); addBookmark(); updateBookmarkFlyout(); };

        const btnQaBmAdd = qaBar ? qaBar.querySelector("#webex-qa-bm-add") : null;
        if(btnQaBmAdd) {
            btnQaBmAdd.onclick = (e) => {
                e.stopPropagation();
                addBookmark();
                updateBookmarkFlyout();
            };
        }

        // Quick Actions Audio Boost Slider & Sync
        const qaBoostSlider = qaBar ? qaBar.querySelector("#webex-qa-boost-slider") : null;
        const qaBoostVal = qaBar ? qaBar.querySelector("#webex-qa-boost-val") : null;
        if(qaBoostSlider) {
            qaBoostSlider.oninput = (e) => {
                const mult = parseFloat(e.target.value);
                setAudioBoost(mult);
                if (qaBoostVal) qaBoostVal.innerText = `${Math.round(mult * 100)}%`;
                const mainBoost = document.getElementById("webex-vol-boost");
                const mainBoostVal = document.getElementById("webex-vol-boost-val");
                if (mainBoost) mainBoost.value = mult;
                if (mainBoostVal) mainBoostVal.innerText = `${Math.round(mult * 100)}%`;
            };
        }

        const btnQaSub = qaBar ? qaBar.querySelector("#webex-qa-subtitles") : null;
        if(btnQaSub) btnQaSub.onclick = (e) => { e.stopPropagation(); toggleSubtitlesPanel(); };

        const btnQaCc = qaBar ? qaBar.querySelector("#webex-qa-cc") : null;
        if(btnQaCc) {
            btnQaCc.onclick = (e) => {
                e.stopPropagation();
                isCCOverlayEnabled = !isCCOverlayEnabled;
                localStorage.setItem("webex_cc_enabled", isCCOverlayEnabled ? "true" : "false");
                btnQaCc.classList.toggle("active", isCCOverlayEnabled);
                const btnToggleCC = document.getElementById("webex-subtitles-toggle-cc");
                if (btnToggleCC) btnToggleCC.classList.toggle("active", isCCOverlayEnabled);
                if (!isCCOverlayEnabled && ccOverlayEl) {
                    ccOverlayEl.classList.add("is-hidden");
                } else {
                    const vid = getPrimaryVideo();
                    if (vid) updateSubtitlesHighlight(vid.currentTime, true);
                }
                showHUD(isCCOverlayEnabled ? "Sottotitoli a schermo: Attivi" : "Sottotitoli a schermo: Disattivati", "💬");
            };
        }

        // Toolbar is permanently locked and fixed at the bottom center
        const panelHeader = container.querySelector(".webex-helper-panel-header");
        if (panelHeader) {
            panelHeader.style.cursor = "default";
        }

        // Fullscreen Change: Ensure toolbar stays visible inside native fullscreen container
        document.addEventListener("fullscreenchange", () => {
            const fsEl = document.fullscreenElement;
            const tb = document.getElementById("webex-helper-toolbar-container");
            const qb = document.getElementById("webex-quick-actions-bar");
            if (tb) {
                if (fsEl) {
                    fsEl.appendChild(tb);
                    tb.style.zIndex = "2147483647";
                } else {
                    document.body.appendChild(tb);
                    tb.style.zIndex = "2147483640";
                }
                updateToolbarPosition();
            }
            if (qb) {
                if (fsEl) {
                    fsEl.appendChild(qb);
                    qb.style.zIndex = "2147483647";
                } else {
                    if (tb) {
                        tb.insertBefore(qb, tb.firstChild);
                    } else {
                        document.body.appendChild(qb);
                    }
                    qb.style.zIndex = "2147483647";
                }
                repositionQuickActionsBar();
            }
        });

        // Seeking Buttons in Toolbar
        container.querySelector("#webex-seek-b30").onclick = () => seekVideo(-30);
        container.querySelector("#webex-seek-b10").onclick = () => seekVideo(-10);
        container.querySelector("#webex-seek-f10").onclick = () => seekVideo(+10);
        container.querySelector("#webex-seek-f30").onclick = () => seekVideo(+30);

        // Speed clicks
        container.querySelector("#webex-speed-minus").onclick = () => changeSpeed(-0.1);
        container.querySelector("#webex-speed-plus").onclick = () => changeSpeed(+0.1);

        container.querySelectorAll(".webex-helper-chip").forEach(chip => {
            chip.onclick = () => changeSpeed(0, parseFloat(chip.dataset.speed));
        });

        // Volume Boost Slider
        const boostSlider = container.querySelector("#webex-vol-boost");
        const boostVal = container.querySelector("#webex-vol-boost-val");
        boostSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            boostVal.innerText = `${Math.round(val * 100)}%`;
            setAudioBoost(val);
        };

        // --- Category 1: Visualizzazione Event Clicks ---
        container.querySelector("#webex-action-pip").onclick = togglePiP;

        // Zoom Click & Flyout
        container.querySelector("#webex-action-zoom").onclick = cycleZoom;
        container.querySelectorAll("#webex-zoom-flyout .webex-flyout-chip").forEach(chip => {
            chip.onclick = (e) => {
                e.stopPropagation();
                setZoom(parseFloat(chip.dataset.zoom));
            };
        });
        const zoomSliderEl = container.querySelector("#webex-zoom-slider");
        if (zoomSliderEl) {
            zoomSliderEl.oninput = (e) => {
                setZoom(parseFloat(e.target.value));
            };
        }

        // Filter Click & Flyout
        container.querySelector("#webex-action-filter").onclick = cycleVideoFilter;
        container.querySelectorAll("#webex-filter-flyout .webex-flyout-chip").forEach(chip => {
            chip.onclick = (e) => {
                e.stopPropagation();
                setFilterMode(chip.dataset.filter);
            };
        });
        const filterSliderEl = container.querySelector("#webex-filter-slider");
        if (filterSliderEl) {
            filterSliderEl.oninput = (e) => {
                setFilterIntensity(parseInt(e.target.value, 10));
            };
        }

        // --- Category 2: Appunti Event Clicks ---
        container.querySelector("#webex-action-notes").onclick = showNotesModal;
        container.querySelector("#webex-action-bm").onclick = addBookmark;
        const bmQuickAdd = container.querySelector("#webex-bm-quick-add");
        if (bmQuickAdd) bmQuickAdd.onclick = addBookmark;
        container.querySelector("#webex-action-snap").onclick = captureScreenshot;

        // Slide Mode Flyout Chips
        container.querySelectorAll("#webex-slide-flyout .webex-flyout-chip").forEach(chip => {
            chip.onclick = (e) => {
                e.stopPropagation();
                slideMode = chip.dataset.slideMode || "copy";
                try { localStorage.setItem("webex_slide_mode", slideMode); } catch (_) {}
                updateActionButtonsState();
                const modeNames = {
                    copy: "Solo Appunti 📋",
                    download: "Solo Download 💾",
                    both: "Entrambi (Appunti + Download) ⚡"
                };
                showHUD(`Modalità Slide: ${modeNames[slideMode] || slideMode}`, "📸");
            };
        });

        // --- Category 3: Avanzate Event Clicks ---
        container.querySelector("#webex-action-silence").onclick = toggleSilenceSkip;
        const silenceSpeedSlider = container.querySelector("#webex-silence-speed-slider");
        const silenceSpeedLbl = container.querySelector("#webex-silence-speed-lbl");
        if (silenceSpeedSlider) {
            silenceSpeedSlider.value = silenceSkipSpeed;
            if (silenceSpeedLbl) silenceSpeedLbl.innerText = `Velocità: ${silenceSkipSpeed.toFixed(1)}x`;
            silenceSpeedSlider.oninput = (e) => {
                const val = parseFloat(e.target.value);
                if (silenceSpeedLbl) silenceSpeedLbl.innerText = `Velocità: ${val.toFixed(1)}x`;
                setSilenceSpeed(val);
            };
        }

        const silenceThreshSlider = container.querySelector("#webex-silence-thresh-slider");
        const silenceThreshLbl = container.querySelector("#webex-silence-thresh-lbl");
        if (silenceThreshSlider) {
            silenceThreshSlider.value = silenceThreshold;
            if (silenceThreshLbl) silenceThreshLbl.innerText = `Soglia Volume: ${silenceThreshold}%`;
            silenceThreshSlider.oninput = (e) => {
                const val = parseFloat(e.target.value);
                if (silenceThreshLbl) silenceThreshLbl.innerText = `Soglia Volume: ${val}%`;
                setSilenceThreshold(val);
            };
        }

        const silenceTolSlider = container.querySelector("#webex-silence-tol-slider");
        const silenceTolLbl = container.querySelector("#webex-silence-tol-lbl");
        if (silenceTolSlider) {
            silenceTolSlider.value = silenceToleranceSeconds;
            if (silenceTolLbl) silenceTolLbl.innerText = `Ritardo Inizio: ${silenceToleranceSeconds.toFixed(1)}s`;
            silenceTolSlider.oninput = (e) => {
                const val = parseFloat(e.target.value);
                if (silenceTolLbl) silenceTolLbl.innerText = `Ritardo Inizio: ${val.toFixed(1)}s`;
                setSilenceTolerance(val);
            };
        }

        // Silence Info Button Explainer Toggle
        const silenceInfoBtn = container.querySelector("#webex-silence-info-btn");
        const silenceInfoCard = container.querySelector("#webex-silence-info-card");
        if (silenceInfoBtn && silenceInfoCard) {
            silenceInfoBtn.onclick = (e) => {
                e.stopPropagation();
                const isShown = silenceInfoCard.style.display !== "none";
                silenceInfoCard.style.display = isShown ? "none" : "block";
            };
        }

        // Hover on silence flyout triggers live volume monitoring
        const silenceToolWrapper = container.querySelector("#webex-silence-tool-wrapper");
        if (silenceToolWrapper) {
            silenceToolWrapper.addEventListener("mouseenter", () => {
                ensureSilenceAudio();
                startWebexLiveMeter();
            });
            silenceToolWrapper.addEventListener("mouseleave", () => {
                stopWebexLiveMeter();
            });
        }

        // Loop A-B
        container.querySelector("#webex-action-loop").onclick = () => {
            if (loopA === null) handleLoopA();
            else if (loopB === null) handleLoopB();
            else clearLoopAB();
        };
        const loopSetA = container.querySelector("#webex-loop-set-a");
        const loopSetB = container.querySelector("#webex-loop-set-b");
        const loopReset = container.querySelector("#webex-loop-reset");
        if (loopSetA) loopSetA.onclick = (e) => { e.stopPropagation(); handleLoopA(); };
        if (loopSetB) loopSetB.onclick = (e) => { e.stopPropagation(); handleLoopB(); };
        if (loopReset) loopReset.onclick = (e) => { e.stopPropagation(); clearLoopAB(); };

        // Subtitles (Spotify Style)
        const btnSubtitles = container.querySelector("#webex-action-subtitles");
        if (btnSubtitles) {
            btnSubtitles.onclick = () => toggleSubtitlesPanel();
        }

        // Flyouts Hover Intent & Precise Hitbox Control (No phantom triggers between Silenzi & Loop)
        let activeFlyoutWrapper = null;
        let enterFlyoutTimer = null;
        let leaveFlyoutTimer = null;

        function closeAllFlyouts() {
            clearTimeout(enterFlyoutTimer);
            clearTimeout(leaveFlyoutTimer);
            container.querySelectorAll(".webex-action-flyout").forEach(f => {
                f.classList.remove("is-open");
            });
            activeFlyoutWrapper = null;
        }

        container.querySelectorAll(".webex-tool-with-flyout").forEach(wrapper => {
            const flyout = wrapper.querySelector(".webex-action-flyout");
            if (!flyout) return;

            wrapper.addEventListener("mouseenter", () => {
                clearTimeout(leaveFlyoutTimer);
                if (activeFlyoutWrapper && activeFlyoutWrapper !== wrapper) {
                    closeAllFlyouts();
                }
                enterFlyoutTimer = setTimeout(() => {
                    closeAllFlyouts();
                    flyout.classList.add("is-open");
                    activeFlyoutWrapper = wrapper;
                }, 100);
            });

            wrapper.addEventListener("mouseleave", () => {
                clearTimeout(enterFlyoutTimer);
                leaveFlyoutTimer = setTimeout(() => {
                    flyout.classList.remove("is-open");
                    if (activeFlyoutWrapper === wrapper) activeFlyoutWrapper = null;
                }, 120);
            });

            flyout.addEventListener("click", (e) => {
                e.stopPropagation();
            });
            flyout.addEventListener("mousedown", (e) => {
                e.stopPropagation();
            });
        });

        window.addEventListener("click", (e) => {
            if (!e.target.closest(".webex-tool-with-flyout")) {
                closeAllFlyouts();
            }
        });

        // Buffer Offline Download & Liquid Glass Selectors
        const bufferBtn = container.querySelector("#webex-btn-download-buffer");
        const bufferSelect = container.querySelector("#webex-buffer-select");
        const bufferFolderSelect = container.querySelector("#webex-buffer-folder-select");

        const amountPill = container.querySelector("#webex-buffer-amount-pill");
        const amountMenu = container.querySelector("#webex-buffer-amount-menu");
        const amountLabel = container.querySelector("#webex-buffer-amount-label");

        const folderPill = container.querySelector("#webex-buffer-folder-pill");
        const folderMenu = container.querySelector("#webex-buffer-folder-menu");
        const folderLabel = container.querySelector("#webex-buffer-folder-label");

        function closeGlassMenus() {
            if (amountPill) amountPill.classList.remove("is-active");
            if (amountMenu) amountMenu.classList.remove("is-open");
            if (folderPill) folderPill.classList.remove("is-active");
            if (folderMenu) folderMenu.classList.remove("is-open");
        }

        if (amountPill && amountMenu) {
            amountPill.onclick = (e) => {
                e.stopPropagation();
                const isOpen = amountMenu.classList.contains("is-open");
                closeGlassMenus();
                if (!isOpen) {
                    amountPill.classList.add("is-active");
                    amountMenu.classList.add("is-open");
                }
            };

            amountMenu.querySelectorAll(".webex-buffer-glass-item").forEach(item => {
                item.onclick = (e) => {
                    e.stopPropagation();
                    const val = item.getAttribute("data-val");
                    if (bufferSelect) {
                        bufferSelect.value = val;
                        bufferSelect.dispatchEvent(new Event("change"));
                    }
                    if (amountLabel) amountLabel.textContent = item.textContent;
                    amountMenu.querySelectorAll(".webex-buffer-glass-item").forEach(i => i.classList.remove("is-selected"));
                    item.classList.add("is-selected");
                    closeGlassMenus();
                };
            });
        }

        async function refreshBufferFolders(selectedFolder = "") {
            if (!folderMenu || !bufferFolderSelect) return;
            chrome.runtime.sendMessage({ type: "GET_FOLDERS" }, async (res) => {
                let folders = (res && res.folders && res.folders.length > 0) ? res.folders : [];
                // Fallback to local DB if available
                if (folders.length === 0 && typeof WebexOfflineDB !== "undefined") {
                    try { folders = await WebexOfflineDB.getFolders(); } catch (_) {}
                }

                bufferFolderSelect.innerHTML = '<option value="">📁 Tutte le lezioni</option>';
                folderMenu.innerHTML = '';

                // Default "Tutte le lezioni" item
                const allItem = document.createElement("div");
                allItem.className = `webex-buffer-glass-item ${!selectedFolder ? "is-selected" : ""}`;
                allItem.textContent = "📁 Tutte le lezioni";
                allItem.onclick = (e) => {
                    e.stopPropagation();
                    bufferFolderSelect.value = "";
                    if (folderLabel) folderLabel.textContent = "📁 Tutte le lezioni";
                    folderMenu.querySelectorAll(".webex-buffer-glass-item").forEach(i => i.classList.remove("is-selected"));
                    allItem.classList.add("is-selected");
                    closeGlassMenus();
                };
                folderMenu.appendChild(allItem);

                folders.forEach(f => {
                    if (f && f !== "Generale") {
                        const opt = document.createElement("option");
                        opt.value = f;
                        opt.textContent = `📁 ${f}`;
                        if (f === selectedFolder) opt.selected = true;
                        bufferFolderSelect.appendChild(opt);

                        const depth = (f.match(/\//g) || []).length;
                        const indent = depth > 0 ? "— ".repeat(depth) : "";
                        const displayName = f.split('/').pop();
                        const item = document.createElement("div");
                        item.className = `webex-buffer-glass-item ${f === selectedFolder ? "is-selected" : ""}`;
                        item.textContent = `📁 ${indent}${displayName}`;
                        item.title = `Percorso: ${f}`;
                        item.onclick = (e) => {
                            e.stopPropagation();
                            bufferFolderSelect.value = f;
                            if (folderLabel) folderLabel.textContent = `📁 ${displayName}`;
                            folderMenu.querySelectorAll(".webex-buffer-glass-item").forEach(i => i.classList.remove("is-selected"));
                            item.classList.add("is-selected");
                            closeGlassMenus();
                        };
                        folderMenu.appendChild(item);
                    }
                });

                // "+ Nuova Cartella principale..."
                const newItem = document.createElement("div");
                newItem.className = "webex-buffer-glass-item create-new";
                newItem.textContent = "➕ Nuova Cartella principale...";
                newItem.onclick = async (e) => {
                    e.stopPropagation();
                    closeGlassMenus();
                    const name = await showGlassPrompt("Nuova Cartella Principale", "", "Es. Analisi 1, Fisica...");
                    if (name && name.trim()) {
                        const cleanName = name.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                        if (cleanName && cleanName !== "Generale") {
                            chrome.runtime.sendMessage({ type: "CREATE_FOLDER", folder: cleanName }, () => {
                                refreshBufferFolders(cleanName);
                            });
                            if (typeof WebexOfflineDB !== "undefined") {
                                try { await WebexOfflineDB.createFolder(cleanName); } catch (_) {}
                            }
                            bufferFolderSelect.value = cleanName;
                            if (folderLabel) folderLabel.textContent = `📁 ${cleanName.split('/').pop()}`;
                        }
                    }
                };
                folderMenu.appendChild(newItem);

                // "+ Nuova Sottocartella..."
                const newSubItem = document.createElement("div");
                newSubItem.className = "webex-buffer-glass-item create-new";
                newSubItem.textContent = "➕ Nuova Sottocartella...";
                newSubItem.onclick = async (e) => {
                    e.stopPropagation();
                    closeGlassMenus();
                    const curVal = bufferFolderSelect ? bufferFolderSelect.value : "";
                    const parent = await showGlassPrompt("Cartella Padre", curVal, "Percorso cartella padre...");
                    if (parent !== null) {
                        const sub = await showGlassPrompt("Nome Sottocartella", "", "Es. Esercizi, Teoria...");
                        if (sub && sub.trim()) {
                            const cleanSub = sub.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                            const full = parent && parent.trim() ? `${parent.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/${cleanSub}` : cleanSub;
                            if (full && full !== "Generale") {
                                chrome.runtime.sendMessage({ type: "CREATE_FOLDER", folder: full }, () => {
                                    refreshBufferFolders(full);
                                });
                                if (typeof WebexOfflineDB !== "undefined") {
                                    try { await WebexOfflineDB.createFolder(full); } catch (_) {}
                                }
                                bufferFolderSelect.value = full;
                                if (folderLabel) folderLabel.textContent = `📁 ${cleanSub}`;
                            }
                        }
                    }
                };
                folderMenu.appendChild(newSubItem);

                if (selectedFolder) {
                    if (folderLabel) folderLabel.textContent = `📁 ${selectedFolder.split('/').pop()}`;
                } else {
                    if (folderLabel) folderLabel.textContent = "📁 Tutte le lezioni";
                }
            });
        }

        if (folderPill && folderMenu) {
            refreshBufferFolders();
            folderPill.onclick = (e) => {
                e.stopPropagation();
                const isOpen = folderMenu.classList.contains("is-open");
                closeGlassMenus();
                if (!isOpen) {
                    refreshBufferFolders(bufferFolderSelect ? bufferFolderSelect.value : "");
                    folderPill.classList.add("is-active");
                    folderMenu.classList.add("is-open");
                }
            };
        }

        document.addEventListener("click", closeGlassMenus);

        if (bufferBtn) {
            bufferBtn.onclick = () => {
                const val = bufferSelect ? bufferSelect.value : "1.0";
                let ratio = 1.0;
                if (val === "1.0") ratio = 1.0;
                else if (val === "0.5") ratio = 0.5;
                else {
                    const mins = parseFloat(val);
                    const v = getPrimaryVideo();
                    const totalMins = (v?.duration || 3600) / 60;
                    ratio = Math.min(1.0, mins / totalMins);
                }
                const chosenFolder = bufferFolderSelect ? (bufferFolderSelect.value !== "__new__" ? bufferFolderSelect.value : "") : "";
                startBufferDownload(ratio, chosenFolder);
            };
        }

        // Open Offline Player
        container.querySelector("#webex-btn-open-offline").onclick = () => {
            chrome.runtime.sendMessage({
                type: "OPEN_OFFLINE_PLAYER",
                lectureId: getRecordingId()
            });
        };

        // Save MP4 to Disk
        container.querySelector("#webex-btn-save-mp4").onclick = downloadFullMp4;

        // Initial sync
        updateToolbarPosition();
        checkSavedLectureOnLoad();
        updateActionButtonsState();
        updateBookmarkFlyout();
        renderTimelineMarkers();

        const curVid = getPrimaryVideo();
        if (curVid) {
            updateToolbarSpeed(curVid.playbackRate);
            curVid.addEventListener("loadedmetadata", renderTimelineMarkers);
            curVid.addEventListener("durationchange", renderTimelineMarkers);
        }
    }

    // --- Input & Focus Detection Helper ---
    function isTypingInInput(event) {
        const active = document.activeElement;
        if (active && (
            active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT" ||
            active.isContentEditable ||
            active.getAttribute("role") === "textbox" ||
            active.getAttribute("role") === "searchbox" ||
            active.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"], form, .md-input, .el-input, .login-box, #login, [class*="login"], [class*="signin"]')
        )) {
            return true;
        }

        const path = event.composedPath ? event.composedPath() : [event.target];
        for (const el of path) {
            if (!el || !el.tagName) continue;
            const tag = el.tagName.toUpperCase();
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable || el.getAttribute?.("role") === "textbox" || el.getAttribute?.("role") === "searchbox") {
                return true;
            }
            if (el.classList && (el.classList.contains("md-input") || el.classList.contains("el-input__inner") || el.classList.contains("form-control"))) {
                return true;
            }
        }
        return false;
    }

    // --- Keyboard Event Listener ---
    document.addEventListener("keydown", function (event) {
        // 1. Guard: Never intercept keys on login, sign-in, or auth pages
        const currentUrl = (window.location.href || "").toLowerCase();
        if (currentUrl.includes("/login") || currentUrl.includes("/signin") || currentUrl.includes("/auth") || currentUrl.includes("/saml") || currentUrl.includes("/idp/")) {
            return;
        }

        // 2. Guard: Never intercept keys when typing in an input, textarea, or contenteditable
        if (isTypingInInput(event)) {
            return;
        }

        // 3. Guard: Close open modal overlay on Escape, but block playback shortcuts while modal is open
        const openModal = document.querySelector(".webex-helper-modal-overlay");
        if (openModal) {
            if (event.key === "Escape") {
                openModal.remove();
            }
            return;
        }

        if (subtitlesPanelEl && subtitlesPanelEl.style.display === "flex") {
            if (event.key === "Escape") {
                toggleSubtitlesPanel(false);
                return;
            }
        }

        // 4. Guard: Never intercept keys if no video element is present on the page
        const primaryVid = getPrimaryVideo();
        if (!primaryVid) {
            return;
        }

        const key = event.key;
        const isShift = event.shiftKey;
        const isCtrlOrMeta = event.ctrlKey || event.metaKey;

        if (isCtrlOrMeta) return;

        switch (key) {
            case " ":
            case "k":
            case "K":
                event.preventDefault();
                togglePlayPause();
                break;

            case "ArrowRight":
            case "l":
            case "L":
                event.preventDefault();
                seekVideo(isShift ? 30 : 10);
                break;

            case "ArrowLeft":
            case "j":
            case "J":
                event.preventDefault();
                seekVideo(isShift ? -30 : -10);
                break;

            case "ArrowUp":
                event.preventDefault();
                if (isShift) changeVolume(+0.05);
                else changeSpeed(+0.1);
                break;

            case "ArrowDown":
                event.preventDefault();
                if (isShift) changeVolume(-0.05);
                else changeSpeed(-0.1);
                break;

            case "]":
                event.preventDefault();
                changeSpeed(+0.25);
                break;

            case "[":
                event.preventDefault();
                changeSpeed(-0.25);
                break;

            case "r":
            case "R":
                event.preventDefault();
                resetOrToggleSpeed();
                break;

            case "m":
            case "M":
                event.preventDefault();
                toggleMute();
                break;

            case "f":
            case "F":
                event.preventDefault();
                toggleFullscreen();
                break;

            case "p":
            case "P":
                event.preventDefault();
                togglePiP();
                break;

            case "s":
            case "S":
                event.preventDefault();
                captureScreenshot();
                break;

            case "a":
            case "A":
                event.preventDefault();
                handleLoopA();
                break;

            case "b":
            case "B":
                event.preventDefault();
                handleLoopB();
                break;

            case "z":
            case "Z":
                event.preventDefault();
                cycleZoom();
                break;

            case "i":
            case "I":
                event.preventDefault();
                toggleDarkMode();
                break;

            case "c":
            case "C":
                event.preventDefault();
                cycleVideoFilter();
                break;

            case "n":
            case "N":
                event.preventDefault();
                openNewNoteModal();
                break;

            case "x":
            case "X":
                event.preventDefault();
                toggleSilenceSkip();
                break;

            case "t":
            case "T":
                event.preventDefault();
                toggleSubtitlesPanel();
                break;

            case "Escape":
                if (zoomLevel > 1.0) {
                    resetZoom();
                    showHUD("🔍 Zoom ripristinato", "🔍");
                }
                if (isLooping) {
                    clearLoopAB();
                }
                break;

            case ",":
            case "<":
                event.preventDefault();
                seekVideo(-1);
                break;

            case ".":
            case ">":
                event.preventDefault();
                seekVideo(+1);
                break;

            case "h":
            case "H":
                event.preventDefault();
                const container = document.getElementById("webex-helper-toolbar-container");
                if (container) {
                    isToolbarCollapsed = !isToolbarCollapsed;
                    container.classList.toggle("collapsed", isToolbarCollapsed);
                    repositionQuickActionsBar();
                }
                break;

            case "?":
                event.preventDefault();
                showShortcutsModal();
                break;

            default:
                if (key >= "0" && key <= "9") {
                    const video = getPrimaryVideo();
                    if (video && video.duration > 0) {
                        event.preventDefault();
                        const percent = parseInt(key) * 10;
                        const targetTime = (percent / 100) * video.duration;
                        safeSeek(video, targetTime, true);
                        showHUD(`Salta al ${percent}%`, "⏩");
                    }
                }
                break;
        }
    });

    // --- Message Listener for Chrome Extension Popup ---
    chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
        const video = getPrimaryVideo();
        if (msg.type === "GET_STATUS") {
            sendResponse({
                found: !!video,
                paused: video ? video.paused : true,
                currentTime: video ? video.currentTime : 0,
                duration: video ? video.duration : 0,
                playbackRate: video ? video.playbackRate : 1.0,
                volume: video ? video.volume : 1.0,
                muted: video ? video.muted : false,
                isSilenceSkipActive: isSilenceSkipActive,
                isDarkMode: isDarkMode,
                filterName: filterNames[currentFilterIndex],
                currentFilterIndex: currentFilterIndex,
                isLooping: isLooping,
                loopA: loopA,
                loopB: loopB,
                zoomLevel: zoomLevel,
                recordingId: getRecordingId(),
                title: document.title
            });
        } else if (msg.type === "SET_SPEED") {
            changeSpeed(0, msg.speed);
            sendResponse({ success: true });
        } else if (msg.type === "SEEK") {
            seekVideo(msg.seconds);
            sendResponse({ success: true });
        } else if (msg.type === "TOGGLE_PLAY") {
            togglePlayPause();
            sendResponse({ success: true });
        } else if (msg.type === "SCREENSHOT") {
            captureScreenshot();
            sendResponse({ success: true });
        } else if (msg.type === "PIP") {
            togglePiP();
            sendResponse({ success: true });
        } else if (msg.type === "ADD_BOOKMARK") {
            addBookmark();
            sendResponse({ success: true });
        } else if (msg.type === "START_BUFFER_DOWNLOAD") {
            startBufferDownload(msg.fraction || 1.0);
            sendResponse({ success: true });
        } else if (msg.type === "BUFFER_PROGRESS" && msg.lectureId === getRecordingId()) {
            const statusEl = document.getElementById("webex-buffer-status");
            const progressBar = document.getElementById("webex-buffer-bar");
            const progressFill = document.getElementById("webex-buffer-fill");
            const btn = document.getElementById("webex-btn-download-buffer");

            if (msg.status === "downloading" || msg.status === "starting") {
                isDownloadInProgress = true;
                if (progressBar) progressBar.style.display = "block";
                if (progressFill) progressFill.style.width = `${msg.percent || 0}%`;
                if (statusEl) {
                    if (msg.status === "starting") {
                        statusEl.innerHTML = `<span>Avvio download in background...</span>`;
                    } else {
                        statusEl.innerHTML = `<span>📥 ${msg.percent}% (${msg.recMB}/${msg.totMB} MB) • ${msg.speedMB} MB/s</span>`;
                    }
                }
                if (btn) {
                    btn.innerText = "✕ Annulla";
                    btn.style.background = "#ef4444";
                    btn.style.color = "#ffffff";
                }
            } else if (msg.status === "completed") {
                isDownloadInProgress = false;
                if (progressBar) progressBar.style.display = "block";
                if (progressFill) progressFill.style.width = "100%";
                if (statusEl) {
                    statusEl.innerHTML = `<span style="color: #10b981; font-weight:700;">✅ Buffer pronto per la visione in questa pagina o nel Player Offline! (${msg.sizeMB || ''} MB)</span>`;
                }
                if (btn) {
                    btn.innerText = "✓ Scaricato";
                    btn.style.background = "#10b981";
                    btn.style.color = "#ffffff";
                }
                updateOfflineButtonsReady(true);
                showHUD("Buffer pronto! Puoi vedere la lezione in questa pagina o nel Player Offline.", "✅");

                // Pre-load the blob into bufferedBlob in the background so "Usa Buffer" opens instantly!
                if (!bufferedBlob) {
                    streamLectureBlobFromBackground(
                        getRecordingId(),
                        window.location.href,
                        sanitizeWebexTitle(document.title || "")
                    ).then(async (blob) => {
                        if (blob && blob.size >= 500000) {
                            bufferedBlob = blob;
                            if (window.WebexOfflineDB) {
                                try {
                                    const existingSub = (subtitlesCues && subtitlesCues.length > 0) ? JSON.stringify(subtitlesCues) : localStorage.getItem('webex_subtitles_' + getRecordingId());
                                    await window.WebexOfflineDB.saveLecture({
                                        id: getRecordingId(),
                                        title: sanitizeWebexTitle(document.title || ""),
                                        url: window.location.href,
                                        blob: blob,
                                        size: blob.size,
                                        duration: (getPrimaryVideo()?.duration || 0),
                                        date: new Date().toISOString(),
                                        subtitlesData: existingSub || undefined
                                    });
                                } catch (_) {}
                            }
                        }
                    }).catch((err) => {
                        console.warn("[WebexHelper] Background blob prefetch note:", err);
                    });
                }
            } else if (msg.status === "error") {
                isDownloadInProgress = false;
                if (statusEl) {
                    statusEl.innerHTML = `<span style="color:#ef4444;">Errore download: ${msg.message || "Errore sconosciuto"}</span>`;
                }
                if (btn) {
                    btn.innerText = "📥 Scarica Buffer";
                    btn.style.background = "#38bdf8";
                    btn.style.color = "#0f172a";
                }
                showHUD(`Errore download: ${msg.message || ""}`, "⚠️");
            } else if (msg.status === "cancelled") {
                isDownloadInProgress = false;
                if (progressBar) progressBar.style.display = "none";
                if (progressFill) progressFill.style.width = "0%";
                if (statusEl) {
                    statusEl.innerHTML = `<span>Download annullato</span>`;
                }
                if (btn) {
                    btn.innerText = "📥 Scarica Buffer";
                    btn.style.background = "#38bdf8";
                    btn.style.color = "#0f172a";
                }
            }
            sendResponse({ success: true });
        } else if (msg.type === "DOWNLOAD_MP4") {
            downloadFullMp4();
            sendResponse({ success: true });
        } else if (msg.type === "LECTURE_DELETED") {
            const currentRecId = getRecordingId();
            const currentTitle = sanitizeWebexTitle(document.title || "");
            const isMatch = (msg.lectureId && (msg.lectureId === currentRecId || currentRecId.includes(msg.lectureId) || msg.lectureId.includes(currentRecId))) ||
                            (msg.pageUrl && msg.pageUrl.includes(currentRecId)) ||
                            (msg.title && currentTitle && (msg.title.includes(currentTitle) || currentTitle.includes(msg.title)));

            if (isMatch) {
                bufferedBlob = null;
                if (window.WebexOfflineDB) {
                    try {
                        window.WebexOfflineDB.deleteLecture(currentRecId);
                        if (msg.lectureId) window.WebexOfflineDB.deleteLecture(msg.lectureId);
                    } catch (_) {}
                }
                const statusEl = document.getElementById("webex-buffer-status");
                const progressBar = document.getElementById("webex-buffer-bar");
                const progressFill = document.getElementById("webex-buffer-fill");
                const btn = document.getElementById("webex-btn-download-buffer");

                if (progressBar) progressBar.style.display = "none";
                if (progressFill) progressFill.style.width = "0%";
                if (statusEl) statusEl.innerHTML = `<span>Pronto per il pre-caricamento offline</span>`;
                if (btn) {
                    btn.innerText = "📥 Scarica Buffer";
                    btn.style.background = "#38bdf8";
                    btn.style.color = "#0f172a";
                }
                updateOfflineButtonsReady(false);
                showHUD("Buffer offline rimosso", "🗑️");
            }
            sendResponse({ success: true });
        } else if (msg.type === "TOGGLE_ZOOM") {
            cycleZoom();
            sendResponse({ success: true, zoomLevel });
        } else if (msg.type === "TOGGLE_DARK") {
            toggleDarkMode();
            sendResponse({ success: true, isDarkMode });
        } else if (msg.type === "TOGGLE_FILTER") {
            cycleVideoFilter();
            sendResponse({ success: true, filterIndex: currentFilterIndex, filterName: filterNames[currentFilterIndex] });
        } else if (msg.type === "TOGGLE_SILENCE") {
            toggleSilenceSkip();
            sendResponse({ success: true, isSilenceSkipActive });
        } else if (msg.type === "TOGGLE_LOOP") {
            if (isLooping) {
                clearLoopAB();
            } else if (loopA === null) {
                handleLoopA();
            } else {
                handleLoopB();
            }
            sendResponse({ success: true, isLooping, loopA, loopB });
        } else if (msg.type === "OPEN_NOTES") {
            showNotesModal();
            sendResponse({ success: true });
        }
        return true;
    });

    // --- Dynamic Init & Observers (Protected from Infinite Loops) ---
    let intervalTimer = null;

    function initVideoHooks() {
        const video = getPrimaryVideo();
        if (!video) return;

        try {
            if (lastPreferredSpeed && lastPreferredSpeed !== 1.0) {
                getAllVideos().forEach(v => {
                    try { v.playbackRate = lastPreferredSpeed; } catch (e) {}
                });
                updateToolbarSpeed(lastPreferredSpeed);
            }

            if (!document.getElementById("webex-helper-toolbar-container")) {
                createToolbar();
            }

            if (!document.getElementById("webex-native-btn-minus-30")) {
                injectNativeControlBarControls();
            }

            initZoomMouseListeners();
            checkAutoResume();
            autoDetectWebexSubtitles();

            if (!video.__webex_loop_hooked) {
                video.__webex_loop_hooked = true;
                video.addEventListener("timeupdate", () => {
                    if (isLooping && loopA !== null && loopB !== null && video.currentTime >= loopB) {
                        safeSeek(video, loopA, true);
                    }
                    updateSubtitlesHighlight(video.currentTime);
                });
                video.addEventListener("seeked", () => {
                    if (audioCtx && audioCtx.state === "suspended") {
                        audioCtx.resume().catch(() => {});
                    }
                    updateSubtitlesHighlight(video.currentTime, true);
                });
                video.addEventListener("ratechange", () => {
                    if (typeof updateNativeSpeedDisplay === 'function') updateNativeSpeedDisplay(video.playbackRate);
                    if (typeof updateToolbarSpeed === 'function') updateToolbarSpeed(video.playbackRate);
                });
            }

            if (!intervalTimer) {
                intervalTimer = setInterval(() => {
                    updateETADisplay();
                    saveResumePosition();
                    updateToolbarPosition();
                }, 1000);
            }
        } catch (e) {
            console.warn("[PoliMiEnhancer] Error in initVideoHooks:", e);
        }
    }

    // Purge any old fake segment placeholders from localStorage
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && (k.startsWith("webex_subtitles_") || k.startsWith("offline_subtitles_"))) {
                const val = localStorage.getItem(k);
                if (val && (val.includes("[Segmento") || val.includes("Parlato attivo") || val.includes("Spiegazione") || val.includes("[Inizio]"))) {
                    localStorage.removeItem(k);
                }
            }
        }
    } catch (_) {}

    // Run when DOM is ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => setTimeout(initVideoHooks, 1000));
    } else {
        setTimeout(initVideoHooks, 1000);
    }

    // Debounced observer to adapt to SPA navigation without locking the thread
    let debounceTimer = null;
    const domObserver = new MutationObserver(() => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            if (!document.getElementById("webex-helper-toolbar-container") || !document.getElementById("webex-native-btn-minus-30")) {
                initVideoHooks();
            }
        }, 800);
    });

    if (document.body) {
        domObserver.observe(document.body, { childList: true, subtree: true });
    } else {
        window.addEventListener("DOMContentLoaded", () => {
            if (document.body) domObserver.observe(document.body, { childList: true, subtree: true });
        });
    }

    window.addEventListener("resize", updateToolbarPosition);

    console.log("[PoliMiEnhancer] v2.0 attivo!");
})();


// Auto-sync settings from cloud (chrome.storage.sync)
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get(["webex_groq_api_keys", "webex_student_email"], (res) => {
        if (res.webex_groq_api_keys) localStorage.setItem("webex_groq_api_keys", res.webex_groq_api_keys);
        if (res.webex_student_email) localStorage.setItem("webex_student_email", res.webex_student_email);
    });
}
