/**
 * Controller for Webex Offline Player (Modalità Offline / no Wi-Fi)
 * Exact Webex interface parity:
 * - Centered theater stage video player with glowing timeline markers and in-video silence indicator
 * - Docked Master Liquid Glass toolbar (Visualizzazione, Appunti, Avanzate) directly beneath the video
 * - Inverted droplet (💧) flyouts with invisible hover bridge and 280ms grace timeout
 * - Zoom & Pan with presets (1.5x, 2.0x, 3.0x, Reset) + continuous slider (1.0x-10.0x) + mouse drag
 * - Video Filters: Normale, Contrasto, B&N, 🌙 Notte (Luce Blu), 🔄 Negativo + persistent intensity slider (0-100%)
 * - HD Slide Capture: 3 modes (Solo Appunti 📋, Solo Download 💾, Entrambi ⚡) + animated shutter flash
 * - Draggable zero-blur notes modal with Notion/Obsidian Markdown export
 * - Bookmarks with quick flyout and glowing diamond markers on timeline
 * - Silence skip with speed presets (2.0x, 3.0x, 4.0x, 5.0x) + tolerance slider (0.5s-3.0s)
 * - Loop A-B repeat with step flyout
 * - Volume boost slider (100% to 300%) using Web Audio API GainNode
 * - In-Page Custom File Explorer Modal for course folders, lecture sorting, moving, and deletion
 */

async function initOfflinePlayer() {
    // --- Core Elements ---
    const video = document.getElementById("offline-video");
    const emptyState = document.getElementById("empty-state");
    const lectureDropdown = document.getElementById("lecture-dropdown");
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");
    const etaBadge = document.getElementById("player-eta-badge");
    const playerContainer = document.getElementById("player-container");
    const toolbarContainer = document.getElementById("webex-helper-toolbar-container");

    let currentLectureId = null;
    let currentLectureTitle = "Lezione Offline";
    let lastPreferredSpeed = parseFloat(localStorage.getItem('webex_helper_speed')) || 1.0;
    let hudTimeout = null;
    let isToolbarCollapsed = false;

    // --- Audio Boost Gain State ---
    let audioCtx = null;
    let gainNode = null;
    let audioSourceNode = null;
    let audioBoostMultiplier = 1.0;

    // --- Category 1: Visualizzazione States ---
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

    // --- Category 2: Appunti States ---
    let slideMode = localStorage.getItem('webex_slide_mode') || 'copy';

    // --- Category 3: Avanzate States ---
    let loopA = null;
    let loopB = null;
    let isLooping = false;

    let isSilenceSkipActive = false;
    let silenceSkipSpeed = parseFloat(localStorage.getItem('webex_silence_speed')) || 3.0;
    let silenceToleranceSeconds = parseFloat(localStorage.getItem('webex_silence_tolerance')) || 1.0;
    let silenceThreshold = parseFloat(localStorage.getItem('webex_silence_threshold')) || 2.0;
    let silenceAnalyser = null;
    let silenceDataArray = null;
    let isSilenceFast = false;
    let silenceInterval = null;
    let silenceCounter = 0;

    // --- Explorer Modal States & PC Folder ---
    let explorerCurrentFolder = "all";
    let explorerCurrentSort = "date_desc";
    let explorerSearchQuery = "";
    let pcFolderDirectoryHandle = null;
    let pcFolderFiles = [];
    let activeBlobUrl = null;

    // --- Subtitles & CC States ---
    let offlineSubtitles = [];
    let offlineActiveCueIdx = -1;
    let isOfflineSubtitlesOpen = false;
    let isOfflineCCOverlayEnabled = localStorage.getItem("offline_cc_enabled") !== "false";
    let isOfflineUserInteractingWithSubtitles = false;
    let offlineSubtitleInteractTimeout = null;

    const offlineSubtitlesPanel = document.getElementById("offline-subtitles-panel");
    const offlineSubtitlesHeader = document.getElementById("offline-subtitles-header");
    const offlineSubtitlesBadge = document.getElementById("offline-subtitles-count-badge");
    const offlineSubtitlesToggleCC = document.getElementById("offline-subtitles-toggle-cc");
    const offlineSubtitlesFileInput = document.getElementById("offline-subtitles-file-input");
    const offlineSubtitlesClose = document.getElementById("offline-subtitles-close");
    const offlineSubtitlesSearch = document.getElementById("offline-subtitles-search");
    const offlineSubtitlesList = document.getElementById("offline-subtitles-cues-list");
    const offlineCCOverlay = document.getElementById("offline-video-cc-display");
    const offlineActionSubtitlesBtn = document.getElementById("offline-action-subtitles");

    // ==========================================
    // HELPERS & HUD
    // ==========================================
    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return "00:00";
        const total = Math.floor(seconds);
        const hrs = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        return `${hrs > 0 ? hrs + ':' : ''}${(mins < 10 ? '0' : '') + mins}:${(secs < 10 ? '0' : '') + secs}`;
    }

    function showHUD(text, icon = "⚡") {
        let hud = document.getElementById("webex-offline-hud");
        if (!hud) {
            hud = document.createElement("div");
            hud.id = "webex-offline-hud";
            hud.className = "webex-helper-hud";
            document.body.appendChild(hud);
        }

        hud.innerHTML = `<span class="webex-helper-hud-icon">${icon}</span><span>${text}</span>`;
        hud.classList.add("visible");

        clearTimeout(hudTimeout);
        hudTimeout = setTimeout(() => {
            hud.classList.remove("visible");
        }, 1200);
    }

    function updateETADisplay() {
        const panelEta = document.getElementById("offline-eta-display");
        if (!video || !video.duration || isNaN(video.duration)) {
            if (etaBadge) etaBadge.style.display = "none";
            if (panelEta) panelEta.innerText = "--:--";
            return;
        }

        const remainingSeconds = (video.duration - video.currentTime) / (video.playbackRate || 1.0);
        if (remainingSeconds <= 0) {
            if (etaBadge) etaBadge.style.display = "none";
            if (panelEta) panelEta.innerText = "--:--";
            return;
        }

        const etaDate = new Date(Date.now() + remainingSeconds * 1000);
        const hours = etaDate.getHours().toString().padStart(2, '0');
        const minutes = etaDate.getMinutes().toString().padStart(2, '0');

        if (etaBadge) {
            etaBadge.innerText = `⏱️ Fine ore ${hours}:${minutes}`;
            etaBadge.style.display = "inline-flex";
        }
        if (panelEta) {
            panelEta.innerText = `${hours}:${minutes}`;
        }
    }

    video.addEventListener("timeupdate", () => {
        updateETADisplay();
        updateOfflineTimelineUI(video.currentTime, video.duration);
        updateOfflineSubtitlesHighlight(video.currentTime);
    });
    video.addEventListener("durationchange", () => {
        updateETADisplay();
        updateOfflineTimelineUI(video.currentTime, video.duration);
    });

    // ==========================================
    // AUDIO BOOST (GAIN NODE)
    // ==========================================
    function initAudioContext() {
        if (audioCtx) {
            if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
            return;
        }
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) return;
            audioCtx = new AudioContextClass();
            gainNode = audioCtx.createGain();
            gainNode.gain.value = audioBoostMultiplier || 1.0;
            audioSourceNode = audioCtx.createMediaElementSource(video);
            audioSourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        } catch (e) {
            console.warn("[WebexOffline] AudioContext init warning:", e);
        }
    }

    function setAudioBoost(mult) {
        audioBoostMultiplier = Math.max(1.0, Math.min(3.0, mult));
        if (audioBoostMultiplier > 1.0) {
            initAudioContext();
            if (gainNode && audioCtx) {
                if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
                gainNode.gain.value = audioBoostMultiplier;
            }
        } else if (gainNode) {
            gainNode.gain.value = 1.0;
        }
        const boostVal = document.getElementById("offline-vol-boost-val");
        if (boostVal) boostVal.innerText = `${Math.round(audioBoostMultiplier * 100)}%`;
        if (audioBoostMultiplier > 1.0) {
            showHUD(`Volume Boost: ${Math.round(audioBoostMultiplier * 100)}%`, "🔊");
        }
    }

    const volBoostSlider = document.getElementById("offline-vol-boost");
    if (volBoostSlider) {
        volBoostSlider.oninput = (e) => {
            setAudioBoost(parseFloat(e.target.value));
        };
    }

    // ==========================================
    // SPEED CONTROL & CHIPS
    // ==========================================
    function setPlaybackSpeed(targetSpeed, showNotification = true) {
        if (!targetSpeed || isNaN(targetSpeed)) return;
        const clamped = Math.max(0.25, Math.min(4.0, parseFloat(targetSpeed.toFixed(2))));
        video.playbackRate = clamped;
        lastPreferredSpeed = clamped;
        try { localStorage.setItem('webex_helper_speed', clamped.toString()); } catch (_) {}

        // Update pill speed & QA speed
        const pillSpeed = document.getElementById("webex-pill-speed-label");
        if (pillSpeed) pillSpeed.innerText = `${clamped.toFixed(2).replace(/\.00$/, '')}x`;
        const qaSpeedVal = document.getElementById("offline-qa-speed-val");
        if (qaSpeedVal) qaSpeedVal.innerText = `${clamped.toFixed(2).replace(/\.00$/, '')}x`;

        // Update center speed display between - and +
        const speedValEl = document.getElementById("offline-speed-display");
        if (speedValEl) speedValEl.innerText = `${clamped.toFixed(2).replace(/\.00$/, '')}x`;

        // Update chips
        document.querySelectorAll(".webex-helper-chips-container .webex-helper-chip").forEach(chip => {
            const bSpeed = parseFloat(chip.dataset.speed);
            chip.classList.toggle("active", Math.abs(bSpeed - clamped) < 0.03);
        });

        if (showNotification) {
            showHUD(`Velocità: ${clamped.toFixed(2).replace(/\.00$/, '')}x`, "⚡");
        }
        updateETADisplay();
    }

    function changeSpeedRelative(delta) {
        setPlaybackSpeed(video.playbackRate + delta);
    }

    document.querySelectorAll(".webex-helper-chips-container .webex-helper-chip").forEach(chip => {
        chip.onclick = () => {
            const spd = parseFloat(chip.dataset.speed);
            setPlaybackSpeed(spd);
        };
    });

    const speedMinus = document.getElementById("offline-speed-minus");
    const speedPlus = document.getElementById("offline-speed-plus");
    if (speedMinus) speedMinus.onclick = () => changeSpeedRelative(-0.1);
    if (speedPlus) speedPlus.onclick = () => changeSpeedRelative(+0.1);
    setPlaybackSpeed(lastPreferredSpeed, false);

    // ==========================================
    // SEEKING & PLAY/PAUSE (CHROMIUM RESYNC ENGINE)
    // ==========================================
    let pendingSeekTarget = null;
    let seekDebounceTimer = null;

    function safeSeek(targetTime, resumeIfPlaying = true) {
        if (!video) return;
        const dur = (video.duration && isFinite(video.duration)) ? video.duration : 9999999;
        const clampedTime = Math.max(0, Math.min(dur, targetTime));

        // Reset temporary silence acceleration speed
        if (typeof isSilenceFast !== "undefined" && isSilenceFast) {
            video.playbackRate = (typeof lastPreferredSpeed !== "undefined" && lastPreferredSpeed) ? lastPreferredSpeed : 1.0;
            isSilenceFast = false;
        }

        try {
            video.currentTime = clampedTime;
        } catch (e) {
            console.warn("[WebexOffline] seek error:", e);
        }

        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
        }
        updateOfflineSubtitlesHighlight(clampedTime, true);

        if (resumeIfPlaying && video.paused) {
            video.play().catch(() => {});
        }
    }

    function seekRelative(seconds) {
        if (!video || !video.duration) return;
        const maxDuration = (video.duration && isFinite(video.duration)) ? video.duration : 9999999;
        const baseTime = (pendingSeekTarget !== null) ? pendingSeekTarget : (video.currentTime || 0);
        const newTime = Math.max(0, Math.min(maxDuration, baseTime + seconds));
        pendingSeekTarget = newTime;

        const totalDelta = newTime - (video.currentTime || 0);
        const sign = totalDelta >= 0 ? `+${Math.round(totalDelta)}s` : `${Math.round(totalDelta)}s`;
        showHUD(`${sign} (${formatTime(newTime)})`, totalDelta >= 0 ? "⏩" : "⏪");

        if (seekDebounceTimer) clearTimeout(seekDebounceTimer);

        seekDebounceTimer = setTimeout(() => {
            const finalTarget = pendingSeekTarget;
            pendingSeekTarget = null;
            if (finalTarget === null) return;
            safeSeek(finalTarget, true);
        }, 120);
    }

    function togglePlayPause() {
        if (video.paused) {
            if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
            video.play().catch(() => {});
            showHUD("Play", "▶️");
        } else {
            video.pause();
            showHUD("Pausa", "⏸️");
        }
        updatePlayPauseBtn();
    }

    function updatePlayPauseBtn() {
        const btn = document.getElementById("offline-play-pause-btn");
        if (btn) btn.innerText = video.paused ? "▶" : "⏸";
        const inpageBtn = document.getElementById("offline-btn-play");
        if (inpageBtn) inpageBtn.innerText = video.paused ? "▶ Play" : "⏸ Pausa";
    }

    video.addEventListener("play", () => {
        updatePlayPauseBtn();
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
        showOfflineControls();
    });
    video.addEventListener("playing", () => {
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    });
    video.addEventListener("pause", () => {
        updatePlayPauseBtn();
        showOfflineControls();
    });

    // ==========================================
    // CUSTOM LIQUID GLASS INPAGE CONTROLS BAR (IMMUNE TO CHROME DESYNC)
    // ==========================================
    const offlineInpageControlsBar = document.getElementById("offline-inpage-controls-bar");
    const offlineTimelineTrack = document.getElementById("offline-timeline-track");
    const offlineTimelineFill = document.getElementById("offline-timeline-fill");
    const offlineTimelineHandle = document.getElementById("offline-timeline-handle");
    const offlineTimelineTooltip = document.getElementById("offline-timeline-tooltip");
    const offlineCurrentTime = document.getElementById("offline-current-time");
    const offlineDurationTime = document.getElementById("offline-duration-time");
    const offlineBtnPlay = document.getElementById("offline-btn-play");
    const offlineBtnRwd30 = document.getElementById("offline-btn-rwd30");
    const offlineBtnRwd10 = document.getElementById("offline-btn-rwd10");
    const offlineBtnFwd10 = document.getElementById("offline-btn-fwd10");
    const offlineBtnFwd30 = document.getElementById("offline-btn-fwd30");
    const offlineVolIcon = document.getElementById("offline-vol-icon");
    const offlineVolSlider = document.getElementById("offline-vol-slider");
    const offlineSpeedBadge = document.getElementById("offline-speed-badge");
    const offlineBtnFullscreen = document.getElementById("offline-btn-fullscreen");
    const offlineVideoFrame = document.getElementById("offline-video-frame");

    let isOfflineScrubbing = false;
    let wasPlayingBeforeOfflineScrub = false;
    let offlineScrubRaf = null;

    function updateOfflineTimelineUI(cur, dur) {
        if (isOfflineScrubbing) return;
        if (!dur || dur <= 0 || isNaN(dur)) dur = (video.duration && isFinite(video.duration) && video.duration > 0) ? video.duration : 3600;
        const pct = Math.max(0, Math.min(100, (cur / dur) * 100));
        if (offlineTimelineFill) offlineTimelineFill.style.width = `${pct}%`;
        if (offlineTimelineHandle) offlineTimelineHandle.style.left = `${pct}%`;
        if (offlineCurrentTime) offlineCurrentTime.textContent = formatTime(cur);
        if (offlineDurationTime) offlineDurationTime.textContent = formatTime(dur);
    }

    function getOfflineTrackRatio(clientX) {
        if (!offlineTimelineTrack) return 0;
        const rect = offlineTimelineTrack.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }

    function scrubOfflineTimeline(ratio, commit = false) {
        const dur = (video.duration && isFinite(video.duration) && video.duration > 0) ? video.duration : 3600;
        const targetTime = Math.max(0, Math.min(dur, ratio * dur));
        const pct = Math.max(0, Math.min(100, ratio * 100));
        if (offlineTimelineFill) offlineTimelineFill.style.width = `${pct}%`;
        if (offlineTimelineHandle) offlineTimelineHandle.style.left = `${pct}%`;
        if (offlineCurrentTime) offlineCurrentTime.textContent = formatTime(targetTime);
        if (offlineDurationTime) offlineDurationTime.textContent = formatTime(dur);

        if (commit) {
            safeSeek(targetTime, wasPlayingBeforeOfflineScrub);
            showHUD(`⏱ ${formatTime(targetTime)}`, "⏩");
        }
    }

    if (offlineTimelineTrack) {
        offlineTimelineTrack.addEventListener("pointerdown", (e) => {
            isOfflineScrubbing = true;
            wasPlayingBeforeOfflineScrub = !video.paused;
            try { video.pause(); } catch (_) {}
            offlineTimelineTrack.classList.add("is-scrubbing");

            const ratio = getOfflineTrackRatio(e.clientX);
            scrubOfflineTimeline(ratio, false);

            const onPointerMove = (moveEvt) => {
                if (!isOfflineScrubbing) return;
                const r = getOfflineTrackRatio(moveEvt.clientX);
                if (offlineScrubRaf) cancelAnimationFrame(offlineScrubRaf);
                offlineScrubRaf = requestAnimationFrame(() => {
                    scrubOfflineTimeline(r, false);
                });
            };

            const onPointerUp = (upEvt) => {
                if (isOfflineScrubbing) {
                    isOfflineScrubbing = false;
                    offlineTimelineTrack.classList.remove("is-scrubbing");
                    if (offlineScrubRaf) cancelAnimationFrame(offlineScrubRaf);
                    const r = getOfflineTrackRatio(upEvt.clientX);
                    scrubOfflineTimeline(r, true);
                }
                window.removeEventListener("pointermove", onPointerMove);
                window.removeEventListener("pointerup", onPointerUp);
            };

            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
        });

        offlineTimelineTrack.addEventListener("click", (e) => {
            if (!isOfflineScrubbing) {
                const r = getOfflineTrackRatio(e.clientX);
                scrubOfflineTimeline(r, true);
            }
        });

        offlineTimelineTrack.addEventListener("mousemove", (e) => {
            const rect = offlineTimelineTrack.getBoundingClientRect();
            if (rect.width <= 0 || !offlineTimelineTooltip) return;
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const dur = (video.duration && isFinite(video.duration) && video.duration > 0) ? video.duration : 3600;
            const hoverTime = ratio * dur;
            offlineTimelineTooltip.textContent = formatTime(hoverTime);
            offlineTimelineTooltip.style.left = `${ratio * 100}%`;
            offlineTimelineTooltip.style.opacity = "1";
        });

        offlineTimelineTrack.addEventListener("mouseleave", () => {
            if (!isOfflineScrubbing && offlineTimelineTooltip) offlineTimelineTooltip.style.opacity = "0";
        });
    }

    if (offlineBtnPlay) offlineBtnPlay.onclick = togglePlayPause;
    if (offlineBtnRwd30) offlineBtnRwd30.onclick = () => seekRelative(-30);
    if (offlineBtnRwd10) offlineBtnRwd10.onclick = () => seekRelative(-10);
    if (offlineBtnFwd10) offlineBtnFwd10.onclick = () => seekRelative(10);
    if (offlineBtnFwd30) offlineBtnFwd30.onclick = () => seekRelative(30);

    if (offlineVolSlider) {
        offlineVolSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            video.volume = val;
            video.muted = (val === 0);
            if (offlineVolIcon) offlineVolIcon.textContent = val === 0 ? "🔇" : (val < 0.5 ? "🔉" : "🔊");
        };
    }
    if (offlineVolIcon) {
        offlineVolIcon.onclick = () => {
            video.muted = !video.muted;
            if (offlineVolIcon) offlineVolIcon.textContent = video.muted ? "🔇" : (video.volume < 0.5 ? "🔉" : "🔊");
        };
    }

    const offlineSpeedsCycle = [1.0, 1.25, 1.5, 1.75, 2.0, 0.75];
    if (offlineSpeedBadge) {
        offlineSpeedBadge.onclick = () => {
            const curRate = video.playbackRate || 1.0;
            let next = offlineSpeedsCycle.find(s => s > curRate + 0.05);
            if (!next) next = offlineSpeedsCycle[0];
            setSpeed(next);
        };
    }

    video.addEventListener("ratechange", () => {
        const r = (video.playbackRate || 1.0).toFixed(2).replace(/\.00$/, '');
        if (offlineSpeedBadge) offlineSpeedBadge.textContent = `${r}x`;
    });

    if (offlineBtnFullscreen) offlineBtnFullscreen.onclick = toggleOfflineFullscreen;
    video.addEventListener("click", togglePlayPause);

    // Auto-hide controls bar inside video frame
    let offlineControlsHideTimer = null;
    function showOfflineControls() {
        if (!offlineInpageControlsBar) return;
        offlineInpageControlsBar.classList.remove("is-hidden");
        if (offlineControlsHideTimer) clearTimeout(offlineControlsHideTimer);
        if (!video.paused && !isOfflineScrubbing) {
            offlineControlsHideTimer = setTimeout(() => {
                if (!video.paused && !isOfflineScrubbing && !offlineInpageControlsBar.matches(":hover")) {
                    offlineInpageControlsBar.classList.add("is-hidden");
                }
            }, 3000);
        }
    }

    if (offlineVideoFrame) {
        offlineVideoFrame.addEventListener("mousemove", showOfflineControls);
        offlineVideoFrame.addEventListener("pointerdown", showOfflineControls);
    }

    const playPauseBtn = document.getElementById("offline-play-pause-btn");
    if (playPauseBtn) playPauseBtn.onclick = togglePlayPause;

    const seekB30 = document.getElementById("offline-seek-b30");
    const seekB10 = document.getElementById("offline-seek-b10");
    const seekF10 = document.getElementById("offline-seek-f10");
    const seekF30 = document.getElementById("offline-seek-f30");
    if (seekB30) seekB30.onclick = () => seekRelative(-30);
    if (seekB10) seekB10.onclick = () => seekRelative(-10);
    if (seekF10) seekF10.onclick = () => seekRelative(+10);
    if (seekF30) seekF30.onclick = () => seekRelative(+30);

    // ==========================================
    // TOOLBAR COLLAPSE & DRAGGING
    // ==========================================
    const expandQaBtn = document.getElementById("offline-qa-expand");
    const collapseBtn = document.getElementById("offline-collapse-btn");

    const toggleToolbarCollapse = () => {
        isToolbarCollapsed = !isToolbarCollapsed;
        toolbarContainer.classList.toggle("collapsed", isToolbarCollapsed);
    };

    if (expandQaBtn) expandQaBtn.onclick = toggleToolbarCollapse;
    if (collapseBtn) collapseBtn.onclick = toggleToolbarCollapse;

    // Speed Controls in Quick Actions Bar
    const btnQaMinus = document.getElementById("offline-qa-speed-minus");
    const btnQaPlus = document.getElementById("offline-qa-speed-plus");
    if (btnQaMinus) btnQaMinus.onclick = (e) => { e.stopPropagation(); setPlaybackSpeed(video.playbackRate - 0.1); };
    if (btnQaPlus) btnQaPlus.onclick = (e) => { e.stopPropagation(); setPlaybackSpeed(video.playbackRate + 0.1); };

    // PiP
    const btnQaPip = document.getElementById("offline-qa-pip");
    if (btnQaPip) btnQaPip.onclick = (e) => { e.stopPropagation(); togglePiP(); };

    // Flyout hover grace period to prevent abrupt closing
    const qaBar = document.getElementById("webex-quick-actions-bar");
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

    // Screenshot & Flyout Chips
    const btnQaSnap = document.getElementById("offline-qa-snap");
    if (btnQaSnap) btnQaSnap.onclick = (e) => { e.stopPropagation(); captureScreenshot(); };

    qaBar?.querySelectorAll("#offline-qa-slide-flyout .webex-flyout-chip").forEach(chip => {
        chip.onclick = (e) => {
            e.stopPropagation();
            slideMode = chip.dataset.slideMode || "copy";
            try { localStorage.setItem("offline_slide_mode", slideMode); } catch (_) {}
            qaBar.querySelectorAll("#offline-qa-slide-flyout .webex-flyout-chip").forEach(c => {
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

    // Zoom Button & Flyout
    const btnQaZoom = document.getElementById("offline-qa-zoom");
    if (btnQaZoom) btnQaZoom.onclick = (e) => { e.stopPropagation(); cycleZoom(); };

    const qaZoomVal = document.getElementById("offline-qa-zoom-val");
    const qaZoomSlider = document.getElementById("offline-qa-zoom-slider");

    const updateOfflineQaZoomUI = (lvl) => {
        if (qaZoomVal) qaZoomVal.innerText = `Zoom: ${lvl.toFixed(1)}x`;
        if (qaZoomSlider) qaZoomSlider.value = lvl;
        qaBar?.querySelectorAll("#offline-qa-zoom-flyout .webex-flyout-chip").forEach(c => {
            const z = parseFloat(c.dataset.zoom);
            c.classList.toggle("active", Math.abs(z - lvl) < 0.05);
        });
    };

    qaBar?.querySelectorAll("#offline-qa-zoom-flyout .webex-flyout-chip").forEach(chip => {
        chip.onclick = (e) => {
            e.stopPropagation();
            const z = parseFloat(chip.dataset.zoom);
            setZoom(z);
            updateOfflineQaZoomUI(z);
        };
    });
    if (qaZoomSlider) {
        qaZoomSlider.oninput = (e) => {
            const z = parseFloat(e.target.value);
            setZoom(z);
            updateOfflineQaZoomUI(z);
        };
    }

    // Notes
    const btnQaNotes = document.getElementById("offline-qa-notes");
    if (btnQaNotes) btnQaNotes.onclick = (e) => { e.stopPropagation(); showNotesModal(); };

    // Bookmarks
    const btnQaBm = document.getElementById("offline-qa-bm");
    if (btnQaBm) btnQaBm.onclick = (e) => { e.stopPropagation(); addBookmark(); updateBookmarkFlyout(); };

    const btnQaBmAdd = document.getElementById("offline-qa-bm-add");
    if (btnQaBmAdd) {
        btnQaBmAdd.onclick = (e) => {
            e.stopPropagation();
            addBookmark();
            updateBookmarkFlyout();
        };
    }

    // Audio Boost Slider & Sync
    const qaBoostSlider = document.getElementById("offline-qa-boost-slider");
    const qaBoostVal = document.getElementById("offline-qa-boost-val");
    if (qaBoostSlider) {
        qaBoostSlider.oninput = (e) => {
            const mult = parseFloat(e.target.value);
            setAudioBoost(mult);
            if (qaBoostVal) qaBoostVal.innerText = `${Math.round(mult * 100)}%`;
            const mainBoost = document.getElementById("offline-vol-boost");
            const mainBoostVal = document.getElementById("offline-vol-boost-val");
            if (mainBoost) mainBoost.value = mult;
            if (mainBoostVal) mainBoostVal.innerText = `${Math.round(mult * 100)}%`;
        };
    }

    // Subtitles Panel Toggle
    const btnQaSub = document.getElementById("offline-qa-subtitles");
    if (btnQaSub) {
        btnQaSub.classList.toggle("active", !!isOfflineSubtitlesOpen);
        btnQaSub.onclick = (e) => { e.stopPropagation(); toggleOfflineSubtitlesPanel(); };
    }
    if (offlineActionSubtitlesBtn) {
        offlineActionSubtitlesBtn.classList.toggle("active", !!isOfflineSubtitlesOpen);
    }

    // CC Toggle
    const btnQaCc = document.getElementById("offline-qa-cc");
    if (btnQaCc) {
        btnQaCc.onclick = (e) => {
            e.stopPropagation();
            isOfflineCCOverlayEnabled = !isOfflineCCOverlayEnabled;
            localStorage.setItem("offline_cc_enabled", isOfflineCCOverlayEnabled ? "true" : "false");
            btnQaCc.classList.toggle("active", isOfflineCCOverlayEnabled);
            if (offlineSubtitlesToggleCC) offlineSubtitlesToggleCC.classList.toggle("active", isOfflineCCOverlayEnabled);
            if (!isOfflineCCOverlayEnabled && offlineCCOverlay) {
                offlineCCOverlay.classList.add("is-hidden");
            } else {
                updateOfflineSubtitlesHighlight(video.currentTime, true);
            }
            showHUD(isOfflineCCOverlayEnabled ? "Sottotitoli a schermo: Attivi" : "Sottotitoli a schermo: Disattivati", "💬");
        };
    }

    // Draggable toolbar header
    const panelHeader = toolbarContainer ? toolbarContainer.querySelector(".webex-helper-panel-header") : null;
    let isPanelDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;

    if (panelHeader) {
        panelHeader.style.cursor = "move";
        panelHeader.setAttribute("title", "Trascina per spostare la barra • Doppio click per riagganciare in basso al centro");

        panelHeader.addEventListener("mousedown", (e) => {
            if (e.target.closest("button") || e.target.closest("input") || e.target.closest("select")) return;
            isPanelDragging = true;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = toolbarContainer.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            toolbarContainer.style.bottom = "auto";
            toolbarContainer.style.transform = "none";
            toolbarContainer.style.left = `${initialLeft}px`;
            toolbarContainer.style.top = `${initialTop}px`;
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isPanelDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            const maxL = window.innerWidth - toolbarContainer.offsetWidth - 10;
            const maxT = window.innerHeight - toolbarContainer.offsetHeight - 10;
            const newL = Math.max(10, Math.min(maxL, initialLeft + dx));
            const newT = Math.max(10, Math.min(maxT, initialTop + dy));
            toolbarContainer.style.left = `${newL}px`;
            toolbarContainer.style.top = `${newT}px`;
        });

        window.addEventListener("mouseup", () => {
            isPanelDragging = false;
        });

        panelHeader.addEventListener("dblclick", (e) => {
            if (e.target.closest("button")) return;
            toolbarContainer.style.top = "";
            toolbarContainer.style.bottom = "20px";
            toolbarContainer.style.left = "50%";
            toolbarContainer.style.transform = "translateX(-50%)";
            showHUD("Barra riagganciata in basso", "📍");
        });
    }

    // ==========================================
    // FLYOUT HOVER GRACE & PINNING
    // ==========================================
    document.querySelectorAll(".webex-tool-with-flyout").forEach(wrapper => {
        const flyout = wrapper.querySelector(".webex-action-flyout");
        if (!flyout) return;

        let leaveTimer = null;
        wrapper.addEventListener("mouseenter", () => {
            clearTimeout(leaveTimer);
            flyout.classList.add("is-hover-grace");
        });

        wrapper.addEventListener("mouseleave", () => {
            clearTimeout(leaveTimer);
            leaveTimer = setTimeout(() => {
                flyout.classList.remove("is-hover-grace");
            }, 280);
        });

        flyout.addEventListener("click", (e) => {
            e.stopPropagation();
        });
    });

    // Dismiss flyouts when clicking outside
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".webex-tool-with-flyout")) {
            document.querySelectorAll(".webex-action-flyout").forEach(f => {
                f.classList.remove("is-open", "is-hover-grace");
            });
        }
    });

    // ==========================================
    // CATEGORY 1: VISUALIZZAZIONE
    // ==========================================

    // --- PiP ---
    async function togglePiP() {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
                showHUD("PiP Disattivato", "🪟");
            } else if (document.pictureInPictureEnabled && video.readyState >= 2) {
                await video.requestPictureInPicture();
                showHUD("PiP Attivato", "🪟");
            }
        } catch (e) {
            console.warn("PiP error:", e);
            showHUD("PiP non disponibile", "⚠️");
        }
    }

    const pipBtn = document.getElementById("offline-action-pip");
    if (pipBtn) pipBtn.onclick = togglePiP;

    // --- Zoom & Pan ---
    function applyZoomTransform() {
        if (zoomLevel <= 1.0) {
            panX = 0;
            panY = 0;
            video.style.transform = "";
            video.classList.remove("zoomed");
        } else {
            video.style.transformOrigin = "center center";
            video.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomLevel})`;
            video.classList.add("zoomed");
        }

        const btnZoom = document.getElementById("offline-action-zoom");
        const lblZoom = document.getElementById("offline-action-zoom-lbl");
        const zoomFlyout = document.getElementById("offline-zoom-flyout");
        const zoomSlider = document.getElementById("offline-zoom-slider");
        const zoomSliderVal = document.getElementById("offline-zoom-slider-val");
        const zoomSliderBox = document.getElementById("offline-zoom-slider-box");

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
    }

    function setZoom(level) {
        zoomLevel = Math.max(1.0, Math.min(10.0, Math.round(level * 10) / 10));
        if (zoomLevel <= 1.0) {
            panX = 0;
            panY = 0;
        }
        applyZoomTransform();
        if (zoomLevel > 1.0) {
            showHUD(`Zoom ${zoomLevel.toFixed(1)}x (Trascina video per muoverti)`, "🔍");
        } else {
            showHUD("Zoom Ripristinato (1.0x)", "🔍");
        }
    }

    function cycleZoom() {
        if (zoomLevel === 1.0) setZoom(1.5);
        else if (zoomLevel <= 1.5) setZoom(2.0);
        else if (zoomLevel <= 2.0) setZoom(3.0);
        else setZoom(1.0);
    }

    const zoomBtn = document.getElementById("offline-action-zoom");
    if (zoomBtn) zoomBtn.onclick = cycleZoom;

    document.querySelectorAll("#offline-zoom-flyout .webex-flyout-chip").forEach(chip => {
        chip.onclick = (e) => {
            e.stopPropagation();
            setZoom(parseFloat(chip.dataset.zoom));
        };
    });

    const zoomSliderEl = document.getElementById("offline-zoom-slider");
    if (zoomSliderEl) {
        zoomSliderEl.oninput = (e) => {
            setZoom(parseFloat(e.target.value));
        };
    }

    // Video Pan Dragging
    video.addEventListener("mousedown", (e) => {
        if (zoomLevel > 1.0) {
            e.preventDefault();
            isZoomDragging = true;
            startDragX = e.clientX - panX;
            startDragY = e.clientY - panY;
            applyZoomTransform();
        }
    });

    window.addEventListener("mousemove", (e) => {
        if (isZoomDragging && zoomLevel > 1.0) {
            e.preventDefault();
            panX = e.clientX - startDragX;
            panY = e.clientY - startDragY;
            applyZoomTransform();
        }
    });

    window.addEventListener("mouseup", () => {
        if (isZoomDragging) {
            isZoomDragging = false;
            applyZoomTransform();
        }
    });

    video.addEventListener("dblclick", () => {
        if (zoomLevel > 1.0) setZoom(1.0);
    });

    video.addEventListener("wheel", (e) => {
        if (zoomLevel > 1.0 || e.ctrlKey || e.altKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                setZoom(Math.min(10.0, Math.round((zoomLevel + 0.2) * 10) / 10));
            } else {
                setZoom(Math.max(1.0, Math.round((zoomLevel - 0.2) * 10) / 10));
            }
        }
    }, { passive: false });

    // --- Video Filters ---
    function applyVideoFilter() {
        video.className = video.className.replace(/\bwebex-filter-\S+/g, '').trim();
        const intensity = filterIntensity / 100;
        let filterStr = "none";

        switch (currentFilterId) {
            case "contrast":
                filterStr = `contrast(${1 + 0.6 * intensity}) brightness(${1 + 0.05 * intensity})`;
                break;
            case "bw":
                filterStr = `grayscale(${intensity}) contrast(${1 + 0.4 * intensity})`;
                break;
            case "blue_light":
                filterStr = `sepia(${0.5 * intensity}) saturate(${1 + 0.1 * intensity}) brightness(${1 - 0.08 * intensity})`;
                break;
            case "negative":
                filterStr = `invert(${0.92 * intensity}) hue-rotate(180deg) contrast(${1 + 0.15 * intensity})`;
                break;
            case "normal":
            default:
                filterStr = "none";
                break;
        }

        video.style.filter = filterStr;

        const btnFilter = document.getElementById("offline-action-filter");
        const lblFilter = document.getElementById("offline-action-filter-lbl");
        const filterFlyout = document.getElementById("offline-filter-flyout");
        const filterSlider = document.getElementById("offline-filter-slider");
        const filterSliderVal = document.getElementById("offline-filter-slider-val");
        const filterSliderBox = document.getElementById("offline-filter-slider-box");

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
    }

    function setFilterMode(modeId) {
        currentFilterId = modeId;
        applyVideoFilter();
        const found = filterModes.find(m => m.id === modeId);
        showHUD(`Filtro: ${found ? found.name : modeId}`, "🎨");
    }

    function setFilterIntensity(val) {
        filterIntensity = Math.max(0, Math.min(100, val));
        applyVideoFilter();
    }

    function cycleVideoFilter() {
        const ids = filterModes.map(m => m.id);
        const idx = ids.indexOf(currentFilterId);
        const nextId = ids[(idx + 1) % ids.length];
        setFilterMode(nextId);
    }

    const filterBtn = document.getElementById("offline-action-filter");
    if (filterBtn) filterBtn.onclick = cycleVideoFilter;

    document.querySelectorAll("#offline-filter-flyout .webex-flyout-chip").forEach(chip => {
        chip.onclick = (e) => {
            e.stopPropagation();
            setFilterMode(chip.dataset.filter);
        };
    });

    const filterSliderEl = document.getElementById("offline-filter-slider");
    if (filterSliderEl) {
        filterSliderEl.oninput = (e) => {
            setFilterIntensity(parseInt(e.target.value, 10));
        };
    }

    // ==========================================
    // CATEGORY 2: APPUNTI
    // ==========================================

    // --- Slide HD Capture ---
    async function captureScreenshot() {
        if (!video || !video.videoWidth || !video.videoHeight) {
            showHUD("Nessun fotogramma video disponibile", "⚠️");
            return;
        }

        // Camera shutter flash
        const flash = document.createElement("div");
        flash.className = "webex-shutter-flash";
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 400);

        try {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d");

            if (currentFilterId !== "normal" && filterIntensity > 0) {
                ctx.filter = video.style.filter;
            }
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const timestamp = formatTime(video.currentTime).replace(/:/g, "_");
            const cleanTitle = (currentLectureTitle || "Slide").replace(/[^a-zA-Z0-9_\-]/g, "_").substring(0, 40);
            const fileName = `${cleanTitle}_${timestamp}.png`;

            canvas.toBlob(async (blob) => {
                if (!blob) {
                    showHUD("Errore generazione immagine slide", "⚠️");
                    return;
                }

                const mode = slideMode || "copy";
                let copied = false;
                let downloaded = false;

                if (mode === "copy" || mode === "both") {
                    try {
                        await navigator.clipboard.write([
                            new ClipboardItem({ "image/png": blob })
                        ]);
                        copied = true;
                    } catch (clipErr) {
                        console.warn("[WebexOffline] Clipboard copy failed:", clipErr);
                    }
                }

                if (mode === "download" || mode === "both" || (!copied && mode === "copy")) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = fileName;
                    document.body.appendChild(a);
                    a.click();
                    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
                    downloaded = true;
                }

                if (copied && downloaded) {
                    showHUD(`Slide Copiata (Ctrl+V) & Salvata (${timestamp})`, "⚡");
                } else if (copied) {
                    showHUD(`Slide Copiata negli Appunti (${timestamp})`, "📋");
                } else if (downloaded) {
                    showHUD(`Slide Scaricata: ${fileName}`, "💾");
                }
            }, "image/png");

        } catch (err) {
            console.error("[WebexOffline] Screenshot error:", err);
            showHUD("Errore cattura screenshot", "⚠️");
        }
    }

    const snapBtn = document.getElementById("offline-action-snap");
    if (snapBtn) snapBtn.onclick = captureScreenshot;

    document.querySelectorAll("#offline-slide-flyout .webex-flyout-chip").forEach(chip => {
        chip.onclick = (e) => {
            e.stopPropagation();
            slideMode = chip.dataset.slideMode || "copy";
            try { localStorage.setItem("webex_slide_mode", slideMode); } catch (_) {}
            updateSlideChips();
            const names = {
                copy: "Solo Appunti 📋",
                download: "Solo Download 💾",
                both: "Entrambi (Appunti + Download) ⚡"
            };
            showHUD(`Modalità Slide: ${names[slideMode] || slideMode}`, "📸");
        };
    });

    function updateSlideChips() {
        document.querySelectorAll("#offline-slide-flyout .webex-flyout-chip").forEach(chip => {
            chip.classList.toggle("active", chip.dataset.slideMode === slideMode);
        });
    }
    updateSlideChips();

    // --- Notes (Draggable Zero-Blur Window) ---
    function getNotesKey() {
        return `webex_notes_${currentLectureId || 'offline'}`;
    }

    function getNotes() {
        try {
            return JSON.parse(localStorage.getItem(getNotesKey()) || "[]");
        } catch (_) {
            return [];
        }
    }

    function saveNotes(notes) {
        try {
            localStorage.setItem(getNotesKey(), JSON.stringify(notes));
        } catch (_) {}
        if (currentLectureId && window.WebexOfflineDB && typeof WebexOfflineDB.saveNotes === "function") {
            WebexOfflineDB.saveNotes(currentLectureId, notes).catch(() => {});
        }
    }

    function makeDraggable(modalEl, headerEl) {
        let isDragging = false;
        let startX = 0, startY = 0, initL = 0, initT = 0;
        headerEl.style.cursor = "move";

        headerEl.addEventListener("mousedown", (e) => {
            if (e.target.closest("button") || e.target.closest("input")) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const r = modalEl.getBoundingClientRect();
            initL = r.left;
            initT = r.top;
            modalEl.style.margin = "0";
            modalEl.style.position = "fixed";
            modalEl.style.left = `${initL}px`;
            modalEl.style.top = `${initT}px`;
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            modalEl.style.left = `${Math.max(10, Math.min(window.innerWidth - modalEl.offsetWidth - 10, initL + dx))}px`;
            modalEl.style.top = `${Math.max(10, Math.min(window.innerHeight - modalEl.offsetHeight - 10, initT + dy))}px`;
        });

        window.addEventListener("mouseup", () => { isDragging = false; });
    }

    function showNotesModal(focusQuickAdd = true) {
        let existing = document.getElementById("webex-notes-glass-panel");
        if (existing) {
            if (focusQuickAdd) {
                const inp = existing.querySelector("#webex-notes-quick-input");
                if (inp) { inp.focus(); return; }
            }
            existing.remove();
            return;
        }

        const key = getNotesKey();
        let notes = getNotes();

        const curTime = Math.floor(video.currentTime || 0);
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

        let noteTime = curTime;
        const timeInterval = setInterval(() => {
            if (!document.body.contains(overlay)) {
                clearInterval(timeInterval);
                return;
            }
            if (video && !quickInput.value) {
                noteTime = Math.floor(video.currentTime || 0);
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
                            <span class="webex-notes-card-date">${n.date || 'Offline'}</span>
                            <div class="webex-notes-card-actions">
                                <button class="webex-notes-card-del-btn" data-idx="${originalIdx}" title="Elimina questa nota">🗑️</button>
                            </div>
                        </div>
                        <div class="webex-notes-card-text">${escapeNoteHtml(n.text)}</div>
                    </div>
                `;
            }).join("");

            listContainer.querySelectorAll(".webex-notes-card-item").forEach(card => {
                card.onclick = (e) => {
                    if (e.target.closest(".webex-notes-card-del-btn")) return;
                    const t = parseFloat(card.dataset.time);
                    if (!isNaN(t)) {
                        safeSeek(t, true);
                        showHUD(`Salta al momento della nota (${formatTime(t)})`, "📝");
                        card.classList.remove("just-jumped");
                        void card.offsetWidth;
                        card.classList.add("just-jumped");
                    }
                };
            });

            listContainer.querySelectorAll(".webex-notes-card-del-btn").forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    const i = parseInt(btn.dataset.idx, 10);
                    if (!isNaN(i) && notes[i]) {
                        notes.splice(i, 1);
                        saveNotes(notes);
                        renderNotes(searchInput ? searchInput.value : "");
                        showHUD("Nota eliminata", "🗑️");
                    }
                };
            });
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

            notes.unshift(newNote);
            saveNotes(notes);
            quickInput.value = "";
            renderNotes();
            showHUD(`Nota salvata per ${newNote.formatted}`, "📝");

            if (video) noteTime = Math.floor(video.currentTime || 0);
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

        exportBtn.onclick = () => {
            const title = document.title || "Lezione_Offline";
            let md = `# 📝 Note Lezione: ${title}\n\n`;
            md += `*Data:* ${new Date().toLocaleDateString()}\n\n`;
            md += `## 📌 Punti Salienti e Appunti\n\n`;
            notes.forEach(n => {
                md += `- **[${n.formatted || formatTime(n.time)}]**: ${n.text}\n`;
            });
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
        };

        clearBtn.onclick = () => {
            if (confirm("Vuoi eliminare tutte le note salvate per questa lezione?")) {
                notes = [];
                saveNotes(notes);
                renderNotes();
                showHUD("Tutte le note eliminate", "🗑️");
            }
        };

        renderNotes();
        if (focusQuickAdd) {
            setTimeout(() => quickInput.focus(), 80);
        }
    }

    const notesBtn = document.getElementById("offline-action-notes");
    if (notesBtn) notesBtn.onclick = showNotesModal;

    // --- Bookmarks & Diamond Markers ---
    function getBookmarksKey() {
        return `webex_bm_${currentLectureId || 'offline'}`;
    }

    function getBookmarks() {
        try {
            return JSON.parse(localStorage.getItem(getBookmarksKey()) || "[]");
        } catch (_) {
            return [];
        }
    }

    function saveBookmarks(bms) {
        try {
            localStorage.setItem(getBookmarksKey(), JSON.stringify(bms));
        } catch (_) {}
        if (currentLectureId && window.WebexOfflineDB && typeof WebexOfflineDB.saveBookmarks === "function") {
            WebexOfflineDB.saveBookmarks(currentLectureId, bms).catch(() => {});
        }
    }

    function addBookmark() {
        const time = video.currentTime || 0;
        const bms = getBookmarks();
        if (bms.some(b => Math.abs(b.time - time) < 3)) {
            showHUD("Segnalibro già presente in questo punto", "⚠️");
            return;
        }

        bms.push({
            time: time,
            formatted: formatTime(time),
            title: `Punto chiave ${formatTime(time)}`
        });
        bms.sort((a, b) => a.time - b.time);
        saveBookmarks(bms);
        updateBookmarkFlyout();
        renderTimelineMarkers();
        showHUD(`Segnalibro salvato (${formatTime(time)})`, "📌");
    }

    function updateBookmarkFlyout() {
        const bms = getBookmarks();
        const listEls = [
            document.getElementById("offline-bm-quick-list"),
            document.getElementById("offline-qa-bm-list")
        ];

        listEls.forEach(listEl => {
            if (!listEl) return;
            listEl.innerHTML = "";

            if (bms.length === 0) {
                listEl.innerHTML = `<div style="color:#64748b; font-size:11px; text-align:center; padding:10px 0;">Nessun segnalibro aggiunto.</div>`;
                return;
            }

            bms.forEach((b, idx) => {
                const item = document.createElement("div");
                item.className = "webex-bm-item";
                item.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:4px 6px; border-radius:6px; cursor:pointer;";
                item.innerHTML = `
                    <span style="color:#38bdf8; font-weight:700; font-size:11.5px;">⏱ ${b.formatted}</span>
                    <button class="bm-del-btn" style="background:transparent; border:none; color:#ef4444; cursor:pointer; font-size:11px;">✕</button>
                `;

                item.onclick = (e) => {
                    if (e.target.classList.contains("bm-del-btn")) {
                        e.stopPropagation();
                        const cur = getBookmarks();
                        cur.splice(idx, 1);
                        saveBookmarks(cur);
                        updateBookmarkFlyout();
                        renderTimelineMarkers();
                    } else {
                        safeSeek(b.time, true);
                        showHUD(`Salto a ${b.formatted}`, "📌");
                    }
                };

                listEl.appendChild(item);
            });
        });
    }

    function renderTimelineMarkers() {
        let overlay = document.getElementById("offline-timeline-overlay");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "offline-timeline-overlay";
            overlay.className = "offline-timeline-overlay";
            playerContainer.appendChild(overlay);
        }

        overlay.innerHTML = "";
        const dur = video.duration;
        if (!dur || isNaN(dur)) return;

        const bms = getBookmarks();
        bms.forEach(b => {
            const pct = (b.time / dur) * 100;
            const marker = document.createElement("div");
            marker.className = "webex-timeline-marker";
            marker.style.left = `${pct}%`;
            marker.title = `Segnalibro: ${b.formatted}`;
            marker.onclick = (e) => {
                e.stopPropagation();
                safeSeek(b.time, true);
            };
            overlay.appendChild(marker);
        });
    }

    const bmBtn = document.getElementById("offline-action-bm");
    const bmQuickAdd = document.getElementById("offline-bm-quick-add");
    if (bmBtn) bmBtn.onclick = addBookmark;
    if (bmQuickAdd) bmQuickAdd.onclick = addBookmark;

    // ==========================================
    // CATEGORY 3: AVANZATE
    // ==========================================

    // --- Salto Silenzi ---
    function initSilenceAudio() {
        if (!video) return;
        try {
            initAudioContext();
            if (!audioCtx) return;
            if (audioCtx.state === "suspended") {
                audioCtx.resume().catch(() => {});
            }
            if (!silenceAnalyser && audioSourceNode) {
                silenceAnalyser = audioCtx.createAnalyser();
                silenceAnalyser.fftSize = 512;
                silenceAnalyser.smoothingTimeConstant = 0.2;
                audioSourceNode.connect(silenceAnalyser);
                silenceDataArray = new Uint8Array(silenceAnalyser.frequencyBinCount);
            }
        } catch (e) {
            console.warn("[WebexOffline] Silence analyser error:", e);
        }
    }

    function readOfflineVolumePercent() {
        initSilenceAudio();
        if (!silenceAnalyser || !silenceDataArray) return 0;
        if (!video || video.paused || video.ended) return 0;
        silenceAnalyser.getByteFrequencyData(silenceDataArray);
        let sum = 0;
        for (let i = 0; i < silenceDataArray.length; i++) {
            sum += silenceDataArray[i];
        }
        return (sum / silenceDataArray.length / 255) * 100 * 1.5;
    }

    let offlineLiveMeterInterval = null;
    function startOfflineLiveMeter() {
        if (offlineLiveMeterInterval) return;
        initSilenceAudio();
        if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

        offlineLiveMeterInterval = setInterval(() => {
            const liveVol = document.getElementById("offline-silence-live-vol");
            if (!liveVol) return;
            if (!video || video.paused) {
                liveVol.innerText = "0.0%";
                liveVol.style.color = "#94a3b8";
                return;
            }
            const vol = readOfflineVolumePercent();
            liveVol.innerText = `${vol.toFixed(1)}%`;
            liveVol.style.color = vol < silenceThreshold ? "#38bdf8" : "#4ade80";
        }, 100);
    }

    function stopOfflineLiveMeter() {
        if (!isSilenceSkipActive && offlineLiveMeterInterval) {
            clearInterval(offlineLiveMeterInterval);
            offlineLiveMeterInterval = null;
        }
    }

    function setSilenceTolerance(sec) {
        silenceToleranceSeconds = Math.max(0.1, Math.min(3.0, sec));
        try { localStorage.setItem('webex_silence_tolerance', silenceToleranceSeconds.toString()); } catch (_) {}
    }

    function setSilenceSpeed(spd) {
        silenceSkipSpeed = Math.max(2.0, Math.min(16.0, spd));
        try { localStorage.setItem('webex_silence_speed', silenceSkipSpeed.toString()); } catch (_) {}
    }

    function setSilenceThreshold(val) {
        silenceThreshold = Math.max(0, Math.min(10, val));
        try { localStorage.setItem('webex_silence_threshold', silenceThreshold.toString()); } catch (e) {}
    }

    function toggleSilenceSkip() {
        isSilenceSkipActive = !isSilenceSkipActive;
        const btn = document.getElementById("offline-action-silence");
        const ind = document.getElementById("offline-silence-indicator");
        if (btn) btn.classList.toggle("active", isSilenceSkipActive);

        if (isSilenceSkipActive) {
            initSilenceAudio();
            if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
            startSilenceMonitoring();
            startOfflineLiveMeter();
            showHUD(`Salto Silenzi Attivato (${silenceSkipSpeed}x)`, "🤫");
        } else {
            stopSilenceMonitoring();
            stopOfflineLiveMeter();
            if (ind) ind.classList.remove("active");
            if (isSilenceFast) {
                video.playbackRate = lastPreferredSpeed;
                isSilenceFast = false;
            }
            showHUD("Salto Silenzi Disattivato", "🤫");
        }
    }

    function startSilenceMonitoring() {
        if (silenceInterval) clearInterval(silenceInterval);
        silenceCounter = 0;

        silenceInterval = setInterval(() => {
            if (!isSilenceSkipActive || !silenceAnalyser) return;
            if (audioCtx && audioCtx.state === "suspended") {
                audioCtx.resume().catch(() => {});
            }
            if (video.paused || video.ended) {
                if (isSilenceFast) {
                    video.playbackRate = lastPreferredSpeed;
                    isSilenceFast = false;
                    const ind = document.getElementById("offline-silence-indicator");
                    if (ind) ind.classList.remove("active");
                }
                silenceCounter = 0;
                return;
            }

            const volumePercent = readOfflineVolumePercent();
            const flyout = document.getElementById("offline-silence-flyout");
            if (flyout && (flyout.classList.contains("is-open") || flyout.matches(":hover"))) {
                const liveVol = document.getElementById("offline-silence-live-vol");
                if (liveVol) {
                    liveVol.innerText = `${volumePercent.toFixed(1)}%`;
                    liveVol.style.color = volumePercent < silenceThreshold ? "#38bdf8" : "#4ade80";
                }
            }
            const ind = document.getElementById("offline-silence-indicator");
            const indText = document.getElementById("offline-silence-text");
            const requiredTicks = Math.max(2, Math.round(silenceToleranceSeconds / 0.25));

            if (volumePercent < silenceThreshold) {
                silenceCounter++;
                if (silenceCounter >= requiredTicks && !isSilenceFast) {
                    isSilenceFast = true;
                    video.playbackRate = silenceSkipSpeed;
                    if (ind) ind.classList.add("active");
                    if (indText) indText.innerText = `⏩ Skipping Silenzio (${silenceSkipSpeed}x)`;
                }
            } else {
                silenceCounter = 0;
                if (isSilenceFast) {
                    isSilenceFast = false;
                    video.playbackRate = lastPreferredSpeed;
                    if (ind) ind.classList.remove("active");
                }
            }
        }, 250);
    }

    function stopSilenceMonitoring() {
        if (silenceInterval) {
            clearInterval(silenceInterval);
            silenceInterval = null;
        }
    }

    const silenceBtn = document.getElementById("offline-action-silence");
    if (silenceBtn) silenceBtn.onclick = toggleSilenceSkip;

    // Hover on silence tool wrapper/flyout triggers live audio meter
    const silenceToolWrapper = document.getElementById("offline-silence-tool-wrapper");
    if (silenceToolWrapper) {
        silenceToolWrapper.addEventListener("mouseenter", () => {
            initSilenceAudio();
            startOfflineLiveMeter();
        });
        silenceToolWrapper.addEventListener("mouseleave", () => {
            stopOfflineLiveMeter();
        });
    }

    // Silence Info Button Explainer Toggle
    const silenceInfoBtn = document.getElementById("offline-silence-info-btn");
    const silenceInfoCard = document.getElementById("offline-silence-info-card");
    if (silenceInfoBtn && silenceInfoCard) {
        silenceInfoBtn.onclick = (e) => {
            e.stopPropagation();
            const isShown = silenceInfoCard.style.display !== "none";
            silenceInfoCard.style.display = isShown ? "none" : "block";
        };
    }

    // Silence Sliders
    const silenceSpeedSlider = document.getElementById("offline-silence-speed-slider");
    const silenceSpeedLbl = document.getElementById("offline-silence-speed-lbl");
    if (silenceSpeedSlider) {
        silenceSpeedSlider.value = silenceSkipSpeed;
        if (silenceSpeedLbl) silenceSpeedLbl.innerText = `Velocità: ${silenceSkipSpeed.toFixed(1)}x`;
        silenceSpeedSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (silenceSpeedLbl) silenceSpeedLbl.innerText = `Velocità: ${val.toFixed(1)}x`;
            setSilenceSpeed(val);
        };
    }

    const silenceThreshSlider = document.getElementById("offline-silence-thresh-slider");
    const silenceThreshLbl = document.getElementById("offline-silence-thresh-lbl");
    if (silenceThreshSlider) {
        silenceThreshSlider.value = silenceThreshold;
        if (silenceThreshLbl) silenceThreshLbl.innerText = `Soglia: ${silenceThreshold.toFixed(1)}%`;
        silenceThreshSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (silenceThreshLbl) silenceThreshLbl.innerText = `Soglia: ${val.toFixed(1)}%`;
            setSilenceThreshold(val);
        };
    }

    const silenceTolSlider = document.getElementById("offline-silence-tol-slider");
    const silenceTolLbl = document.getElementById("offline-silence-tol-lbl");
    if (silenceTolSlider) {
        silenceTolSlider.value = silenceToleranceSeconds;
        if (silenceTolLbl) silenceTolLbl.innerText = `Ritardo Inizio: ${silenceToleranceSeconds.toFixed(1)}s`;
        silenceTolSlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (silenceTolLbl) silenceTolLbl.innerText = `Ritardo Inizio: ${val.toFixed(1)}s`;
            setSilenceTolerance(val);
        };
    }

    // --- Loop A-B ---
    function handleLoopA() {
        loopA = video.currentTime;
        updateLoopStatus();
        showHUD(`Punto A fissato: ${formatTime(loopA)}`, "📍");
    }

    function handleLoopB() {
        if (loopA === null) {
            handleLoopA();
            return;
        }
        if (video.currentTime <= loopA) {
            showHUD("Il punto B deve essere successivo al punto A", "⚠️");
            return;
        }
        loopB = video.currentTime;
        isLooping = true;
        updateLoopStatus();
        showHUD(`Loop Attivo: ${formatTime(loopA)} ↔ ${formatTime(loopB)}`, "🔁");
    }

    function clearLoopAB() {
        loopA = null;
        loopB = null;
        isLooping = false;
        updateLoopStatus();
        showHUD("Loop A-B Annullato", "🔁");
    }

    function updateLoopStatus() {
        const btnLoop = document.getElementById("offline-action-loop");
        const lblLoop = document.getElementById("offline-action-loop-lbl");
        const titleLoop = document.getElementById("offline-loop-status-title");

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

        if (titleLoop) {
            if (isLooping) {
                titleLoop.innerText = `Loop Attivo: ${formatTime(loopA)} ↔ ${formatTime(loopB)}`;
            } else if (loopA !== null) {
                titleLoop.innerText = `Punto A: ${formatTime(loopA)} (Imposta B)`;
            } else {
                titleLoop.innerText = "Loop Ripetizione A-B";
            }
        }
    }

    video.addEventListener("timeupdate", () => {
        if (isLooping && loopA !== null && loopB !== null) {
            if (video.currentTime >= loopB || video.currentTime < loopA) {
                video.currentTime = loopA;
            }
        }
    });

    const loopBtn = document.getElementById("offline-action-loop");
    if (loopBtn) {
        loopBtn.onclick = () => {
            if (loopA === null) handleLoopA();
            else if (loopB === null) handleLoopB();
            else clearLoopAB();
        };
    }

    const loopSetA = document.getElementById("offline-loop-set-a");
    const loopSetB = document.getElementById("offline-loop-set-b");
    const loopReset = document.getElementById("offline-loop-reset");
    if (loopSetA) loopSetA.onclick = (e) => { e.stopPropagation(); handleLoopA(); };
    if (loopSetB) loopSetB.onclick = (e) => { e.stopPropagation(); handleLoopB(); };
    if (loopReset) loopReset.onclick = (e) => { e.stopPropagation(); clearLoopAB(); };

    // ==========================================
    // SPOTIFY-STYLE INTERACTIVE SUBTITLES & LIVE TRANSCRIPT
    // ==========================================

    function sanitizeWebexTitle(rawTitle) {
        if (!rawTitle || typeof rawTitle !== "string") return "";
        let t = rawTitle.trim();
        t = t.replace(/^(?:cisco\s*)?webex(?:\s*(?:enterprise|recordings?|player|meeting|lezione))?\s*[-–—|:]\s*/i, "");
        t = t.replace(/\s*[-–—|:]\s*(?:cisco\s*)?webex(?:\s*(?:enterprise|recordings?|player|meeting))?$/i, "");
        t = t.replace(/\.mp4$|\.webm$|\.mkv$/i, "");
        t = t.trim();
        return t || rawTitle.trim();
    }

    function parseOfflineSubtitleText(rawText) {
        if (!rawText || typeof rawText !== "string") return [];
        const text = rawText.trim();
        if (!text) return [];

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
                if (match) i++;
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

    function renderOfflineSubtitlesList(filteredCues = null) {
        if (!offlineSubtitlesList) return;
        const cuesToRender = filteredCues || offlineSubtitles;

        if (offlineSubtitles.length === 0) {
            renderOfflineSubtitlesEmptyState();
            return;
        }

        if (cuesToRender.length === 0) {
            offlineSubtitlesList.innerHTML = `
                <div class="webex-subtitles-empty">
                    <b>Nessuna frase trovata</b><br>
                    Nessun risultato per la ricerca inserita.
                </div>
            `;
            return;
        }

        offlineSubtitlesList.innerHTML = "";
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
                        safeSeek(w.start, true);
                        showHUD(`"${w.text}" (${formatTime(w.start)})`, "💬");
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
                safeSeek(cue.start, true);
                showHUD(`Salta a ${formatTime(cue.start)}`, "💬");
            };

            offlineSubtitlesList.appendChild(row);
        });

        updateOfflineSubtitlesHighlight(video.currentTime, true);
    }

    function updateOfflineSubtitlesHighlight(currentTime, forceScroll = false) {
        if (!offlineSubtitles || offlineSubtitles.length === 0) return;

        const newIdx = offlineSubtitles.findIndex(c => currentTime >= c.start && currentTime <= c.end);

        if (offlineCCOverlay) {
            if (isOfflineCCOverlayEnabled && newIdx !== -1) {
                offlineCCOverlay.innerText = offlineSubtitles[newIdx].text;
                offlineCCOverlay.classList.remove("is-hidden");
            } else {
                offlineCCOverlay.classList.add("is-hidden");
            }
        }

        if (!offlineSubtitlesList) return;

        const cueChanged = (newIdx !== offlineActiveCueIdx) || forceScroll;
        if (cueChanged) {
            offlineActiveCueIdx = newIdx;

            // Re-evaluate ALL rows to ensure past sentences are white and future are gray
            const allRows = offlineSubtitlesList.querySelectorAll(".webex-transcript-cue");
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
                const activeCue = offlineSubtitles[newIdx];
                const activeRow = offlineSubtitlesList.querySelector(`.webex-transcript-cue[data-start="${activeCue.start}"]`);
                if (activeRow) {
                    activeRow.classList.add("is-active");
                    if (!isOfflineUserInteractingWithSubtitles || forceScroll) {
                        activeRow.scrollIntoView({ behavior: "smooth", block: "center" });
                    }
                }
            }
        }

        // Spotify Word-Level Dynamic Highlight (Word-by-word active glow)
        if (newIdx !== -1) {
            const activeRow = offlineSubtitlesList.querySelector(".webex-transcript-cue.is-active");
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

    function loadOfflineSubtitles(cues, sourceName = "") {
        if (typeof cues === "string") {
            try { cues = JSON.parse(cues); } catch (_) {}
        }
        if (!Array.isArray(cues) || cues.length === 0) return;
        offlineSubtitles = cues.sort((a, b) => a.start - b.start);
        offlineActiveCueIdx = -1;

        if (offlineSubtitlesBadge) offlineSubtitlesBadge.innerText = `${offlineSubtitles.length} frasi`;
        const delBtn = document.getElementById("offline-subtitles-btn-delete");
        if (delBtn) delBtn.style.display = "inline-flex";

        const searchBox = document.querySelector("#offline-subtitles-panel .webex-subtitles-search-box");
        if (searchBox) searchBox.style.display = "block";
        const toolbarBox = document.getElementById("offline-subtitles-toolbar");
        if (toolbarBox) toolbarBox.style.display = "none";

        if (currentLectureId) {
            try { localStorage.removeItem(`webex_subtitles_user_deleted_${currentLectureId}`); } catch (_) {}
        }

        renderOfflineSubtitlesList();
        showHUD(`Trascrizione caricata: ${sourceName || offlineSubtitles.length + ' frasi'}`, "💬");

        if (offlineActionSubtitlesBtn) offlineActionSubtitlesBtn.classList.toggle("active", !!isOfflineSubtitlesOpen);
        const btnQaSub = document.getElementById("offline-qa-subtitles");
        if (btnQaSub) btnQaSub.classList.toggle("active", !!isOfflineSubtitlesOpen);
    }

    async function deleteOfflineSubtitlesTrack() {
        offlineSubtitles = [];
        offlineActiveCueIdx = -1;
        const targetId = currentLectureId;
        const targetTitle = currentLectureTitle;

        const rawTitle = sanitizeWebexTitle(targetTitle || "");
        const cleanTitle = rawTitle.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const normTitle = rawTitle.toLowerCase().replace(/\b(polimi|webex|lezione|videolezione|recording|enhancer)\b/gi, '').replace(/[-_~|:/\\]/g, ' ').replace(/\.mp4$|\.webm$|\.mkv$/i, '').replace(/\s+/g, ' ').trim().replace(/[^a-z0-9]/g, '_');

        if (targetId) {
            try {
                localStorage.removeItem(`webex_subtitles_${targetId}`);
                sessionStorage.removeItem(`webex_subtitles_${targetId}`);
                localStorage.setItem(`webex_subtitles_user_deleted_${targetId}`, "true");
            } catch (_) {}
        }
        if (cleanTitle) {
            try {
                localStorage.removeItem(`webex_subtitles_title_${cleanTitle}`);
                localStorage.setItem(`webex_subtitles_user_deleted_${cleanTitle}`, "true");
            } catch (_) {}
        }
        if (normTitle) {
            try {
                localStorage.removeItem(`webex_subtitles_norm_${normTitle}`);
                localStorage.setItem(`webex_subtitles_user_deleted_${normTitle}`, "true");
            } catch (_) {}
        }

        try {
            if (chrome.storage && chrome.storage.local) {
                const keysToRemove = [];
                if (targetId) keysToRemove.push(`webex_subtitles_${targetId}`);
                if (cleanTitle) keysToRemove.push(`webex_subtitles_title_${cleanTitle}`);
                if (normTitle) keysToRemove.push(`webex_subtitles_norm_${normTitle}`);
                chrome.storage.local.remove(keysToRemove);
            }
        } catch (_) {}

        if (window.WebexOfflineDB) {
            try {
                if (targetId) await window.WebexOfflineDB.deleteSubtitles(targetId);
                let lec = targetId ? await window.WebexOfflineDB.getLecture(targetId) : null;
                if (!lec && (targetId || targetTitle)) {
                    lec = await window.WebexOfflineDB.findLecture({ recordingId: targetId, pageTitle: targetTitle });
                }
                if (lec && lec.id) {
                    await window.WebexOfflineDB.deleteSubtitles(lec.id);
                }
            } catch (err) {
                console.warn("[WebexOffline] deleteOfflineSubtitlesTrack DB error:", err);
            }
        }

        if (offlineSubtitlesBadge) offlineSubtitlesBadge.innerText = "0 frasi";
        const delBtn = document.getElementById("offline-subtitles-btn-delete");
        if (delBtn) delBtn.style.display = "none";

        const searchBox = document.querySelector("#offline-subtitles-panel .webex-subtitles-search-box");
        if (searchBox) searchBox.style.display = "none";

        const toolbarBox = document.getElementById("offline-subtitles-toolbar");
        if (toolbarBox) toolbarBox.style.display = "none";

        if (offlineCCOverlay) {
            offlineCCOverlay.innerText = "";
            offlineCCOverlay.classList.add("is-hidden");
        }
        if (offlineActionSubtitlesBtn) offlineActionSubtitlesBtn.classList.remove("active");
        const btnQaSub = document.getElementById("offline-qa-subtitles");
        if (btnQaSub) btnQaSub.classList.remove("active");
        renderOfflineSubtitlesEmptyState();
        showHUD("Traccia sottotitoli eliminata definitivamente", "🗑️");
    }

    function renderOfflineSubtitlesEmptyState() {
        if (!offlineSubtitlesList) return;
        offlineSubtitlesList.innerHTML = `
            <div class="webex-subtitles-empty" id="offline-subtitles-empty-msg">
                <div style="font-size: 32px; margin-bottom: 10px;">🎙️</div>
                <b style="font-size: 14px; color: #f1f5f9;">Nessuna trascrizione caricata</b>
                <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 16px 0; line-height: 1.5; max-width: 440px; margin-left: auto; margin-right: auto;">
                    Scegli una delle opzioni:
                </p>
                <div style="display: flex; flex-direction: column; gap: 8px; max-width: 250px; margin: 0 auto; margin-bottom: 15px;">
                    <div style="display: flex; gap: 2px;">
                        <button class="webex-subtitles-action-btn" id="offline-empty-btn-ai" style="flex: 1; justify-content: center; padding: 10px; border-top-right-radius: 4px; border-bottom-right-radius: 4px; background: linear-gradient(135deg, rgba(2, 132, 199, 0.4), rgba(56, 189, 248, 0.25)); border-color: #38bdf8; color: #ffffff; font-weight: 700;">⚡ Scarica e trascrivi con AI</button>
                        <button class="webex-subtitles-action-btn" id="offline-empty-btn-ai-settings" title="Configurazione AI (API Key e Limiti)" style="background: rgba(56, 189, 248, 0.2); border-color: #38bdf8; color: #38bdf8; border-top-left-radius: 4px; border-bottom-left-radius: 4px; padding: 10px 12px;">⚙️</button>
                    </div>
                    <button class="webex-subtitles-action-btn" id="offline-empty-btn-paste" style="width: 100%; justify-content: center; padding: 10px;">📋 Incolla testo</button>
                    <label class="webex-subtitles-action-btn" style="width: 100%; justify-content: center; padding: 10px; cursor: pointer;">
                        📁 Carica file
                        <input type="file" accept=".vtt,.srt,.sbv,.txt,.json" id="offline-empty-btn-file" style="display: none;">
                    </label>
                </div>
            </div>
        `;

        setTimeout(() => {
            const btnAi = document.getElementById("offline-empty-btn-ai");
            if (btnAi) btnAi.onclick = () => startOfflineAITranscription();
            const btnAiSettings = document.getElementById("offline-empty-btn-ai-settings");
            if (btnAiSettings) btnAiSettings.onclick = async () => {
                if (typeof AITranscriber !== "undefined" && AITranscriber.promptForGroqApiKey) {
                    await AITranscriber.promptForGroqApiKey();
                }
            };
            const btnPaste = document.getElementById("offline-empty-btn-paste");
            if (btnPaste) btnPaste.onclick = () => showOfflinePasteTranscriptModal();
            const btnFile = document.getElementById("offline-empty-btn-file");
            if (btnFile) {
                btnFile.onchange = (e) => {
                    const file = e.target.files && e.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = (evt) => {
                            const parsed = parseOfflineSubtitleText(evt.target.result);
                            if (parsed.length > 0) {
                                loadOfflineSubtitles(parsed, file.name);
                                if (currentLectureId) {
                                    try { localStorage.setItem(`webex_subtitles_${currentLectureId}`, JSON.stringify(parsed)); } catch (_) {}
                                }
                            } else {
                                showHUD("Formato non riconosciuto", "⚠️");
                            }
                        };
                        reader.readAsText(file);
                    }
                };
            }
        }, 50);

        const delBtn = document.getElementById("offline-subtitles-btn-delete");
        if (delBtn) delBtn.style.display = "none";
        const searchBox = document.querySelector("#offline-subtitles-panel .webex-subtitles-search-box");
        if (searchBox) searchBox.style.display = "none";
        const toolbarBox = document.getElementById("offline-subtitles-toolbar");
        if (toolbarBox) toolbarBox.style.display = "none";
    }

    function toggleOfflineSubtitlesPanel(forcedState = null) {
        if (!offlineSubtitlesPanel) return;
        isOfflineSubtitlesOpen = forcedState !== null ? forcedState : (offlineSubtitlesPanel.style.display === "none");
        offlineSubtitlesPanel.style.display = isOfflineSubtitlesOpen ? "flex" : "none";

        if (offlineActionSubtitlesBtn) offlineActionSubtitlesBtn.classList.toggle("active", isOfflineSubtitlesOpen);
        const btnQaSub = document.getElementById("offline-qa-subtitles");
        if (btnQaSub) btnQaSub.classList.toggle("active", isOfflineSubtitlesOpen);

        if (isOfflineSubtitlesOpen) {
            updateOfflineSubtitlesHighlight(video.currentTime, true);
        }
    }

    async function autoLoadOfflineSubtitles(lectureId, title) {
        offlineSubtitles = [];
        offlineActiveCueIdx = -1;
        if (offlineSubtitlesBadge) offlineSubtitlesBadge.innerText = "0 frasi";
        if (offlineActionSubtitlesBtn) offlineActionSubtitlesBtn.classList.toggle("active", !!isOfflineSubtitlesOpen);
        const btnQaSub = document.getElementById("offline-qa-subtitles");
        if (btnQaSub) btnQaSub.classList.toggle("active", !!isOfflineSubtitlesOpen);
        renderOfflineSubtitlesList();

        const sanitized = sanitizeWebexTitle(title || "");
        const cleanTitle = sanitized.toLowerCase().replace(/[^a-z0-9]/g, '_');
        const normTitle = sanitized.toLowerCase().replace(/\b(polimi|webex|lezione|videolezione|recording|enhancer)\b/gi, '').replace(/[-_~|:/\\]/g, ' ').replace(/\.mp4$|\.webm$|\.mkv$/i, '').replace(/\s+/g, ' ').trim().replace(/[^a-z0-9]/g, '_');

        if ((lectureId && localStorage.getItem(`webex_subtitles_user_deleted_${lectureId}`) === "true") ||
            (cleanTitle && localStorage.getItem(`webex_subtitles_user_deleted_${cleanTitle}`) === "true") ||
            (normTitle && localStorage.getItem(`webex_subtitles_user_deleted_${normTitle}`) === "true")) {
            console.log("[WebexOffline] Subtitles explicitly deleted by user, showing empty state.");
            renderOfflineSubtitlesEmptyState();
            return;
        }

        // 1. Direct WebexOfflineDB lookup (matches exact ID, webexRecordingId, and fuzzy title!)
        if (window.WebexOfflineDB && (lectureId || title)) {
            try {
                let lec = lectureId ? await window.WebexOfflineDB.getLecture(lectureId) : null;
                if (!lec) {
                    lec = await window.WebexOfflineDB.findLecture({ recordingId: lectureId, pageTitle: sanitized || title });
                }
                if (lec && (lec.subtitlesData || lec.transcript || lec.subtitles)) {
                    const rawData = lec.subtitlesData || lec.transcript || lec.subtitles;
                    const parsed = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        loadOfflineSubtitles(parsed, lec.title || "Database Locale");
                        return;
                    }
                }
            } catch (err) {
                console.warn("[WebexOffline] DB subtitle note:", err);
            }
        }

        // 2. Try chrome.storage.local by multiple matching keys (ID, normalized title, clean title)
        if (chrome.storage && chrome.storage.local) {
            try {
                const keysToTry = [];
                if (lectureId) keysToTry.push(`webex_subtitles_${lectureId}`);
                if (normTitle) keysToTry.push(`webex_subtitles_norm_${normTitle}`);
                if (cleanTitle) keysToTry.push(`webex_subtitles_title_${cleanTitle}`);
                const storageRes = await new Promise(r => chrome.storage.local.get(keysToTry, r));
                for (const k of keysToTry) {
                    const val = storageRes[k];
                    if (val) {
                        const parsed = typeof val === "string" ? JSON.parse(val) : val;
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            loadOfflineSubtitles(parsed, "Sincronizzazione Webex");
                            return;
                        }
                    }
                }
            } catch (_) {}
        }

        // 3. Try localStorage by lectureId
        try {
            const cached = lectureId ? localStorage.getItem(`webex_subtitles_${lectureId}`) : null;
            if (cached) {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    loadOfflineSubtitles(parsed, "Memoria Locale");
                    return;
                }
            }
        } catch (_) {}

        // 4. Check PC Folder if connected
        if (pcFolderDirectoryHandle && title) {
            try {
                const baseName = title.replace(/\.[^/.]+$/, "").trim().toLowerCase();
                for await (const entry of pcFolderDirectoryHandle.values()) {
                    if (entry.kind === "file") {
                        const eName = entry.name.toLowerCase();
                        if ((eName.endsWith(".vtt") || eName.endsWith(".srt")) && (eName.includes(baseName) || baseName.includes(eName.replace(/\.[^/.]+$/, "")))) {
                            const f = await entry.getFile();
                            const txt = await f.text();
                            const parsed = parseOfflineSubtitleText(txt);
                            if (parsed.length > 0) {
                                loadOfflineSubtitles(parsed, entry.name);
                                try {
                                    if (lectureId) localStorage.setItem(`webex_subtitles_${lectureId}`, JSON.stringify(parsed));
                                    if (chrome.storage && chrome.storage.local && lectureId) {
                                        chrome.storage.local.set({ [`webex_subtitles_${lectureId}`]: JSON.stringify(parsed) });
                                    }
                                } catch (_) {}
                                return;
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("[WebexOffline] Auto subtitle search error in PC folder:", e);
            }
        }

        renderOfflineSubtitlesEmptyState();
    }

    // Panel dragging
    if (offlineSubtitlesHeader && offlineSubtitlesPanel) {
        let isDragging = false;
        let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

        offlineSubtitlesHeader.addEventListener("mousedown", (e) => {
            if (e.target.closest("button") || e.target.closest("label") || e.target.closest("input")) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = offlineSubtitlesPanel.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            offlineSubtitlesPanel.style.left = `${Math.max(10, initialLeft + dx)}px`;
            offlineSubtitlesPanel.style.top = `${Math.max(10, initialTop + dy)}px`;
            offlineSubtitlesPanel.style.right = "auto";
        });

        window.addEventListener("mouseup", () => {
            isDragging = false;
        });
    }

    // Actions & Inputs
    function showOfflinePasteTranscriptModal() {
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
            const parsed = parseOfflineSubtitleText(text);
            if (parsed.length > 0) {
                loadOfflineSubtitles(parsed, "Testo Incollato");
                if (currentLectureId) {
                    try { localStorage.setItem(`webex_subtitles_${currentLectureId}`, JSON.stringify(parsed)); } catch (_) {}
                }
                overlay.remove();
            } else {
                showHUD("Nessun minutaggio o testo valido rilevato", "⚠️");
            }
        };
    }

    // =========================================================================
    // Offline AI Audio Speech-to-Text Runner (Zero Microphone)
    // =========================================================================
    let isOfflineAITranscribing = false;

    async function startOfflineAITranscription() {
        if (isOfflineAITranscribing) {
            showHUD("Trascrizione AI già in corso...", "⏳");
            return;
        }

        if (!video || !video.src) {
            showHUD("Nessun video caricato nel player", "⚠️");
            return;
        }

        const lectureId = currentLectureId || "offline_lecture";
        const lectureTitle = currentLectureTitle || document.title;

        isOfflineAITranscribing = true;
        toggleOfflineSubtitlesPanel(true);

        if (offlineSubtitlesList) {
            offlineSubtitlesList.innerHTML = `
                <div class="webex-subtitles-ai-progress" style="padding: 28px 20px; text-align: center;">
                    <div style="font-size: 34px; margin-bottom: 12px; filter: drop-shadow(0 0 10px #38bdf8);">⚡</div>
                    <b style="color: #38bdf8; font-size: 15px;" id="offline-ai-title">Avvio Trascrizione Vocale AI...</b>
                    <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 16px 0; line-height: 1.4;" id="offline-ai-detail">Estrazione digitale della traccia audio dal file (zero microfono)...</p>
                    <div style="width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin-bottom: 10px;">
                        <div id="offline-ai-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #0284c7, #38bdf8); transition: width 0.3s ease;"></div>
                    </div>
                    <span id="offline-ai-pct" style="font-size: 12px; color: #cbd5e1; font-weight: 700;">0%</span>                    <div style="font-size: 11px; color: #64748b; margin-top: 10px; margin-bottom: 15px;">💡 Elaborazione a blocchi di 3 min (&lt; 25 MB) • rispetto dei 20 req/min Free Tier</div>
                    <button class="webex-subtitles-action-btn danger-btn" id="offline-btn-stop-ai" style="margin: 0 auto; background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); color: #fca5a5; padding: 6px 12px;">
                        <span>🛑 Ferma Trascrizione AI</span>
                    </button>
                </div>
            `;
            
            setTimeout(() => {
                const stopBtn = document.getElementById("offline-btn-stop-ai");
                if (stopBtn) {
                    stopBtn.onclick = () => {
                        isOfflineAITranscribing = false;
                        if (typeof AITranscriber !== 'undefined' && AITranscriber.abort) {
                            AITranscriber.abort();
                        }
                        renderOfflineSubtitlesEmptyState();
                        showHUD("Trascrizione AI interrotta.", "🛑");
                    };
                }
            }, 50);
        }

        const updateProgress = ({ stage, percent, detail }) => {
            const bar = document.getElementById("offline-ai-bar");
            const pct = document.getElementById("offline-ai-pct");
            const det = document.getElementById("offline-ai-detail");
            const title = document.getElementById("offline-ai-title");
            if (bar) bar.style.width = `${percent}%`;
            if (pct) pct.innerText = `${percent}%`;
            if (det) det.innerText = detail;
            if (title) {
                if (stage === "download") title.innerText = "1/3 Lettura Traccia Audio Digitale...";
                else if (stage === "decode" || stage === "resample") title.innerText = "2/3 Decodifica Digitale & Ricampionamento...";
                else if (stage === "transcribing") title.innerText = "3/3 Riconoscimento Vocale AI (Whisper)...";
                else if (stage === "complete") title.innerText = "Trascrizione Completata!";
            }
        };

        try {
            // Extract digital audio from local video blob/file URL (ZERO MICROPHONE)
            const audioData = await AITranscriber.extractAudioTrackFromUrl(video.src, updateProgress);
            const cues = await AITranscriber.transcribeAudioTrack(audioData, updateProgress);

            if (cues && cues.length > 0) {
                try {
                    localStorage.setItem(`webex_subtitles_${lectureId}`, JSON.stringify(cues)); try { chrome.storage.local.set({ [`webex_subtitles_${lectureId}`]: JSON.stringify(cues) }); } catch (_) {}
                } catch (_) {}

                // If PC folder is connected, also write .vtt file alongside the video!
                if (pcFolderDirectoryHandle && lectureTitle) {
                    try {
                        const baseName = lectureTitle.replace(/\.[^/.]+$/, "").trim();
                        const vttFileName = `${baseName}.vtt`;
                        const fileHandle = await pcFolderDirectoryHandle.getFileHandle(vttFileName, { create: true });
                        const writable = await fileHandle.createWritable();
                        let vttContent = "WEBVTT\n\n";
                        cues.forEach((c, idx) => {
                            const sH = Math.floor(c.start / 3600).toString().padStart(2, "0");
                            const sM = Math.floor((c.start % 3600) / 60).toString().padStart(2, "0");
                            const sS = (c.start % 60).toFixed(3).padStart(6, "0");
                            const eH = Math.floor(c.end / 3600).toString().padStart(2, "0");
                            const eM = Math.floor((c.end % 3600) / 60).toString().padStart(2, "0");
                            const eS = (c.end % 60).toFixed(3).padStart(6, "0");
                            vttContent += `${idx + 1}\n${sH}:${sM}:${sS} --> ${eH}:${eM}:${eS}\n${c.text}\n\n`;
                        });
                        await writable.write(vttContent);
                        await writable.close();
                        console.log("[WebexOffline] Saved generated VTT to PC folder:", vttFileName);
                    } catch (e) {
                        console.warn("[WebexOffline] Could not auto-save VTT to folder:", e);
                    }
                }

                loadOfflineSubtitles(cues, "Trascrizione AI (Whisper Vocale)");
                showHUD(`Trascrizione completata: ${cues.length} frasi sincronizzate!`, "✨");
            } else {
                showHUD("Nessun parlato rilevato nel file audio.", "⚠️");
                renderOfflineSubtitlesList();
            }
        } catch (err) {
            console.error("[WebexOffline] AI transcription error:", err);
            showHUD("Errore trascrizione: " + err.message, "❌");
            if (offlineSubtitlesList) {
                offlineSubtitlesList.innerHTML = `
                    <div class="webex-subtitles-empty">
                        <div style="font-size: 28px; margin-bottom: 8px;">⚠️</div>
                        <b style="color: #ef4444; font-size: 14px;">Trascrizione Non Riuscita</b>
                        <p style="font-size: 12px; color: #94a3b8; margin: 8px 0 16px 0; line-height: 1.5;">
                            ${err.message}
                        </p>
                        <div style="display: flex; gap: 8px; justify-content: center;">
                            <button class="webex-subtitles-action-btn active" id="offline-btn-retry-ai" style="padding: 8px 16px;">
                                <span>🔄 Riprova</span>
                            </button>
                            <button class="webex-subtitles-action-btn" id="offline-btn-key-ai" style="padding: 8px 16px;">
                                <span>🔑 Modifica Chiave API</span>
                            </button>
                        </div>
                    </div>
                `;
                const retryBtn = offlineSubtitlesList.querySelector("#offline-btn-retry-ai");
                if (retryBtn) retryBtn.onclick = () => startOfflineAITranscription();
                const keyBtn = offlineSubtitlesList.querySelector("#offline-btn-key-ai");
                if (keyBtn) keyBtn.onclick = async () => {
                    await AITranscriber.promptForGroqApiKey();
                    startOfflineAITranscription();
                };
            }
        } finally {
            isOfflineAITranscribing = false;
        }
    }

    const offlineSubtitlesBtnAi = document.getElementById("offline-subtitles-btn-ai");
    if (offlineSubtitlesBtnAi) offlineSubtitlesBtnAi.onclick = () => startOfflineAITranscription();

    const offlineSubtitlesBtnAiSettings = document.getElementById("offline-subtitles-btn-ai-settings");
    if (offlineSubtitlesBtnAiSettings) {
        offlineSubtitlesBtnAiSettings.onclick = async () => {
            if (typeof AITranscriber !== "undefined" && AITranscriber.promptForGroqApiKey) {
                await AITranscriber.promptForGroqApiKey();
            }
        };
    }

    const offlineSubtitlesBtnDelete = document.getElementById("offline-subtitles-btn-delete");
    if (offlineSubtitlesBtnDelete) {
        offlineSubtitlesBtnDelete.onclick = () => deleteOfflineSubtitlesTrack();
    }

    const offlineSubtitlesBtnExport = document.getElementById("offline-subtitles-btn-export");
    if (offlineSubtitlesBtnExport) {
        offlineSubtitlesBtnExport.onclick = () => {
            if (!offlineSubtitles || offlineSubtitles.length === 0) {
                showHUD("Nessuna trascrizione da esportare", "⚠️");
                return;
            }
            let txt = "Trascrizione Lezione\n\n";
            offlineSubtitles.forEach(c => {
                const h = Math.floor(c.start / 3600).toString().padStart(2, '0');
                const m = Math.floor((c.start % 3600) / 60).toString().padStart(2, '0');
                const s = Math.floor(c.start % 60).toString().padStart(2, '0');
                txt += `[${h}:${m}:${s}] ${c.text}\n`;
            });
            const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `Trascrizione_${(currentLectureTitle || "Lezione").replace(/[^a-z0-9]/gi, '_')}.txt`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showHUD("Trascrizione esportata con successo", "📄");
        };
    }

    // ==========================================
    // FULLSCREEN TOGGLE & ADAPTIVE HUD
    // ==========================================
    function toggleOfflineFullscreen() {
        if (!document.fullscreenElement) {
            if (playerContainer && playerContainer.requestFullscreen) {
                playerContainer.requestFullscreen().catch(() => {});
            } else if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {});
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            }
        }
    }

    const btnFsTop = document.getElementById("btn-fullscreen-toggle");
    if (btnFsTop) btnFsTop.onclick = toggleOfflineFullscreen;

    const btnFsAction = document.getElementById("offline-action-fullscreen");
    if (btnFsAction) btnFsAction.onclick = toggleOfflineFullscreen;

    let offlineToolbarHideTimeout = null;
    let isOfflineToolbarHovered = false;
    const offlineToolbarEl = document.getElementById("webex-helper-toolbar-container");

    if (offlineToolbarEl) {
        offlineToolbarEl.addEventListener("mouseenter", () => {
            isOfflineToolbarHovered = true;
        });
        offlineToolbarEl.addEventListener("mouseleave", () => {
            isOfflineToolbarHovered = false;
        });
    }

    function handleOfflineFullscreenActivity() {
        if (!offlineToolbarEl) return;
        if (!document.fullscreenElement) {
            offlineToolbarEl.style.opacity = "1";
            offlineToolbarEl.style.pointerEvents = "auto";
            if (offlineToolbarHideTimeout) {
                clearTimeout(offlineToolbarHideTimeout);
                offlineToolbarHideTimeout = null;
            }
            return;
        }

        offlineToolbarEl.style.opacity = "1";
        offlineToolbarEl.style.pointerEvents = "auto";

        if (offlineToolbarHideTimeout) {
            clearTimeout(offlineToolbarHideTimeout);
        }

        offlineToolbarHideTimeout = setTimeout(() => {
            if (!document.fullscreenElement) return;
            if (!isOfflineToolbarHovered && !offlineToolbarEl.matches(":hover") && !offlineToolbarEl.querySelector(":hover")) {
                offlineToolbarEl.style.opacity = "0";
                offlineToolbarEl.style.pointerEvents = "none";
            }
        }, 2500);
    }

    window.addEventListener("mousemove", handleOfflineFullscreenActivity);
    document.addEventListener("mousemove", handleOfflineFullscreenActivity);
    if (playerContainer) playerContainer.addEventListener("mousemove", handleOfflineFullscreenActivity);
    if (video) video.addEventListener("mousemove", handleOfflineFullscreenActivity);

    const offlineFsClickArea = document.getElementById("offline-fs-click-area");
    if (offlineFsClickArea) {
        offlineFsClickArea.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleOfflineFullscreen();
        };
    }

    if (video) {
        video.addEventListener("dblclick", (e) => {
            e.preventDefault();
            toggleOfflineFullscreen();
        });
    }

    document.addEventListener("fullscreenchange", () => {
        const fsEl = document.fullscreenElement;
        const isFs = !!fsEl;
        if (btnFsTop) {
            btnFsTop.classList.toggle("active", isFs);
            btnFsTop.innerHTML = isFs ? `<span>🗗</span> Finestra` : `<span>⛶</span> Schermo Intero`;
        }
        if (btnFsAction) {
            btnFsAction.classList.toggle("active", isFs);
        }

        // Move floating modals into fullscreen top layer so they are visible in fullscreen
        const modalsToReparent = [
            document.getElementById("offline-subtitles-panel"),
            document.getElementById("offline-notes-modal"),
            document.getElementById("offline-bm-modal"),
            document.getElementById("offline-explorer-modal"),
            document.getElementById("offline-shortcuts-modal"),
            document.getElementById("offline-paste-transcript-modal"),
            document.getElementById("webex-hud")
        ];
        modalsToReparent.forEach(m => {
            if (!m) return;
            if (fsEl && fsEl !== video) {
                fsEl.appendChild(m);
            } else if (!fsEl) {
                document.body.appendChild(m);
            }
        });

        handleOfflineFullscreenActivity();
    });

    const offlineBtnPaste = document.getElementById("offline-subtitles-btn-paste");
    if (offlineBtnPaste) offlineBtnPaste.onclick = showOfflinePasteTranscriptModal;

    if (offlineActionSubtitlesBtn) {
        offlineActionSubtitlesBtn.onclick = () => toggleOfflineSubtitlesPanel();
    }

    if (offlineSubtitlesClose) {
        offlineSubtitlesClose.onclick = () => toggleOfflineSubtitlesPanel(false);
    }

    const offlineFooterClose = document.getElementById("offline-subtitles-footer-close");
    if (offlineFooterClose) {
        offlineFooterClose.onclick = () => toggleOfflineSubtitlesPanel(false);
    }

    if (offlineSubtitlesToggleCC) {
        offlineSubtitlesToggleCC.classList.toggle("active", isOfflineCCOverlayEnabled);
        offlineSubtitlesToggleCC.onclick = () => {
            isOfflineCCOverlayEnabled = !isOfflineCCOverlayEnabled;
            localStorage.setItem("offline_cc_enabled", isOfflineCCOverlayEnabled ? "true" : "false");
            offlineSubtitlesToggleCC.classList.toggle("active", isOfflineCCOverlayEnabled);
            if (!isOfflineCCOverlayEnabled && offlineCCOverlay) {
                offlineCCOverlay.classList.add("is-hidden");
            }
            showHUD(isOfflineCCOverlayEnabled ? "Sottotitoli a schermo: Attivi" : "Sottotitoli a schermo: Disattivati", "💬");
        };
    }

    if (offlineSubtitlesFileInput) {
        offlineSubtitlesFileInput.onchange = (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (evt) => {
                    const parsed = parseOfflineSubtitleText(evt.target.result);
                    if (parsed.length > 0) {
                        loadOfflineSubtitles(parsed, file.name);
                        if (currentLectureId) {
                            try {
                                localStorage.setItem(`webex_subtitles_${currentLectureId}`, JSON.stringify(parsed));
                            } catch (_) {}
                        }
                    } else {
                        showHUD("Formato file non valido", "⚠️");
                    }
                };
                reader.readAsText(file);
            }
        };
    }

    if (offlineSubtitlesSearch) {
        offlineSubtitlesSearch.oninput = () => {
            const q = offlineSubtitlesSearch.value.trim().toLowerCase();
            if (!q) {
                renderOfflineSubtitlesList();
            } else {
                const filtered = offlineSubtitles.filter(c => c.text.toLowerCase().includes(q));
                renderOfflineSubtitlesList(filtered);
            }
        };
    }

    if (offlineSubtitlesList) {
        offlineSubtitlesList.addEventListener("scroll", () => {
            isOfflineUserInteractingWithSubtitles = true;
            clearTimeout(offlineSubtitleInteractTimeout);
            offlineSubtitleInteractTimeout = setTimeout(() => {
                isOfflineUserInteractingWithSubtitles = false;
            }, 3000);
        });
        offlineSubtitlesList.addEventListener("mouseenter", () => {
            isOfflineUserInteractingWithSubtitles = true;
        });
        offlineSubtitlesList.addEventListener("mouseleave", () => {
            clearTimeout(offlineSubtitleInteractTimeout);
            offlineSubtitleInteractTimeout = setTimeout(() => {
                isOfflineUserInteractingWithSubtitles = false;
            }, 2000);
        });
    }

    // ==========================================
    // IN-PAGE CUSTOM FILE EXPLORER MODAL
    // ==========================================
    // ==========================================
    // TOPBAR LIQUID GLASS LECTURE SELECTOR
    // ==========================================
    const topLectureWrapper = document.getElementById("top-lecture-wrapper");
    const topLecturePill = document.getElementById("top-lecture-pill");
    const topLectureTitle = document.getElementById("top-lecture-title");
    const topLectureBadge = document.getElementById("top-lecture-badge");
    const topLectureDropdown = document.getElementById("top-lecture-dropdown");
    const topLectureSearchInput = document.getElementById("top-lecture-search-input");
    const topLectureList = document.getElementById("top-lecture-list");

    function renderTopLectureList(list) {
        if (!topLectureList) return;
        topLectureList.innerHTML = "";
        
        let filtered = list || [];
        const q = (topLectureSearchInput && typeof topLectureSearchInput.value === "string" ? topLectureSearchInput.value : "").trim().toLowerCase();
        if (q) {
            filtered = list.filter(item => 
                (item.title || "").toLowerCase().includes(q) || 
                (item.folder || "").toLowerCase().includes(q)
            );
        }

        if (filtered.length === 0) {
            topLectureList.innerHTML = `<div style="text-align:center; color:#64748b; font-size:12px; padding:18px 10px;">Nessuna lezione trovata</div>`;
            return;
        }

        filtered.forEach(item => {
            const row = document.createElement("div");
            const isCur = item.id === currentLectureId;
            row.className = `top-lecture-item ${isCur ? 'is-current' : ''}`;
            const sizeMB = Math.round((item.size || 0) / (1024 * 1024));
            const durStr = item.duration ? formatTime(item.duration) : "";

            row.innerHTML = `
                <div class="top-lecture-item-info">
                    <div class="top-lecture-item-title">${item.title || item.id}</div>
                    <div class="top-lecture-item-meta">
                        ${item.folder ? `<span class="top-lecture-folder-badge">📁 ${item.folder}</span>` : ''}
                        ${durStr ? `<span>⏱️ ${durStr}</span>` : ''}
                        <span>📦 ${sizeMB} MB</span>
                    </div>
                </div>
                ${isCur ? '<span style="color:#38bdf8; font-weight:800; font-size:13px; margin-left:6px;">✓</span>' : ''}
            `;

            row.onclick = () => {
                closeTopLectureDropdown();
                playSavedLecture(item.id);
            };

            topLectureList.appendChild(row);
        });
    }

    function toggleTopLectureDropdown() {
        if (!topLectureDropdown) return;
        const isOpen = topLectureDropdown.classList.contains("is-open");
        if (isOpen) closeTopLectureDropdown();
        else openTopLectureDropdown();
    }

    function openTopLectureDropdown() {
        if (!topLectureDropdown) return;
        topLectureDropdown.classList.add("is-open");
        if (topLecturePill) topLecturePill.classList.add("is-active");
        if (topLectureSearchInput) {
            topLectureSearchInput.value = "";
            topLectureSearchInput.focus();
        }
        WebexOfflineDB.listLectures().then(renderTopLectureList);
    }

    function closeTopLectureDropdown() {
        if (!topLectureDropdown) return;
        topLectureDropdown.classList.remove("is-open");
        if (topLecturePill) topLecturePill.classList.remove("is-active");
    }

    if (topLecturePill) {
        topLecturePill.onclick = (e) => {
            e.stopPropagation();
            toggleTopLectureDropdown();
        };
    }

    if (topLectureSearchInput) {
        topLectureSearchInput.oninput = () => {
            WebexOfflineDB.listLectures().then(renderTopLectureList);
        };
        topLectureSearchInput.onclick = (e) => e.stopPropagation();
    }

    window.addEventListener("click", (e) => {
        if (topLectureDropdown && !topLectureDropdown.contains(e.target) && (!topLecturePill || !topLecturePill.contains(e.target))) {
            closeTopLectureDropdown();
        }
    });

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && topLectureDropdown && topLectureDropdown.classList.contains("is-open")) {
            closeTopLectureDropdown();
        }
    });

    // ==========================================
    // IN-PAGE CUSTOM FILE EXPLORER MODAL & PC SYNC
    // ==========================================
    const explorerModal = document.getElementById("offline-explorer-modal");
    const btnToggleLibrary = document.getElementById("btn-toggle-library");
    const btnCloseExplorer = document.getElementById("btn-close-explorer");
    const btnNewFolder = document.getElementById("btn-explorer-new-folder");
    const folderListEl = document.getElementById("explorer-folder-list");
    const fileListEl = document.getElementById("explorer-file-list");
    const currentFolderTitle = document.getElementById("explorer-current-folder-title");
    const lectureCountBadge = document.getElementById("explorer-lecture-count-badge");
    const searchInput = document.getElementById("explorer-search-input");
    const sortSelect = document.getElementById("explorer-sort-select");

    const btnLinkPCFolder = document.getElementById("btn-link-pc-folder");
    const pcMirrorIcon = document.getElementById("pc-mirror-icon");
    const pcMirrorLabel = document.getElementById("pc-mirror-label");
    const btnModalSyncPC = document.getElementById("btn-modal-sync-pc");
    const btnModalLinkFolder = document.getElementById("btn-modal-link-folder");
    const modalLinkPCLabel = document.getElementById("modal-link-pc-label");

    function openExplorerModal() {
        if (!explorerModal) return;
        explorerModal.style.display = "flex";
        try {
            renderExplorerFolders();
        } catch (err) {
            console.error("renderExplorerFolders error:", err);
        }
        try {
            renderExplorerFiles();
        } catch (err) {
            console.error("renderExplorerFiles error:", err);
        }
    }

    function closeExplorerModal() {
        if (!explorerModal) return;
        explorerModal.style.display = "none";
        closeFolderDropdownMenu();
    }

    if (btnToggleLibrary) {
        btnToggleLibrary.onclick = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            openExplorerModal();
        };
        btnToggleLibrary.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openExplorerModal();
        });
    }
    if (btnCloseExplorer) btnCloseExplorer.onclick = closeExplorerModal;

    explorerModal.addEventListener("click", (e) => {
        if (e.target === explorerModal) closeExplorerModal();
    });

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && explorerModal && explorerModal.style.display === "flex") {
            closeExplorerModal();
        }
    });

    if (btnNewFolder) {
        btnNewFolder.onclick = async () => {
            const name = prompt("Inserisci il nome del nuovo corso / cartella principale (es. Analisi 1, Fisica 2):");
            if (name && name.trim()) {
                await doCreateFolder("", name.trim());
            }
        };
    }

    if (searchInput) {
        searchInput.oninput = (e) => {
            explorerSearchQuery = e.target.value.toLowerCase().trim();
            renderExplorerFiles();
        };
    }

    if (sortSelect) {
        sortSelect.onchange = (e) => {
            explorerCurrentSort = e.target.value;
            renderExplorerFiles();
        };
    }

    const btnPurgeLibrary = document.getElementById("btn-purge-library");
    if (btnPurgeLibrary) {
        btnPurgeLibrary.onclick = async () => {
            if (confirm("Sei sicuro di voler svuotare tutta la libreria locale?\n\nTutte le registrazioni e le trascrizioni salvate nel browser verranno eliminate per consentire un test pulito.\n(Le API Key e l'email di login NON verranno toccate).")) {
                try {
                    await WebexOfflineDB.clearAllLecturesAndTranscripts();
                    showHUD("🧹 Libreria e trascrizioni svuotate!", "✅");
                    if (activeBlobUrl) {
                        try { URL.revokeObjectURL(activeBlobUrl); } catch (_) {}
                        activeBlobUrl = null;
                    }
                    video.src = "";
                    emptyState.style.display = "flex";
                    const videoFrame = document.getElementById("offline-video-frame");
                    if (videoFrame) videoFrame.style.display = "none";
                    await renderOfflineList();
                    await syncTopDropdown();
                    renderExplorerFolders();
                    renderExplorerFiles();
                } catch (err) {
                    console.error("Purge error:", err);
                    showHUD("Errore svuotamento libreria", "⚠️");
                }
            }
        };
    }

    // Clean test purge on startup for v2.0.4
    if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["v204_db_cleaned"], (res) => {
            if (!res || !res.v204_db_cleaned) {
                if (window.WebexOfflineDB && typeof WebexOfflineDB.clearAllLecturesAndTranscripts === "function") {
                    WebexOfflineDB.clearAllLecturesAndTranscripts().then(() => {
                        console.log("[WebexOffline] Database cleanly purged for v2.0.4 test!");
                        chrome.storage.local.set({ v204_db_cleaned: true });
                        renderOfflineList();
                        syncTopDropdown();
                        renderExplorerFolders();
                        renderExplorerFiles();
                    }).catch(console.warn);
                }
            }
        });
    }

    // ==========================================
    // TWO-WAY PC MIRROR ENGINE (Specchio Esatto)
    // ==========================================
    function updatePCMirrorUI() {
        if (!btnLinkPCFolder) return;
        if (pcFolderDirectoryHandle) {
            btnLinkPCFolder.className = "pc-mirror-status-badge active-mirror";
            if (pcMirrorIcon) pcMirrorIcon.textContent = "🟢";
            if (pcMirrorLabel) pcMirrorLabel.textContent = `Specchio PC: ${pcFolderDirectoryHandle.name}`;
            if (modalLinkPCLabel) modalLinkPCLabel.textContent = `💾 Specchio PC: ${pcFolderDirectoryHandle.name}`;
        } else {
            btnLinkPCFolder.className = "pc-mirror-status-badge";
            if (pcMirrorIcon) pcMirrorIcon.textContent = "💾";
            if (pcMirrorLabel) pcMirrorLabel.textContent = "Collega Specchio PC";
            if (modalLinkPCLabel) modalLinkPCLabel.textContent = "💾 Collega Specchio PC";
        }
    }

    async function getOrCreateSubdir(rootHandle, relativePath) {
        if (!rootHandle || !relativePath || !relativePath.trim()) return rootHandle;
        const parts = relativePath.trim().replace(/\\/g, '/').split('/').map(p => p.trim()).filter(Boolean);
        let curr = rootHandle;
        for (const part of parts) {
            const clean = part.replace(/[/\\?%*:|"<>]/g, '_');
            curr = await curr.getDirectoryHandle(clean, { create: true });
        }
        return curr;
    }

    async function getSubdir(rootHandle, relativePath) {
        if (!rootHandle || !relativePath || !relativePath.trim()) return rootHandle;
        const parts = relativePath.trim().replace(/\\/g, '/').split('/').map(p => p.trim()).filter(Boolean);
        let curr = rootHandle;
        for (const part of parts) {
            const clean = part.replace(/[/\\?%*:|"<>]/g, '_');
            try {
                curr = await curr.getDirectoryHandle(clean, { create: false });
            } catch (_) {
                return null;
            }
        }
        return curr;
    }

    async function scanPCFolderRecursively(dirHandle, relPath = "") {
        const files = [];
        const subdirs = [];
        try {
            for await (const [name, entry] of dirHandle.entries()) {
                if (entry.kind === "file") {
                    const lower = name.toLowerCase();
                    if (lower.endsWith(".mp4") || lower.endsWith(".webm") || lower.endsWith(".mkv")) {
                        try {
                            const file = await entry.getFile();
                            files.push({
                                name,
                                relPath,
                                folder: relPath,
                                fileHandle: entry,
                                file: file,
                                size: file.size,
                                date: file.lastModified || Date.now()
                            });
                        } catch (fErr) {
                            console.warn("Could not read file:", name, fErr);
                        }
                    }
                } else if (entry.kind === "directory") {
                    const subPath = relPath ? `${relPath}/${name}` : name;
                    subdirs.push(subPath);
                    const nested = await scanPCFolderRecursively(entry, subPath);
                    files.push(...nested.files);
                    subdirs.push(...nested.subdirs);
                }
            }
        } catch (e) {
            console.warn("Scan warning for directory:", relPath, e);
        }
        return { files, subdirs };
    }

    async function syncPCMirror(interactive = false) {
        if (!pcFolderDirectoryHandle) {
            if (interactive) await linkPCFolder();
            return;
        }

        try {
            const perm = await pcFolderDirectoryHandle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                if (!interactive) {
                    updatePCMirrorUI();
                    return;
                }
                const req = await pcFolderDirectoryHandle.requestPermission({ mode: 'readwrite' });
                if (req !== 'granted') {
                    updatePCMirrorUI();
                    showHUD("Permesso non concesso per la cartella PC", "⚠️");
                    return;
                }
            }
        } catch (_) {
            updatePCMirrorUI();
            return;
        }

        if (interactive) showHUD("Sincronizzazione Specchio PC in corso...", "⏳");

        try {
            // 1. Recursive scan of the disk folder
            const { files: diskFiles, subdirs: diskSubdirs } = await scanPCFolderRecursively(pcFolderDirectoryHandle);

            // 2. Ensure all subdirectories on disk exist as folders in IndexedDB
            for (const sub of diskSubdirs) {
                await WebexOfflineDB.createFolder(sub);
            }

            // 3. Reconcile DB with Disk:
            const dbLectures = await WebexOfflineDB.listLectures();
            const fullDbLectures = await Promise.all(dbLectures.map(l => WebexOfflineDB.getLecture(l.id)));
            const matchedDbLectureIds = new Set();

            const normalize = (s) => (s || '')
                .toLowerCase()
                .replace(/[-_~|:/\\]/g, ' ')
                .replace(/\s+/g, ' ')
                .replace(/\.mp4$|\.webm$|\.mkv$/i, '')
                .replace(/\b(polimi|webex|lezione|videolezione|recording|enhancer)\b/gi, '')
                .trim();

            // 3A. Disk -> DB: Match files found on disk with DB lectures
            for (const df of diskFiles) {
                const cleanName = df.name.replace(/\.[^/.]+$/, "");
                const normDisk = normalize(cleanName);

                let match = null;

                // 1. Direct fileHandle same entry check
                for (const l of fullDbLectures) {
                    if (l && l.fileHandle && !matchedDbLectureIds.has(l.id)) {
                        try {
                            if (typeof l.fileHandle.isSameEntry === 'function' && await l.fileHandle.isSameEntry(df.fileHandle)) {
                                match = l;
                                break;
                            }
                        } catch (_) {}
                    }
                }

                // 2. Exact fileName or title + folder match
                if (!match) {
                    match = fullDbLectures.find(l => 
                        l && !matchedDbLectureIds.has(l.id) && (
                            (l.fileName && l.fileName.toLowerCase() === df.name.toLowerCase()) ||
                            (l.fileHandle && l.fileHandle.name && l.fileHandle.name.toLowerCase() === df.name.toLowerCase()) ||
                            ((l.folder || '') === (df.folder || '') && (l.title || '').toLowerCase() === cleanName.toLowerCase())
                        )
                    );
                }

                // 3. Normalized title / originalTitle match (handles user renaming or moving the file)
                if (!match && normDisk.length >= 3) {
                    match = fullDbLectures.find(l => {
                        if (!l || matchedDbLectureIds.has(l.id)) return false;
                        const nOrig = normalize(l.originalTitle);
                        const nTitle = normalize(l.title);
                        const nFile = normalize(l.fileName || (l.fileHandle ? l.fileHandle.name : ''));
                        return (
                            (nOrig && (nOrig === normDisk || normDisk.includes(nOrig) || nOrig.includes(normDisk))) ||
                            (nTitle && (nTitle === normDisk || normDisk.includes(nTitle) || nTitle.includes(normDisk))) ||
                            (nFile && (nFile === normDisk || normDisk.includes(nFile) || nFile.includes(normDisk)))
                        );
                    });
                }

                if (match) {
                    matchedDbLectureIds.add(match.id);
                    // Update location and fileHandle, preserving webexRecordingId, originalTitle, and URL
                    match.folder = df.folder || "";
                    match.fileHandle = df.fileHandle;
                    match.fileName = df.name;
                    match.isLocalMirror = true;
                    match.size = df.size;
                    if (!match.originalTitle) match.originalTitle = match.title || cleanName;
                    await WebexOfflineDB.saveLecture(match);
                } else {
                    // New video file discovered on PC disk -> register into offline library
                    const newId = `mirror_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
                    await WebexOfflineDB.saveLecture({
                        id: newId,
                        title: cleanName,
                        originalTitle: cleanName,
                        fileName: df.name,
                        folder: df.folder || "",
                        size: df.size,
                        duration: 0,
                        bufferedPercent: 100,
                        date: new Date(df.date).toISOString(),
                        isLocalMirror: true,
                        fileHandle: df.fileHandle
                    });
                }
            }

            // 3B. DB -> Disk: Any lecture in DB that has a blob but is missing on disk -> mirror to disk!
            for (const l of fullDbLectures) {
                if (!l) continue;
                if (!matchedDbLectureIds.has(l.id)) {
                    if (l.blob) {
                        const cleanTitle = (l.title || l.id).replace(/[/\\?%*:|"<>]/g, '_').trim();
                        const fileName = `${cleanTitle}.mp4`;
                        const fileFolder = (l.folder || "").trim();

                        try {
                            const targetDir = await getOrCreateSubdir(pcFolderDirectoryHandle, fileFolder);
                            const fh = await targetDir.getFileHandle(fileName, { create: true });
                            const writable = await fh.createWritable();
                            await writable.write(l.blob);
                            await writable.close();
                            l.fileHandle = fh;
                            l.fileName = fileName;
                            l.isLocalMirror = true;
                            await WebexOfflineDB.saveLecture(l);
                        } catch (wErr) {
                            console.warn("Could not mirror DB lecture to disk:", l.id, wErr);
                        }
                    } else if (l.id.startsWith("mirror_") && !l.fileHandle) {
                        // Stale mirror entry deleted from disk and without blob -> purge from DB
                        await WebexOfflineDB.deleteLecture(l.id);
                    }
                }
            }

            updatePCMirrorUI();
            await renderExplorerFolders();
            await renderExplorerFiles();
            await syncTopDropdown();
            if (interactive) showHUD(`Specchio PC sincronizzato (${diskFiles.length} file)`, "🟢");
        } catch (err) {
            console.error("PC Mirror sync error:", err);
            if (interactive) showHUD("Errore sincronizzazione specchio PC", "⚠️");
        }
    }

    async function initPCFolderPersistence() {
        try {
            if (!('showDirectoryPicker' in window)) return;
            const savedHandle = (await WebexOfflineDB.getSetting("pc_folder_handle")) || (await WebexOfflineDB.getSetting("pcFolderHandle"));
            if (savedHandle) {
                pcFolderDirectoryHandle = savedHandle;
                updatePCMirrorUI();
                try {
                    const perm = await savedHandle.queryPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        await syncPCMirror(false);
                    } else {
                        updatePCMirrorUI();
                    }
                } catch (_) {
                    updatePCMirrorUI();
                }
            }
        } catch (err) {
            console.warn("PC folder handle restoration warning:", err);
        }
    }

    async function linkPCFolder() {
        try {
            if ('showDirectoryPicker' in window) {
                pcFolderDirectoryHandle = await window.showDirectoryPicker({
                    mode: 'readwrite'
                });
                await WebexOfflineDB.saveSetting("pc_folder_handle", pcFolderDirectoryHandle);
                await WebexOfflineDB.saveSetting("pcFolderHandle", pcFolderDirectoryHandle);
                updatePCMirrorUI();
                showHUD(`Cartella PC collegata: ${pcFolderDirectoryHandle.name}`, "🟢");
                await syncPCMirror(true);
                openExplorerModal();
            } else {
                alert("Il tuo browser non supporta l'accesso diretto al file system.");
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error("Errore collegamento cartella PC:", err);
                showHUD("Errore selezione cartella PC", "⚠️");
            }
        }
    }

    async function handlePCMirrorButtonClick() {
        if (!pcFolderDirectoryHandle) {
            await linkPCFolder();
            return;
        }
        try {
            const perm = await pcFolderDirectoryHandle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                const req = await pcFolderDirectoryHandle.requestPermission({ mode: 'readwrite' });
                if (req === 'granted') {
                    await syncPCMirror(true);
                }
            } else {
                await syncPCMirror(true);
            }
        } catch (_) {
            await linkPCFolder();
        }
    }

    if (btnLinkPCFolder) btnLinkPCFolder.onclick = handlePCMirrorButtonClick;
    if (btnModalSyncPC) btnModalSyncPC.onclick = () => syncPCMirror(true);
    if (btnModalLinkFolder) btnModalLinkFolder.onclick = linkPCFolder;

    // Two-way synchronized actions
    async function doCreateFolder(parentPath, subName) {
        const cleanSub = subName.trim().replace(/[/\\?%*:|"<>]/g, '_');
        const fullPath = parentPath ? `${parentPath}/${cleanSub}` : cleanSub;
        await WebexOfflineDB.createFolder(fullPath);
        if (pcFolderDirectoryHandle) {
            try {
                await getOrCreateSubdir(pcFolderDirectoryHandle, fullPath);
            } catch (e) {
                console.warn("Disk create subfolder error:", e);
            }
        }
        explorerCurrentFolder = fullPath;
        await renderExplorerFolders();
        await renderExplorerFiles();
        await syncTopDropdown();
        showHUD(`Cartella creata: ${fullPath}`, "📁");
    }

    async function doDeleteFolder(folderPath) {
        if (!confirm(`Eliminare la cartella "${folderPath}" e le relative sottocartelle? Le lezioni al suo interno rimarranno visibili in "Tutte le lezioni".`)) return;
        await WebexOfflineDB.deleteFolder(folderPath);
        if (pcFolderDirectoryHandle) {
            try {
                if (!folderPath.includes('/')) {
                    await pcFolderDirectoryHandle.removeEntry(folderPath, { recursive: true });
                } else {
                    const parts = folderPath.split('/');
                    const last = parts.pop();
                    const parentDir = await getSubdir(pcFolderDirectoryHandle, parts.join('/'));
                    if (parentDir) await parentDir.removeEntry(last, { recursive: true });
                }
            } catch (e) {
                console.warn("Disk delete folder error:", e);
            }
        }
        if (explorerCurrentFolder === folderPath || explorerCurrentFolder.startsWith(folderPath + "/")) {
            explorerCurrentFolder = "all";
        }
        await renderExplorerFolders();
        await renderExplorerFiles();
        await syncTopDropdown();
        showHUD(`Cartella eliminata: ${folderPath}`, "🗑️");
    }

    async function doDeleteLecture(item) {
        if (!confirm(`Eliminare definitivamente "${item.title || item.id}" dalla libreria e dal disco PC?`)) return;
        await WebexOfflineDB.deleteLecture(item.id);
        if (pcFolderDirectoryHandle) {
            try {
                const targetDir = await getSubdir(pcFolderDirectoryHandle, item.folder || "");
                if (targetDir) {
                    const cleanName = `${(item.title || item.id).replace(/[/\\?%*:|"<>]/g, '_')}.mp4`;
                    try { await targetDir.removeEntry(cleanName); } catch (_) {}
                    if (item.fileHandle && item.fileHandle.name) {
                        try { await targetDir.removeEntry(item.fileHandle.name); } catch (_) {}
                    }
                }
            } catch (e) {
                console.warn("Disk delete file error:", e);
            }
        }
        try {
            if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ type: "DELETE_SAVED_LECTURE", lectureId: item.id, pageUrl: item.url || "", title: item.title || "" });
            }
        } catch (_) {}
        if (currentLectureId === item.id) {
            video.pause();
            video.src = "";
            video.style.display = "none";
            const videoFrame = document.getElementById("offline-video-frame");
            if (videoFrame) videoFrame.style.display = "none";
            emptyState.style.display = "flex";
        }
        await renderExplorerFolders();
        await renderExplorerFiles();
        await syncTopDropdown();
        showHUD("Lezione eliminata", "🗑️");
    }

    async function doMoveLecture(item, targetFolder) {
        const oldFolder = item.folder || "";
        await WebexOfflineDB.moveLecture(item.id, targetFolder);

        if (pcFolderDirectoryHandle) {
            try {
                const fullData = await WebexOfflineDB.getLecture(item.id);
                if (fullData && (fullData.blob || fullData.fileHandle)) {
                    const blob = fullData.blob || (fullData.fileHandle ? await fullData.fileHandle.getFile() : null);
                    if (blob) {
                        const cleanName = `${(item.title || item.id).replace(/[/\\?%*:|"<>]/g, '_')}.mp4`;
                        // Write to target directory on disk
                        const targetDir = await getOrCreateSubdir(pcFolderDirectoryHandle, targetFolder);
                        const newFh = await targetDir.getFileHandle(cleanName, { create: true });
                        const w = await newFh.createWritable();
                        await w.write(blob);
                        await w.close();

                        // Remove from old directory on disk
                        const oldDir = await getSubdir(pcFolderDirectoryHandle, oldFolder);
                        if (oldDir) {
                            try { await oldDir.removeEntry(cleanName); } catch (_) {}
                            if (item.fileHandle && item.fileHandle.name) {
                                try { await oldDir.removeEntry(item.fileHandle.name); } catch (_) {}
                            }
                        }
                        fullData.fileHandle = newFh;
                        fullData.isLocalMirror = true;
                        await WebexOfflineDB.saveLecture(fullData);
                    }
                }
            } catch (e) {
                console.warn("Disk move file error:", e);
            }
        }

        showHUD(`Spostata in: ${targetFolder || "Tutte le lezioni"}`, "📁");
        await renderExplorerFolders();
        await renderExplorerFiles();
        await syncTopDropdown();
    }

    // ==========================================
    // EXPLORER VIEW RENDERING (Hierarchical Tree)
    // ==========================================
    async function renderExplorerFolders() {
        if (!folderListEl) return;
        const folders = await WebexOfflineDB.getFolders();
        const allLectures = await WebexOfflineDB.listLectures();

        folderListEl.innerHTML = "";

        // Special "All" Item
        const allItem = document.createElement("div");
        allItem.className = `webex-explorer-folder-item ${explorerCurrentFolder === "all" ? "active" : ""}`;
        allItem.innerHTML = `
            <span>📁 Tutte le lezioni</span>
            <span style="font-size: 11px; opacity: 0.7;">${allLectures.length}</span>
        `;
        allItem.onclick = () => {
            explorerCurrentFolder = "all";
            renderExplorerFolders();
            renderExplorerFiles();
        };
        folderListEl.appendChild(allItem);

        // Folders and Subfolders list
        folders.forEach(folder => {
            const count = allLectures.filter(l => l.folder === folder || (l.folder && l.folder.startsWith(folder + "/"))).length;
            const segments = folder.split('/');
            const depth = segments.length - 1;
            const baseName = segments[segments.length - 1];

            const item = document.createElement("div");
            item.className = `webex-explorer-folder-item ${depth > 0 ? 'subfolder' : ''} ${explorerCurrentFolder === folder ? "active" : ""}`;
            if (depth > 0) {
                item.style.paddingLeft = `${10 + depth * 14}px`;
            }

            item.innerHTML = `
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:flex; align-items:center; gap:5px;" title="${folder}">
                    ${depth > 0 ? '<span style="opacity:0.5; font-size:10px;">↳</span>' : ''}
                    <span>📁 ${baseName}</span>
                </span>
                <div class="folder-actions">
                    <span style="font-size: 11px; opacity: 0.7;">${count}</span>
                    <button class="add-subfolder-btn" title="Crea sottocartella in ${folder}">➕</button>
                    <button class="del-folder-btn" title="Elimina cartella">✕</button>
                </div>
            `;

            item.onclick = (e) => {
                if (e.target.classList.contains("del-folder-btn")) {
                    e.stopPropagation();
                    doDeleteFolder(folder);
                } else if (e.target.classList.contains("add-subfolder-btn")) {
                    e.stopPropagation();
                    const subName = prompt(`Crea sottocartella dentro "${folder}":`);
                    if (subName && subName.trim()) {
                        doCreateFolder(folder, subName.trim());
                    }
                } else {
                    explorerCurrentFolder = folder;
                    renderExplorerFolders();
                    renderExplorerFiles();
                }
            };

            folderListEl.appendChild(item);
        });
    }

    async function renderExplorerFiles() {
        if (!fileListEl) return;
        const [sortField, sortOrder] = explorerCurrentSort.split("_");
        
        let filesToShow = await WebexOfflineDB.listLectures(
            explorerCurrentFolder === "all" ? null : explorerCurrentFolder,
            sortField,
            sortOrder
        );

        if (explorerSearchQuery) {
            filesToShow = filesToShow.filter(l => 
                (l.title || "").toLowerCase().includes(explorerSearchQuery) ||
                (l.folder || "").toLowerCase().includes(explorerSearchQuery)
            );
        }

        if (currentFolderTitle) {
            if (explorerCurrentFolder === "all") currentFolderTitle.innerText = "📁 Tutte le lezioni";
            else currentFolderTitle.innerText = `📁 ${explorerCurrentFolder}`;
        }
        if (lectureCountBadge) {
            lectureCountBadge.innerText = filesToShow.length;
        }

        fileListEl.innerHTML = "";

        if (filesToShow.length === 0) {
            fileListEl.innerHTML = `
                <div style="text-align: center; color: #64748b; font-size: 13px; padding: 40px 20px;">
                    Nessuna lezione trovata ${explorerCurrentFolder !== "all" ? `nella cartella "${explorerCurrentFolder}"` : ""}.<br>
                    Scarica le lezioni dal player Webex usando la Modalità Offline o sincronizza la cartella specchio del tuo computer.
                </div>
            `;
            return;
        }

        filesToShow.forEach(item => {
            const card = document.createElement("div");
            card.className = "webex-explorer-card";
            const sizeMB = Math.round((item.size || 0) / (1024 * 1024));
            const formattedDate = new Date(item.date).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
            const durationStr = item.duration ? formatTime(item.duration) : "--:--";

            card.innerHTML = `
                <div class="webex-explorer-card-info">
                    <div class="webex-explorer-card-title">${item.title || item.id}</div>
                    <div class="webex-explorer-card-meta">
                        ${item.folder ? `<span style="background: rgba(56,189,248,0.18); color: #38bdf8; padding: 1px 7px; border-radius: 4px; font-weight: 600;">📁 ${item.folder}</span>` : ''}
                        <span>⏱️ ${durationStr}</span>
                        <span>📦 ${sizeMB} MB</span>
                        <span>📅 ${formattedDate}</span>
                    </div>
                </div>
                <div class="webex-explorer-card-actions">
                    <button class="webex-folder-pill-btn" type="button" title="Sposta o assegna cartella">
                        📁 <span class="pill-name">${item.folder || "Nessuna cartella"}</span>
                        <span class="pill-chevron">▾</span>
                    </button>
                    <button class="btn-top btn-play-card" style="padding: 4px 10px; background: #38bdf8; color: #0f172a; font-weight: 700;">▶ Play</button>
                    <button class="btn-top btn-export-card" title="Scarica copia MP4" style="padding: 4px 8px;">💾</button>
                    <button class="btn-top btn-del-card" title="Elimina lezione" style="padding: 4px 8px; color: #ef4444; border-color: rgba(239,68,68,0.3);">🗑️</button>
                </div>
            `;

            const playAction = () => {
                closeFolderDropdownMenu();
                playSavedLecture(item.id);
                closeExplorerModal();
            };

            card.onclick = playAction;

            const actionsBox = card.querySelector(".webex-explorer-card-actions");
            if (actionsBox) {
                actionsBox.addEventListener("click", (e) => e.stopPropagation());
                actionsBox.addEventListener("mousedown", (e) => e.stopPropagation());
                actionsBox.addEventListener("pointerdown", (e) => e.stopPropagation());
            }

            const playBtn = card.querySelector(".btn-play-card");
            if (playBtn) {
                playBtn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    playAction();
                };
            }

            const folderPill = card.querySelector(".webex-folder-pill-btn");
            if (folderPill) {
                folderPill.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    openFolderDropdownMenu(folderPill, item);
                });
            }

            const exportBtn = card.querySelector(".btn-export-card");
            if (exportBtn) {
                exportBtn.onclick = async (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const data = await WebexOfflineDB.getLecture(item.id);
                    if (data && data.blob) {
                        const url = URL.createObjectURL(data.blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${(item.title || item.id).replace(/[/\\?%*:|"<>]/g, '_')}.mp4`;
                        document.body.appendChild(a);
                        a.click();
                        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
                        showHUD("Download avviato", "💾");
                    }
                };
            }

            const delBtn = card.querySelector(".btn-del-card");
            if (delBtn) {
                delBtn.onclick = (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    doDeleteLecture(item);
                };
            }

            fileListEl.appendChild(card);
        });
    }

    // --- Liquid Glass Folder Selection Popup Menu (with Subfolders) ---
    let activeFolderDropdown = null;

    function closeFolderDropdownMenu() {
        if (activeFolderDropdown) {
            if (activeFolderDropdown.pillBtn) {
                activeFolderDropdown.pillBtn.classList.remove("is-active");
            }
            if (activeFolderDropdown.element) {
                activeFolderDropdown.element.remove();
            }
            activeFolderDropdown = null;
        }
    }

    window.addEventListener("click", (e) => {
        if (activeFolderDropdown && !activeFolderDropdown.element.contains(e.target)) {
            closeFolderDropdownMenu();
        }
    });

    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && activeFolderDropdown) {
            closeFolderDropdownMenu();
        }
    });

    async function openFolderDropdownMenu(pillBtn, item) {
        if (activeFolderDropdown && activeFolderDropdown.pillBtn === pillBtn) {
            closeFolderDropdownMenu();
            return;
        }
        closeFolderDropdownMenu();

        const allFolders = await WebexOfflineDB.getFolders();
        const dropdown = document.createElement("div");
        dropdown.className = "webex-folder-liquid-dropdown";
        dropdown.addEventListener("click", (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        });
        dropdown.addEventListener("mousedown", (e) => {
            e.stopPropagation();
            e.stopImmediatePropagation();
        });

        const curFolder = (item.folder && item.folder !== "Generale") ? item.folder : "";

        let itemsHtml = `
            <div class="webex-dropdown-header">Sposta in cartella</div>
            <div class="webex-dropdown-item ${!curFolder ? 'is-selected' : ''}" data-folder="">
                <span>📁 Nessuna cartella (Tutte)</span>
                ${!curFolder ? '<span class="check">✓</span>' : ''}
            </div>
        `;

        allFolders.forEach(f => {
            const isSel = curFolder === f;
            const segments = f.split('/');
            const depth = segments.length - 1;
            const baseName = segments[segments.length - 1];
            const indent = "&nbsp;".repeat(depth * 3);
            const prefix = depth > 0 ? "↳ " : "";

            itemsHtml += `
                <div class="webex-dropdown-item ${isSel ? 'is-selected' : ''}" data-folder="${f}">
                    <span>${indent}${prefix}📁 ${baseName}</span>
                    ${isSel ? '<span class="check">✓</span>' : ''}
                </div>
            `;
        });

        itemsHtml += `
            <div class="webex-dropdown-divider"></div>
            <div class="webex-dropdown-item create-new" data-action="new">
                <span>➕ Nuova cartella principale...</span>
            </div>
            <div class="webex-dropdown-item create-new" data-action="new-sub">
                <span>➕ Nuova sottocartella...</span>
            </div>
        `;

        dropdown.innerHTML = itemsHtml;
        document.body.appendChild(dropdown);

        const rect = pillBtn.getBoundingClientRect();
        let top = rect.bottom + 6;
        let left = rect.left;
        if (left + 260 > window.innerWidth) {
            left = window.innerWidth - 270;
        }
        if (top + 300 > window.innerHeight) {
            top = Math.max(10, rect.top - 280);
        }
        dropdown.style.top = `${top}px`;
        dropdown.style.left = `${left}px`;

        pillBtn.classList.add("is-active");
        activeFolderDropdown = { element: dropdown, pillBtn: pillBtn };

        dropdown.querySelectorAll(".webex-dropdown-item").forEach(dItem => {
            dItem.addEventListener("click", async (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (dItem.dataset.action === "new") {
                    closeFolderDropdownMenu();
                    const name = prompt("Nome della nuova cartella principale:");
                    if (name && name.trim()) {
                        await doCreateFolder("", name.trim());
                        await doMoveLecture(item, name.trim());
                    }
                    return;
                }
                if (dItem.dataset.action === "new-sub") {
                    closeFolderDropdownMenu();
                    const parent = prompt(`Nome della cartella padre in cui creare la sottocartella:`, curFolder);
                    if (parent !== null) {
                        const sub = prompt(`Nome della sottocartella:`);
                        if (sub && sub.trim()) {
                            const full = parent && parent.trim() ? `${parent.trim()}/${sub.trim()}` : sub.trim();
                            await doCreateFolder(parent ? parent.trim() : "", sub.trim());
                            await doMoveLecture(item, full);
                        }
                    }
                    return;
                }

                const targetFolder = dItem.dataset.folder;
                closeFolderDropdownMenu();
                await doMoveLecture(item, targetFolder);
            });
        });
    }

    // ==========================================
    // LECTURE LOADING & PLAYBACK
    // ==========================================
    async function syncTopDropdown() {
        const list = await WebexOfflineDB.listLectures();
        if (topLectureBadge) topLectureBadge.textContent = list.length;
        
        const currentItem = list.find(x => x.id === currentLectureId);
        if (currentItem) {
            if (topLectureTitle) topLectureTitle.textContent = currentItem.title || currentItem.id;
        } else if (list.length > 0) {
            if (topLectureTitle) topLectureTitle.textContent = "Seleziona lezione...";
        } else {
            if (topLectureTitle) topLectureTitle.textContent = "Nessuna lezione in memoria";
        }

        renderTopLectureList(list);

        if (lectureDropdown) {
            lectureDropdown.innerHTML = `<option value="">Seleziona lezione (${list.length})...</option>`;
            list.forEach(item => {
                const opt = document.createElement("option");
                opt.value = item.id;
                opt.textContent = `${item.folder ? `[${item.folder}] ` : ""}${item.title || item.id}`;
                if (item.id === currentLectureId) opt.selected = true;
                lectureDropdown.appendChild(opt);
            });
        }
    }

    async function playSavedLecture(id) {
        currentLectureId = id;
        try {
            const data = await WebexOfflineDB.getLecture(id);
            if (!data || !data.blob) {
                currentLectureTitle = data?.title || id;
                await syncTopDropdown();
                await autoLoadOfflineSubtitles(id, currentLectureTitle);
                emptyState.style.display = "flex";
                const videoFrame = document.getElementById("offline-video-frame");
                if (videoFrame) videoFrame.style.display = "none";
                showHUD("Video non presente in memoria. Trascina qui il file .mp4", "ℹ️");
                return;
            }

            currentLectureTitle = data.title || id;

            // Auto-check if lecture is an old fragmented MP4 that needs remuxing (+faststart)
            if (data.blob && window.Mediabunny) {
                try {
                    const headerBuf = await data.blob.slice(0, 32768).arrayBuffer();
                    const headerStr = String.fromCharCode(...new Uint8Array(headerBuf));
                    if (headerStr.includes("moof") || headerStr.includes("sidx")) {
                        console.log(`[WebexOffline] Lecture '${id}' is fragmented fMP4. Auto-optimizing with Mediabunny...`);
                        showHUD("⚡ Ottimizzazione video (+faststart)...", "⚙️");
                        const { Input, Output, Conversion, ALL_FORMATS, BufferTarget, Mp4OutputFormat, BlobSource } = window.Mediabunny;
                        const input = new Input({
                            formats: ALL_FORMATS,
                            source: new BlobSource(data.blob)
                        });
                        const output = new Output({
                            format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
                            target: new BufferTarget()
                        });
                        const conversion = await Conversion.init({ input, output });
                        if (conversion.isValid) {
                            await conversion.execute();
                            const remuxedBlob = new Blob([output.target.buffer], { type: "video/mp4" });
                            data.blob = remuxedBlob;
                            data.size = remuxedBlob.size;
                            await WebexOfflineDB.saveLecture(data);
                            console.log(`[WebexOffline] Lecture '${id}' successfully remuxed and saved to DB!`);
                            showHUD("✨ Video ottimizzato!", "✅");
                        }
                    }
                } catch (optErr) {
                    console.warn("[WebexOffline] Auto-optimization skipped:", optErr);
                }
            }

            if (activeBlobUrl) {
                try { URL.revokeObjectURL(activeBlobUrl); } catch (_) {}
            }
            activeBlobUrl = URL.createObjectURL(data.blob);
            video.src = activeBlobUrl;
            emptyState.style.display = "none";
            const videoFrame = document.getElementById("offline-video-frame");
            if (videoFrame) videoFrame.style.display = "flex";
            video.style.display = "block";
            video.play().catch(() => {});

            document.title = `⚡ ${currentLectureTitle} - PoliMi Webex Enhancer`;
            showHUD(`Caricata: ${currentLectureTitle}`, "📦");

            await syncTopDropdown();

            // Sync notes & bookmarks from WebexOfflineDB
            try {
                if (window.WebexOfflineDB && typeof WebexOfflineDB.getNotes === "function") {
                    const dbNotes = await WebexOfflineDB.getNotes(id);
                    if (dbNotes && dbNotes.length > 0) {
                        const localNotes = getNotes();
                        if (!localNotes || localNotes.length === 0) {
                            localStorage.setItem(getNotesKey(), JSON.stringify(dbNotes));
                        }
                    }
                }
                if (window.WebexOfflineDB && typeof WebexOfflineDB.getBookmarks === "function") {
                    const dbBms = await WebexOfflineDB.getBookmarks(id);
                    if (dbBms && dbBms.length > 0) {
                        const localBms = getBookmarks();
                        if (!localBms || localBms.length === 0) {
                            localStorage.setItem(getBookmarksKey(), JSON.stringify(dbBms));
                        }
                    }
                }
            } catch (_) {}

            updateBookmarkFlyout();
            renderTimelineMarkers();
            await autoLoadOfflineSubtitles(id, currentLectureTitle);
        } catch (e) {
            console.error("[WebexOffline] Error loading saved lecture:", e);
            showHUD("Errore caricamento lezione", "⚠️");
        }
    }

    if (lectureDropdown) {
        lectureDropdown.onchange = () => {
            if (lectureDropdown.value) playSavedLecture(lectureDropdown.value);
        };
    }

    // Local file input & drag and drop
    const btnOpenFile = document.getElementById("btn-open-file");
    if (btnOpenFile) btnOpenFile.onclick = () => fileInput.click();
    if (dropZone) dropZone.onclick = () => fileInput.click();

    if (fileInput) {
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) playLocalFile(file);
        };
    }

    window.ondragover = (e) => e.preventDefault();
    window.ondrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            const f = e.dataTransfer.files[0];
            const lowerName = f.name.toLowerCase();
            if (lowerName.endsWith(".vtt") || lowerName.endsWith(".srt") || lowerName.endsWith(".sbv")) {
                const reader = new FileReader();
                reader.onload = (evt) => {
                    const parsed = parseOfflineSubtitleText(evt.target.result);
                    if (parsed.length > 0) {
                        loadOfflineSubtitles(parsed, f.name);
                        if (currentLectureId) {
                            try { localStorage.setItem(`webex_subtitles_${currentLectureId}`, JSON.stringify(parsed)); } catch (_) {}
                        }
                    }
                };
                reader.readAsText(f);
            } else {
                playLocalFile(f);
            }
        }
    };

    function playLocalFile(file) {
        currentLectureId = "local_" + file.name;
        currentLectureTitle = file.name;
        const url = URL.createObjectURL(file);
        video.src = url;
        emptyState.style.display = "none";
        const videoFrame = document.getElementById("offline-video-frame");
        if (videoFrame) videoFrame.style.display = "flex";
        video.style.display = "block";
        video.play().catch(() => {});
        document.title = `⚡ ${file.name} - PoliMi Webex Enhancer`;
        showHUD(`File aperto: ${file.name}`, "📁");
        updateBookmarkFlyout();
        renderTimelineMarkers();
        autoLoadOfflineSubtitles(currentLectureId, file.name);
    }

    // ==========================================
    // KEYBOARD SHORTCUTS
    // ==========================================
    function isTypingInInput(e) {
        const active = document.activeElement;
        if (active && (
            active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.tagName === "SELECT" ||
            active.isContentEditable ||
            active.getAttribute("role") === "textbox" ||
            active.getAttribute("role") === "searchbox" ||
            active.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="searchbox"]')
        )) {
            return true;
        }
        const path = e.composedPath ? e.composedPath() : [e.target];
        for (const el of path) {
            if (!el || !el.tagName) continue;
            const tag = el.tagName.toUpperCase();
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
        }
        return false;
    }

    document.addEventListener("keydown", (e) => {
        if (isTypingInInput(e)) return;

        const openModal = document.querySelector(".webex-helper-modal-overlay");
        if (openModal) {
            if (e.key === "Escape") openModal.remove();
            return;
        }

        if (isOfflineSubtitlesOpen) {
            if (e.key === "Escape") {
                toggleOfflineSubtitlesPanel(false);
                return;
            }
        }

        if (e.ctrlKey || e.metaKey) return;

        switch (e.key) {
            case " ":
            case "k":
            case "K":
                e.preventDefault();
                togglePlayPause();
                break;

            case "ArrowRight":
            case "l":
            case "L":
                e.preventDefault();
                seekRelative(e.shiftKey ? 30 : 10);
                break;

            case "ArrowLeft":
            case "j":
            case "J":
                e.preventDefault();
                seekRelative(e.shiftKey ? -30 : -10);
                break;

            case "ArrowUp":
                e.preventDefault();
                changeSpeedRelative(+0.1);
                break;

            case "ArrowDown":
                e.preventDefault();
                changeSpeedRelative(-0.1);
                break;

            case "]":
                e.preventDefault();
                changeSpeedRelative(+0.25);
                break;

            case "[":
                e.preventDefault();
                changeSpeedRelative(-0.25);
                break;

            case "r":
            case "R":
                e.preventDefault();
                setPlaybackSpeed(1.0);
                break;

            case "m":
            case "M":
                e.preventDefault();
                video.muted = !video.muted;
                showHUD(video.muted ? "Muto" : "Audio Attivo", video.muted ? "🔇" : "🔊");
                break;

            case "f":
            case "F":
                e.preventDefault();
                toggleOfflineFullscreen();
                break;

            case "p":
            case "P":
                e.preventDefault();
                togglePiP();
                break;

            case "s":
            case "S":
                e.preventDefault();
                captureScreenshot();
                break;

            case "z":
            case "Z":
                e.preventDefault();
                cycleZoom();
                break;

            case "c":
            case "C":
                e.preventDefault();
                cycleVideoFilter();
                break;

            case "n":
            case "N":
                e.preventDefault();
                showNotesModal();
                break;

            case "h":
            case "H":
                e.preventDefault();
                toggleToolbarCollapse();
                break;

            case "d":
            case "D":
                e.preventDefault();
                addBookmark();
                break;

            case "b":
            case "B":
                e.preventDefault();
                if (e.shiftKey) {
                    addBookmark();
                } else {
                    handleLoopB();
                }
                break;

            case "x":
            case "X":
                e.preventDefault();
                toggleSilenceSkip();
                break;

            case "a":
            case "A":
                e.preventDefault();
                handleLoopA();
                break;

            case "t":
            case "T":
                e.preventDefault();
                toggleOfflineSubtitlesPanel();
                break;
        }
    });

    // Sync when lectures or subtitles are updated/deleted from another tab
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(async (msg) => {
            if (msg.type === "LECTURE_DELETED") {
                if (currentLectureId === msg.lectureId) {
                    video.pause();
                    video.src = "";
                    video.style.display = "none";
                    const videoFrame = document.getElementById("offline-video-frame");
                    if (videoFrame) videoFrame.style.display = "none";
                    emptyState.style.display = "flex";
                }
                await renderExplorerFolders();
                await renderExplorerFiles();
                await syncTopDropdown();
            } else if (msg.type === "BUFFER_PROGRESS" && msg.status === "completed") {
                await renderExplorerFolders();
                await renderExplorerFiles();
                await syncTopDropdown();
                showHUD(`Nuova lezione salvata: ${msg.title || msg.lectureId}`, "📥");
            } else if (msg.type === "SUBTITLES_UPDATED") {
                const curNorm = (currentLectureTitle || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                const msgNorm = (msg.title || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                if (currentLectureId === msg.lectureId || (curNorm && msgNorm && (curNorm.includes(msgNorm) || msgNorm.includes(curNorm)))) {
                    loadOfflineSubtitles(msg.cues, "Sincronizzato da Webex");
                }
            } else if (msg.type === "SUBTITLES_DELETED") {
                const curNorm = (currentLectureTitle || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                const msgNorm = (msg.title || "").toLowerCase().replace(/[^a-z0-9]/g, '');
                if (currentLectureId === msg.lectureId || (curNorm && msgNorm && (curNorm.includes(msgNorm) || msgNorm.includes(curNorm)))) {
                    offlineSubtitles = [];
                    activeCueIdx = -1;
                    renderOfflineSubtitlesEmptyState();
                }
            }
        });
    }

    // Auto-sync when user switches back to offline player tab
    window.addEventListener("focus", async () => {
        try {
            await syncTopDropdown();
            await renderExplorerFolders();
            await renderExplorerFiles();
        } catch (_) {}
        if (currentLectureId || currentLectureTitle) {
            autoLoadOfflineSubtitles(currentLectureId, currentLectureTitle);
        }
    });

    // ==========================================
    // Purge any old fake segment placeholders from localStorage
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && (k.startsWith("webex_subtitles_") || k.startsWith("webex_subtitles_"))) {
                const val = localStorage.getItem(k);
                if (val && (val.includes("[Segmento") || val.includes("Parlato attivo") || val.includes("Spiegazione"))) {
                    localStorage.removeItem(k);
                }
            }
        }
    } catch (_) {}

    // 1. Initial UI render from IndexedDB immediately (never block on external/disk operations)
    await syncTopDropdown();
    await renderExplorerFolders();
    await renderExplorerFiles();
    updateBookmarkFlyout();

    const urlParams = new URLSearchParams(window.location.search);
    const initialId = urlParams.get("id");
    const allSaved = await WebexOfflineDB.listLectures();
    const playableSaved = allSaved.filter(x => (x.size && x.size > 0) || x.isLocalMirror || x.fileHandle || x.blob);

    if (initialId) {
        const found = allSaved.find(x => x.id === initialId || (x.webexRecordingId && x.webexRecordingId === initialId));
        if (found && ((found.size && found.size > 0) || found.isLocalMirror || found.fileHandle || found.blob)) {
            await playSavedLecture(found.id);
        } else if (playableSaved.length > 0) {
            await playSavedLecture(playableSaved[0].id);
        } else if (found) {
            await playSavedLecture(found.id);
        }
    } else if (playableSaved.length > 0) {
        await playSavedLecture(playableSaved[0].id);
    }

    // 2. PC mirror folder persistence runs asynchronously in background
    initPCFolderPersistence().catch(err => console.warn("PC folder init note:", err));
}

// Ensure startup runs whether DOMContentLoaded has already fired or is still loading
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initOfflinePlayer);
} else {
    initOfflinePlayer();
}
