// PoliMi Webex Enhancer - Popup Controller

document.addEventListener("DOMContentLoaded", () => {
    const statusDot = document.getElementById("status-dot");
    const statusText = document.getElementById("status-text");
    const speedLabel = document.getElementById("speed-label");
    const chipBtns = document.querySelectorAll(".chip-btn");

    let currentRecordingId = null;

    function sendToActiveTab(msg, callback) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0] || !tabs[0].id) {
                if (callback) callback(null);
                return;
            }
            chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
                if (chrome.runtime.lastError) {
                    if (callback) callback(null);
                } else {
                    if (callback) callback(response);
                }
            });
        });
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return "00:00";
        const total = Math.floor(seconds);
        const hrs = Math.floor(total / 3600);
        const mins = Math.floor((total % 3600) / 60);
        const secs = total % 60;
        return `${hrs > 0 ? hrs + ':' : ''}${(mins < 10 ? '0' : '') + mins}:${(secs < 10 ? '0' : '') + secs}`;
    }

    function refreshStatus() {
        sendToActiveTab({ type: "GET_STATUS" }, (res) => {
            if (res && res.found) {
                currentRecordingId = res.recordingId;
                statusDot.classList.add("active");
                const timeStr = `${formatTime(res.currentTime)} / ${formatTime(res.duration)}`;
                statusText.innerText = `Connesso: ${timeStr} (${res.paused ? 'Pausa' : 'In Riproduzione'})`;

                const speed = res.playbackRate || 1.0;
                speedLabel.innerText = `${speed.toFixed(2).replace(/\.00$/, '')}x`;

                chipBtns.forEach(btn => {
                    const btnSpeed = parseFloat(btn.dataset.speed);
                    btn.classList.toggle("active", Math.abs(btnSpeed - speed) < 0.03);
                });

                // Advanced study tools status
                const btnZoom = document.getElementById("btn-zoom");
                const labelZoom = document.getElementById("label-zoom");
                if (btnZoom && labelZoom) {
                    const z = res.zoomLevel || 1.0;
                    labelZoom.innerText = z > 1.0 ? `${z.toFixed(1)}x` : 'Zoom';
                    btnZoom.classList.toggle("active", z > 1.0);
                }

                const btnDark = document.getElementById("btn-dark");
                if (btnDark) {
                    btnDark.classList.toggle("active", !!res.isDarkMode);
                }

                const btnContrast = document.getElementById("btn-contrast");
                const labelContrast = document.getElementById("label-contrast");
                if (btnContrast && labelContrast) {
                    const idx = res.currentFilterIndex || 0;
                    labelContrast.innerText = idx > 0 ? (res.filterName ? res.filterName.slice(0, 7) : 'Filtro') : 'Filtro';
                    btnContrast.classList.toggle("active", idx > 0);
                }

                const btnSilence = document.getElementById("btn-silence");
                if (btnSilence) {
                    btnSilence.classList.toggle("active", !!res.isSilenceSkipActive);
                }

                const btnLoop = document.getElementById("btn-loop-ab");
                const labelLoop = document.getElementById("label-loop");
                if (btnLoop && labelLoop) {
                    if (res.isLooping) {
                        labelLoop.innerText = 'Loop ON';
                        btnLoop.classList.add("active");
                    } else if (res.loopA !== null && res.loopA !== undefined) {
                        labelLoop.innerText = 'Punto A';
                        btnLoop.classList.add("active");
                    } else {
                        labelLoop.innerText = 'Loop A-B';
                        btnLoop.classList.remove("active");
                    }
                }

                // Check download status in background
                checkBufferStatus(res.recordingId);
            } else {
                statusDot.classList.remove("active");
                statusText.innerText = "Nessun video rilevato sulla scheda attiva";
            }
        });
    }

    function checkBufferStatus(id) {
        if (!id) return;
        chrome.runtime.sendMessage({
            type: "GET_BUFFER_STATUS",
            lectureId: id
        }, (res) => {
            const progBox = document.getElementById("popup-buffer-progress");
            const fill = document.getElementById("popup-buffer-fill");
            const status = document.getElementById("popup-buffer-status");

            if (res && res.active) {
                if (progBox) progBox.style.display = "block";
                if (fill) fill.style.width = `${res.percent}%`;
                if (status) status.innerText = `📥 ${res.percent}% (${res.recMB}/${res.totMB} MB) • ${res.speedMB} MB/s`;
            } else if (res && res.saved) {
                if (progBox) progBox.style.display = "block";
                if (fill) {
                    fill.style.width = "100%";
                    fill.style.background = "#10b981";
                }
                if (status) {
                    status.innerHTML = `<span style="color:#10b981; font-weight:700;">✅ Lezione salvata in memoria (${res.sizeMB} MB)</span>`;
                }
            }
        });
    }

    // Playback Controls
    document.getElementById("btn-play-pause").onclick = () => {
        sendToActiveTab({ type: "TOGGLE_PLAY" }, () => refreshStatus());
    };

    document.getElementById("btn-seek-back").onclick = () => {
        sendToActiveTab({ type: "SEEK", seconds: -10 }, () => refreshStatus());
    };

    document.getElementById("btn-seek-fwd").onclick = () => {
        sendToActiveTab({ type: "SEEK", seconds: 10 }, () => refreshStatus());
    };

    document.getElementById("btn-screenshot").onclick = () => {
        sendToActiveTab({ type: "SCREENSHOT" });
    };

    document.getElementById("btn-pip").onclick = () => {
        sendToActiveTab({ type: "PIP" });
    };

    document.getElementById("btn-bookmark").onclick = () => {
        sendToActiveTab({ type: "ADD_BOOKMARK" });
    };

    // Advanced Study Controls
    const btnZoom = document.getElementById("btn-zoom");
    if (btnZoom) {
        btnZoom.onclick = () => {
            sendToActiveTab({ type: "TOGGLE_ZOOM" }, () => refreshStatus());
        };
    }

    const btnContrast = document.getElementById("btn-contrast");
    if (btnContrast) {
        btnContrast.onclick = () => {
            sendToActiveTab({ type: "TOGGLE_FILTER" }, () => refreshStatus());
        };
    }

    const btnDark = document.getElementById("btn-dark");
    if (btnDark) {
        btnDark.onclick = () => {
            sendToActiveTab({ type: "TOGGLE_DARK" }, () => refreshStatus());
        };
    }

    const btnSilence = document.getElementById("btn-silence");
    if (btnSilence) {
        btnSilence.onclick = () => {
            sendToActiveTab({ type: "TOGGLE_SILENCE" }, () => refreshStatus());
        };
    }

    const btnLoop = document.getElementById("btn-loop-ab");
    if (btnLoop) {
        btnLoop.onclick = () => {
            sendToActiveTab({ type: "TOGGLE_LOOP" }, () => refreshStatus());
        };
    }

    const btnNotes = document.getElementById("btn-notes");
    if (btnNotes) {
        btnNotes.onclick = () => {
            sendToActiveTab({ type: "OPEN_NOTES" });
            window.close();
        };
    }

    chipBtns.forEach(btn => {
        btn.onclick = () => {
            const speed = parseFloat(btn.dataset.speed);
            sendToActiveTab({ type: "SET_SPEED", speed }, () => refreshStatus());
        };
    });

    // Offline Buffer Actions & Progress Listener
    const bufferSelect = document.getElementById("popup-buffer-select");
    const downloadBufferBtn = document.getElementById("popup-btn-download-buffer");
    const progBox = document.getElementById("popup-buffer-progress");
    const fill = document.getElementById("popup-buffer-fill");
    const status = document.getElementById("popup-buffer-status");

    if (downloadBufferBtn) {
        downloadBufferBtn.onclick = () => {
            const val = bufferSelect.value;
            let fraction = 1.0;
            if (val === "1.0") fraction = 1.0;
            else if (val === "0.5") fraction = 0.5;
            else fraction = parseFloat(val) / 90;

            if (progBox) progBox.style.display = "block";
            if (fill) {
                fill.style.width = "5%";
                fill.style.background = "#38bdf8";
            }
            if (status) status.innerText = "Connessione al flusso video...";

            sendToActiveTab({ type: "START_BUFFER_DOWNLOAD", fraction });
        };
    }

    // Listen for download progress updates from background service worker
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "BUFFER_PROGRESS") {
            if (progBox) progBox.style.display = "block";
            if (msg.status === "downloading") {
                if (fill) fill.style.width = `${msg.percent}%`;
                if (status) status.innerText = `📥 ${msg.percent}% (${msg.recMB}/${msg.totMB} MB) • ${msg.speedMB} MB/s`;
            } else if (msg.status === "completed") {
                if (fill) {
                    fill.style.width = "100%";
                    fill.style.background = "#10b981";
                }
                if (status) {
                    status.innerHTML = `<span style="color:#10b981; font-weight:700;">✅ Buffer pronto per la visione offline!</span>`;
                }
            } else if (msg.status === "error") {
                if (fill) fill.style.background = "#ef4444";
                if (status) status.innerHTML = `<span style="color:#ef4444;">⚠️ ${msg.message || "Errore"}</span>`;
            } else if (msg.status === "cancelled") {
                if (status) status.innerText = "Download annullato.";
            }
        }
    });

    const heroPlayerBtn = document.getElementById("popup-btn-hero-player");
    if (heroPlayerBtn) {
        heroPlayerBtn.onclick = () => {
            chrome.runtime.sendMessage({
                type: "OPEN_OFFLINE_PLAYER",
                lectureId: currentRecordingId
            });
            window.close();
        };
    }

    const openPlayerBtn = document.getElementById("popup-btn-open-player");
    if (openPlayerBtn) {
        openPlayerBtn.onclick = () => {
            sendToActiveTab({ type: "GET_STATUS" }, (res) => {
                chrome.runtime.sendMessage({
                    type: "OPEN_OFFLINE_PLAYER",
                    lectureId: res?.recordingId || currentRecordingId
                });
                window.close();
            });
        };
    }

    const saveMp4Btn = document.getElementById("popup-btn-save-mp4");
    if (saveMp4Btn) {
        saveMp4Btn.onclick = () => {
            sendToActiveTab({ type: "DOWNLOAD_MP4" });
        };
    }

    const emailInput = document.getElementById("input-student-email");
    const saveEmailBtn = document.getElementById("btn-save-email");
    if (emailInput && saveEmailBtn) {
        chrome.storage.local.get(['webex_student_email'], (result) => {
            if (result.webex_student_email) emailInput.value = result.webex_student_email;
        });
        saveEmailBtn.onclick = () => {
            const val = emailInput.value.trim();
            chrome.storage.local.set({ webex_student_email: val }, () => {
                const oldText = saveEmailBtn.innerText;
                saveEmailBtn.innerText = "Salvato! ✔";
                saveEmailBtn.style.color = "#10b981";
                setTimeout(() => {
                    saveEmailBtn.innerText = oldText;
                    saveEmailBtn.style.color = "";
                }, 1500);
            });
        };
    }

    refreshStatus();
});
