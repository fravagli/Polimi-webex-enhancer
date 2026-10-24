/**
 * PoliMi Webex Enhancer - audio_enhancer.js
 * Motore avanzato di elaborazione audio in tempo reale:
 * 1. Safe Lazy Hooking: NON intercetta mai il video finché l'utente non attiva un filtro o il boost.
 * 2. Master On/Off Switch: Bypass istantaneo trasparente a latenza zero tramite bypassGain.
 * 3. Filtri DSP a pendenza ripida 24 dB/ottava (High-Pass 50-1200 Hz, Low-Pass 1000-12000 Hz).
 * 4. Peaking EQ Presenza Vocale (2500 Hz): Migliora l'intelligibilità e la chiarezza della voce del docente.
 * 5. Noise Gate dinamico nativo Web Audio: Silenziamento del rumore residuo/ventole nelle pause (-65 a -20 dB).
 * 6. Soppressione neurale AI (RNNoise WASM 48kHz): Deep learning per isolare la voce, con fallback trasparente.
 * 7. Volume Boost integrato fino al 300% (1.0x - 3.0x).
 */

(function () {
    if (window.__polimiAudioEnhancer) {
        return;
    }

    class AudioEnhancerEngine {
        constructor() {
            this.audioCtx = null;
            this.inputMixer = null;
            this.bypassGain = null;
            this.attachedMediaElements = new WeakSet();
            this.currentVideo = null;

            // Pipeline Nodes
            this.highpassNode1 = null;
            this.highpassNode2 = null;
            this.clarityNode = null;
            this.lowpassNode1 = null;
            this.lowpassNode2 = null;
            this.rnnoiseNode = null;
            this.rnnoiseDryGain = null;
            this.rnnoiseWetGain = null;
            this.noiseMixer = null;
            this.gateGain = null;
            this.filterChainGain = null;
            this.gainNode = null;
            this.sourceNode = null;
            this.silenceAnalyser = null;
            this.silenceDataArray = null;

            // Dynamic Gate Loop
            this.gateIntervalId = null;

            // Flags
            this.isWorkletLoaded = false;
            this.isWorkletLoading = false;
            this.isInitialized = false;
            this.wasmBinary = null;

            // Settings
            this.settings = {
                masterEnabled: false,
                rnnoiseEnabled: false,
                dspMasterEnabled: true,
                highpassEnabled: false,
                highpassFreq: 140, // Hz (50 - 1200 Hz)
                lowpassEnabled: false,
                lowpassFreq: 4500, // Hz (1000 - 12000 Hz)
                noiseGateEnabled: false,
                noiseGateThreshold: -42, // dB (-65 a -20 dB)
                volumeBoost: 1.0,
                preset: 'none'
            };

            this.listeners = [];
            this.loadStoredSettings();
            this.setupGlobalListeners();
        }

        setupGlobalListeners() {
            // Auto-resume AudioContext ed eventuale aggancio sicuro SOLO in risposta a un gesto utente (click/tasto)
            const userGestureHandler = () => {
                this.resumeContext();
                if (this.isAnyFilterActive()) {
                    const vid = this.currentVideo || (typeof getPrimaryVideo === "function" ? getPrimaryVideo() : document.querySelector("video"));
                    if (vid && !this.attachedMediaElements.has(vid)) {
                        this.currentVideo = vid;
                        this.attachMedia(vid);
                    }
                }
            };
            window.addEventListener("click", userGestureHandler, { capture: true, passive: true });
            window.addEventListener("keydown", userGestureHandler, { capture: true, passive: true });
        }

        loadStoredSettings() {
            try {
                if (typeof chrome !== "undefined" && chrome.runtime?.id && chrome.storage?.local) {
                    chrome.storage.local.get(["polimi_audio_filters"], (res) => {
                        if (typeof chrome === "undefined" || !chrome.runtime?.id || chrome.runtime?.lastError) return;
                        if (res && res.polimi_audio_filters) {
                            Object.assign(this.settings, res.polimi_audio_filters);
                            if (typeof this.settings.masterEnabled === "undefined") {
                                this.settings.masterEnabled = !!(this.settings.rnnoiseEnabled || this.settings.highpassEnabled || this.settings.lowpassEnabled || this.settings.noiseGateEnabled);
                            }
                            if (typeof this.settings.dspMasterEnabled === "undefined") {
                                this.settings.dspMasterEnabled = true;
                            }
                            if (!this.settings.highpassFreq || this.settings.highpassFreq < 50 || this.settings.highpassFreq > 1200) {
                                this.settings.highpassFreq = 140;
                            }
                            if (!this.settings.lowpassFreq || this.settings.lowpassFreq < 1000 || this.settings.lowpassFreq > 12000) {
                                this.settings.lowpassFreq = 4500;
                            }
                            this.notifyChange();
                            // Non agganciamo il media element sul load asincrono per rispettare l'Autoplay policy
                            // L'aggancio avverrà al primo click dell'utente (o pressione play) in userGestureHandler
                        }
                    });
                }
            } catch (_) {}
        }

        saveSettings() {
            try {
                if (typeof chrome !== "undefined" && chrome.runtime?.id && chrome.storage?.local) {
                    chrome.storage.local.set({ polimi_audio_filters: this.settings }, () => {
                        if (typeof chrome === "undefined" || !chrome.runtime?.id || chrome.runtime?.lastError) return;
                    });
                }
            } catch (_) {}
            this.notifyChange();
        }

        subscribe(cb) {
            if (typeof cb === "function") {
                this.listeners.push(cb);
                cb(this.settings);
            }
        }

        notifyChange() {
            for (const cb of this.listeners) {
                try { cb(this.settings); } catch (_) {}
            }
        }

        resumeContext() {
            if (this.audioCtx && this.audioCtx.state === "suspended") {
                this.audioCtx.resume().catch(() => {});
            }
        }

        hasActiveFilters() {
            if (!this.settings || !this.settings.masterEnabled) {
                return false;
            }
            const dspActive = !!this.settings.dspMasterEnabled && !!(
                this.settings.highpassEnabled || 
                this.settings.lowpassEnabled || 
                this.settings.noiseGateEnabled
            );
            return !!(this.settings.rnnoiseEnabled || dspActive);
        }

        isAnyFilterActive() {
            return this.hasActiveFilters() || (this.settings.volumeBoost || 1.0) > 1.0;
        }

        getActiveVideo() {
            if (this.currentVideo && document.contains(this.currentVideo)) {
                return this.currentVideo;
            }
            if (typeof getPrimaryVideo === "function") {
                const vid = getPrimaryVideo();
                if (vid) {
                    this.currentVideo = vid;
                    return vid;
                }
            }
            const fallbackVid = document.querySelector("video");
            if (fallbackVid) {
                this.currentVideo = fallbackVid;
                return fallbackVid;
            }
            return null;
        }

        attachVideo(video, force = false) {
            const targetVid = video || this.getActiveVideo();
            if (!targetVid) return;
            this.currentVideo = targetVid;
            // Safe Lazy Hooking: Non intercettare mai il media element se l'utente non ha attivato alcun filtro, a meno di richiesta esplicita (es. silence detector)
            if (!force && !this.isAnyFilterActive()) {
                return;
            }
            this.attachMedia(targetVid, force);
        }

        attachMedia(mediaEl, force = false) {
            if (!mediaEl || !(mediaEl instanceof HTMLMediaElement)) return;
            if (!force && !this.isAnyFilterActive()) return;
            if (this.attachedMediaElements.has(mediaEl)) {
                if (mediaEl.__polimiSourceNode) {
                    this.sourceNode = mediaEl.__polimiSourceNode;
                }
                this.resumeContext();
                return;
            }

            this.ensureAudioContext();
            if (!this.audioCtx) return;

            // Assicurati che l'AudioContext sia running PRIMA di agganciare il media element
            this.resumeContext();

            if (!this.isInitialized) {
                this.initPipeline();
            }

            try {
                if (!mediaEl.__polimiSourceNode) {
                    mediaEl.__polimiSourceNode = this.audioCtx.createMediaElementSource(mediaEl);
                }
                const src = mediaEl.__polimiSourceNode;
                this.sourceNode = src;
                this.attachedMediaElements.add(mediaEl);

                if (this.inputMixer) {
                    src.connect(this.inputMixer);
                }
                if (this.silenceAnalyser) {
                    src.connect(this.silenceAnalyser);
                }

                // Auto-resume AudioContext su play o playing del video per prevenire freeze del buffer
                const onPlayOrPlaying = () => {
                    this.resumeContext();
                };
                mediaEl.addEventListener("play", onPlayOrPlaying, { passive: true });
                mediaEl.addEventListener("playing", onPlayOrPlaying, { passive: true });

                console.debug("[PoliMiAudioEnhancer] Hooked media track safely:", mediaEl.tagName);
            } catch (err) {
                console.debug("[PoliMiAudioEnhancer] attachMedia info:", err);
            }
        }

        ensureAudioContext() {
            if (!this.audioCtx) {
                const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtxClass) return;
                try {
                    this.audioCtx = new AudioCtxClass({ sampleRate: 48000 });
                } catch (_) {
                    this.audioCtx = new AudioCtxClass();
                }
            }
            this.resumeContext();
        }

        initPipeline() {
            if (this.isInitialized && this.inputMixer) return;
            try {
                this.ensureAudioContext();
                if (!this.audioCtx) return;

                // 1. Input Stage (Input Mixer)
                this.inputMixer = this.audioCtx.createGain();

                // 2. Output Boost Stage (GainNode) collegato alla destinazione
                this.gainNode = this.audioCtx.createGain();
                this.gainNode.gain.setValueAtTime(this.settings.volumeBoost || 1.0, this.audioCtx.currentTime);
                this.gainNode.connect(this.audioCtx.destination);

                // 3. Bypass Diretto (A latenza zero quando masterEnabled è OFF)
                this.bypassGain = this.audioCtx.createGain();
                this.inputMixer.connect(this.bypassGain);
                this.bypassGain.connect(this.gainNode);

                // 4. Analizzatore di spettro & silenzio
                this.silenceAnalyser = this.audioCtx.createAnalyser();
                this.silenceAnalyser.fftSize = 512;
                this.silenceAnalyser.smoothingTimeConstant = 0.2;
                this.silenceDataArray = new Uint8Array(this.silenceAnalyser.frequencyBinCount);

                // 5. Filtro Passa-Alto a cascata 24 dB/ottava (2 biquad in serie)
                this.highpassNode1 = this.audioCtx.createBiquadFilter();
                this.highpassNode1.type = "highpass";
                this.highpassNode1.Q.setValueAtTime(1.0, this.audioCtx.currentTime);

                this.highpassNode2 = this.audioCtx.createBiquadFilter();
                this.highpassNode2.type = "highpass";
                this.highpassNode2.Q.setValueAtTime(1.0, this.audioCtx.currentTime);

                // 6. Peaking EQ Presenza Vocale (2500 Hz): chiarezza vocale immediata
                this.clarityNode = this.audioCtx.createBiquadFilter();
                this.clarityNode.type = "peaking";
                this.clarityNode.frequency.setValueAtTime(2500, this.audioCtx.currentTime);
                this.clarityNode.Q.setValueAtTime(1.1, this.audioCtx.currentTime);

                // 7. Filtro Passa-Basso a cascata 24 dB/ottava (2 biquad in serie)
                this.lowpassNode1 = this.audioCtx.createBiquadFilter();
                this.lowpassNode1.type = "lowpass";
                this.lowpassNode1.Q.setValueAtTime(1.0, this.audioCtx.currentTime);

                this.lowpassNode2 = this.audioCtx.createBiquadFilter();
                this.lowpassNode2.type = "lowpass";
                this.lowpassNode2.Q.setValueAtTime(1.0, this.audioCtx.currentTime);

                // 8. RNNoise Dry / Wet nodes & Mixer intermedio
                this.rnnoiseDryGain = this.audioCtx.createGain();
                this.rnnoiseWetGain = this.audioCtx.createGain();
                this.noiseMixer = this.audioCtx.createGain();

                // 9. Native Web Audio Dynamic Noise Gate
                this.gateGain = this.audioCtx.createGain();
                this.gateGain.gain.setValueAtTime(1.0, this.audioCtx.currentTime);

                // 10. Filter Chain Output Gain (Crossfade con bypassGain)
                this.filterChainGain = this.audioCtx.createGain();
                this.filterChainGain.gain.setValueAtTime(this.settings.masterEnabled ? 1.0 : 0.0, this.audioCtx.currentTime);

                // Connessione della catena filtri:
                // inputMixer -> highpass1 -> highpass2 -> clarityNode -> lowpass1 -> lowpass2 -> [RNNoise stage] -> noiseMixer -> gateGain -> filterChainGain -> gainNode -> destination
                this.inputMixer.connect(this.highpassNode1);
                this.highpassNode1.connect(this.highpassNode2);
                this.highpassNode2.connect(this.clarityNode);
                this.clarityNode.connect(this.lowpassNode1);
                this.lowpassNode1.connect(this.lowpassNode2);

                this.lowpassNode2.connect(this.rnnoiseDryGain);
                this.rnnoiseDryGain.connect(this.noiseMixer);

                this.noiseMixer.connect(this.gateGain);
                this.gateGain.connect(this.filterChainGain);
                this.filterChainGain.connect(this.gainNode);

                this.isInitialized = true;

                this.updateAllNodes();
                this.startGateLoop();

                // Se c'è già un video pronto e filtri attivi, collegalo
                if (this.currentVideo && this.isAnyFilterActive()) {
                    this.attachMedia(this.currentVideo);
                }

                if (this.settings.masterEnabled && this.settings.rnnoiseEnabled) {
                    this.ensureWorklets();
                }
            } catch (err) {
                console.debug("[PoliMiAudioEnhancer] initPipeline note:", err);
            }
        }

        startGateLoop() {
            if (this.gateIntervalId) return;
            const dataArr = new Uint8Array(256);

            this.gateIntervalId = setInterval(() => {
                if (!this.audioCtx || !this.gateGain || !this.silenceAnalyser) return;
                const isGateEffective = this.settings.masterEnabled && this.settings.dspMasterEnabled && this.settings.noiseGateEnabled;

                if (!isGateEffective) {
                    this.gateGain.gain.setTargetAtTime(1.0, this.audioCtx.currentTime, 0.02);
                    return;
                }

                this.silenceAnalyser.getByteTimeDomainData(dataArr);
                let sumSquares = 0;
                for (let i = 0; i < dataArr.length; i++) {
                    const norm = (dataArr[i] - 128) / 128;
                    sumSquares += norm * norm;
                }
                const rms = Math.sqrt(sumSquares / dataArr.length);
                const db = rms > 0.00001 ? 20 * Math.log10(rms) : -100;
                const thresh = this.settings.noiseGateThreshold || -42;
                const now = this.audioCtx.currentTime;

                if (db < thresh) {
                    // Silenzio/pausa: attenua fortemente il rumore d'aula (-28 dB)
                    this.gateGain.gain.setTargetAtTime(0.04, now, 0.045);
                } else {
                    // Voce attiva: apertura ultra-rapida e trasparente (8ms)
                    this.gateGain.gain.setTargetAtTime(1.0, now, 0.008);
                }
            }, 30);
        }

        async ensureWorklets() {
            if (this.isWorkletLoaded || this.isWorkletLoading || !this.audioCtx) return;
            this.isWorkletLoading = true;
            try {
                let isWasmAllowed = false;
                try {
                    const testWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
                    isWasmAllowed = typeof WebAssembly !== "undefined" && WebAssembly.validate(testWasm);
                } catch (_) {
                    isWasmAllowed = false;
                }

                if (!isWasmAllowed) {
                    console.debug("[PoliMiAudioEnhancer] WebAssembly limitato dalla pagina. Motore DSP nativo (High-Pass, Low-Pass, Peaking, Dynamic Gate) attivo.");
                    this.isWorkletLoading = false;
                    this.isWorkletLoaded = false;
                    this.settings.rnnoiseEnabled = false;
                    this.updateRNNoiseRouting();
                    this.notifyChange();
                    return;
                }

                const wasmUrl = (typeof chrome !== "undefined" && chrome.runtime?.id) ?
                    chrome.runtime.getURL("rnnoise.wasm") : "rnnoise.wasm";

                const wasmRes = await fetch(wasmUrl);
                this.wasmBinary = await wasmRes.arrayBuffer();

                const workletUrl = (typeof chrome !== "undefined" && chrome.runtime?.id) ?
                    chrome.runtime.getURL("rnnoise_worklet.js") : "rnnoise_worklet.js";

                await this.audioCtx.audioWorklet.addModule(workletUrl);
                this.isWorkletLoaded = true;
                this.isWorkletLoading = false;

                this.createRNNoiseNode();
            } catch (err) {
                console.debug("[PoliMiAudioEnhancer] AudioWorklet notice (gestito con fallback DSP):", err);
                this.isWorkletLoading = false;
                this.isWorkletLoaded = false;
                this.updateRNNoiseRouting();
                this.notifyChange();
            }
        }

        createRNNoiseNode() {
            if (!this.audioCtx || !this.isWorkletLoaded || !this.wasmBinary || !this.lowpassNode2) return;
            try {
                if (this.rnnoiseNode) {
                    try { this.rnnoiseNode.disconnect(); } catch (_) {}
                }

                this.rnnoiseNode = new AudioWorkletNode(this.audioCtx, "@sapphi-red/web-noise-suppressor/rnnoise", {
                    processorOptions: {
                        maxChannels: 2,
                        wasmBinary: this.wasmBinary
                    }
                });

                this.rnnoiseNode.port.onmessage = (msg) => {
                    if (msg.data && msg.data.type === 'error') {
                        console.debug("[PoliMiAudioEnhancer] RNNoise worklet fallback:", msg.data.error);
                        this.updateRNNoiseRouting();
                    }
                };

                this.lowpassNode2.connect(this.rnnoiseNode);
                this.rnnoiseNode.connect(this.rnnoiseWetGain);
                this.rnnoiseWetGain.connect(this.noiseMixer);

                this.updateRNNoiseRouting();
            } catch (e) {
                console.debug("[PoliMiAudioEnhancer] createRNNoiseNode info:", e);
            }
        }

        updateRNNoiseRouting() {
            if (!this.audioCtx || !this.rnnoiseDryGain || !this.rnnoiseWetGain) return;
            const now = this.audioCtx.currentTime;
            const isEffective = this.settings.masterEnabled && this.settings.rnnoiseEnabled && !!this.rnnoiseNode;
            this.rnnoiseWetGain.gain.setValueAtTime(isEffective ? 1 : 0, now);
            this.rnnoiseDryGain.gain.setValueAtTime(isEffective ? 0 : 1, now);
        }

        updateAllNodes() {
            if (!this.audioCtx) return;
            const now = this.audioCtx.currentTime;
            const isMaster = this.settings.masterEnabled;
            const isDsp = isMaster && this.settings.dspMasterEnabled;

            // 1. Master Crossfade Routing:
            // Se Master è attivo: bypassGain = 0, filterChainGain = 1 (suona la catena filtri elaborata)
            // Se Master è disattivato: bypassGain = 1, filterChainGain = 0 (suono puro nativo passante senza elaborazione)
            if (this.bypassGain) {
                this.bypassGain.gain.setValueAtTime(isMaster ? 0 : 1, now);
            }
            if (this.filterChainGain) {
                this.filterChainGain.gain.setValueAtTime(isMaster ? 1 : 0, now);
            }

            // 2. High-Pass (Cascade 24 dB/ottava)
            if (this.highpassNode1 && this.highpassNode2) {
                const hpEffective = isDsp && this.settings.highpassEnabled;
                const hpFreq = hpEffective ? (this.settings.highpassFreq || 140) : 10;
                this.highpassNode1.frequency.setValueAtTime(hpFreq, now);
                this.highpassNode2.frequency.setValueAtTime(hpFreq, now);
            }

            // 3. Low-Pass (Cascade 24 dB/ottava)
            if (this.lowpassNode1 && this.lowpassNode2) {
                const lpEffective = isDsp && this.settings.lowpassEnabled;
                const lpFreq = lpEffective ? (this.settings.lowpassFreq || 4500) : 22050;
                this.lowpassNode1.frequency.setValueAtTime(lpFreq, now);
                this.lowpassNode2.frequency.setValueAtTime(lpFreq, now);
            }

            // 4. Clarity EQ
            if (this.clarityNode) {
                const clarityEffective = isMaster && (this.settings.preset === 'clear_voice' || (isDsp && this.settings.highpassEnabled));
                this.clarityNode.gain.setValueAtTime(clarityEffective ? 4.0 : 0.0, now);
            }

            // 5. RNNoise Routing
            this.updateRNNoiseRouting();

            // 6. Gate Gain
            if (this.gateGain) {
                const gateEffective = isDsp && this.settings.noiseGateEnabled;
                if (!gateEffective) {
                    this.gateGain.gain.setValueAtTime(1.0, now);
                }
            }
        }

        // ==========================================
        // PUBLIC API
        // ==========================================

        async setMasterEnabled(enabled) {
            this.settings.masterEnabled = !!enabled;
            this.resumeContext();
            if (this.settings.masterEnabled) {
                if (!this.isInitialized) {
                    this.initPipeline();
                }
                const vid = this.getActiveVideo();
                if (vid) {
                    this.attachMedia(vid);
                }
                if (this.settings.rnnoiseEnabled) {
                    await this.ensureWorklets();
                }
            }
            this.updateAllNodes();
            this.saveSettings();
        }

        async setDspMaster(enabled) {
            this.settings.dspMasterEnabled = !!enabled;
            this.resumeContext();
            if (this.settings.dspMasterEnabled && !this.isInitialized) {
                this.initPipeline();
            }
            const vid = this.getActiveVideo();
            if (vid && this.isAnyFilterActive()) {
                this.attachMedia(vid);
            }
            this.updateAllNodes();
            this.saveSettings();
        }

        async setRNNoise(enabled) {
            this.settings.rnnoiseEnabled = !!enabled;
            if (enabled) {
                this.settings.masterEnabled = true;
            }
            this.settings.preset = 'custom';
            this.resumeContext();
            if (enabled && !this.isInitialized) {
                this.initPipeline();
            }
            const vid = this.getActiveVideo();
            if (vid && this.isAnyFilterActive()) {
                this.attachMedia(vid);
            }
            if (enabled && !this.isWorkletLoaded) {
                await this.ensureWorklets();
            }
            this.updateAllNodes();
            this.saveSettings();
        }

        setHighPass(enabled, freq) {
            this.settings.highpassEnabled = !!enabled;
            if (typeof freq === "number") this.settings.highpassFreq = Math.max(50, Math.min(1200, freq));
            if (enabled) {
                this.settings.masterEnabled = true;
                this.settings.dspMasterEnabled = true;
            }
            this.settings.preset = 'custom';
            this.resumeContext();
            if (enabled && !this.isInitialized) {
                this.initPipeline();
            }
            const vid = this.getActiveVideo();
            if (vid && this.isAnyFilterActive()) {
                this.attachMedia(vid);
            }
            this.updateAllNodes();
            this.saveSettings();
        }

        setLowPass(enabled, freq) {
            this.settings.lowpassEnabled = !!enabled;
            if (typeof freq === "number") this.settings.lowpassFreq = Math.max(1000, Math.min(12000, freq));
            if (enabled) {
                this.settings.masterEnabled = true;
                this.settings.dspMasterEnabled = true;
            }
            this.settings.preset = 'custom';
            this.resumeContext();
            if (enabled && !this.isInitialized) {
                this.initPipeline();
            }
            const vid = this.getActiveVideo();
            if (vid && this.isAnyFilterActive()) {
                this.attachMedia(vid);
            }
            this.updateAllNodes();
            this.saveSettings();
        }

        setNoiseGate(enabled, threshold) {
            this.settings.noiseGateEnabled = !!enabled;
            if (typeof threshold === "number") this.settings.noiseGateThreshold = Math.max(-65, Math.min(-20, threshold));
            if (enabled) {
                this.settings.masterEnabled = true;
                this.settings.dspMasterEnabled = true;
            }
            this.settings.preset = 'custom';
            this.resumeContext();
            if (enabled && !this.isInitialized) {
                this.initPipeline();
            }
            const vid = this.getActiveVideo();
            if (vid && this.isAnyFilterActive()) {
                this.attachMedia(vid);
            }
            this.updateAllNodes();
            this.saveSettings();
        }

        setVolumeBoost(mult) {
            this.settings.volumeBoost = Math.max(1.0, Math.min(3.0, mult));
            this.resumeContext();
            if (this.settings.volumeBoost > 1.0 && !this.isInitialized) {
                this.initPipeline();
            }
            const vid = this.getActiveVideo();
            if (vid && this.isAnyFilterActive()) {
                this.attachMedia(vid);
            }
            if (this.gainNode && this.audioCtx) {
                this.gainNode.gain.setValueAtTime(this.settings.volumeBoost, this.audioCtx.currentTime);
            }
            this.saveSettings();
        }

        async applyPreset(presetName) {
            this.settings.masterEnabled = true;
            switch (presetName) {
                case "clear_voice":
                    this.settings.rnnoiseEnabled = true;
                    this.settings.dspMasterEnabled = true;
                    this.settings.highpassEnabled = true;
                    this.settings.highpassFreq = 160;
                    this.settings.lowpassEnabled = true;
                    this.settings.lowpassFreq = 5000;
                    this.settings.noiseGateEnabled = false;
                    this.settings.preset = "clear_voice";
                    break;
                case "noisy_room":
                    this.settings.rnnoiseEnabled = true;
                    this.settings.dspMasterEnabled = true;
                    this.settings.highpassEnabled = true;
                    this.settings.highpassFreq = 220;
                    this.settings.lowpassEnabled = true;
                    this.settings.lowpassFreq = 3800;
                    this.settings.noiseGateEnabled = true;
                    this.settings.noiseGateThreshold = -40;
                    this.settings.preset = "noisy_room";
                    break;
                case "light_filters":
                    this.settings.rnnoiseEnabled = false;
                    this.settings.dspMasterEnabled = true;
                    this.settings.highpassEnabled = true;
                    this.settings.highpassFreq = 140;
                    this.settings.lowpassEnabled = true;
                    this.settings.lowpassFreq = 4800;
                    this.settings.noiseGateEnabled = true;
                    this.settings.noiseGateThreshold = -44;
                    this.settings.preset = "light_filters";
                    break;
            }

            this.resumeContext();
            if (!this.isInitialized) this.initPipeline();
            const vid = this.getActiveVideo();
            if (vid) {
                this.attachMedia(vid);
            }
            if (this.settings.rnnoiseEnabled) {
                await this.ensureWorklets();
            }

            this.updateAllNodes();
            this.saveSettings();
        }

        getSilenceAnalyser() {
            if (!this.silenceAnalyser) {
                this.initPipeline();
            }
            return {
                analyser: this.silenceAnalyser,
                dataArray: this.silenceDataArray
            };
        }

        getSettings() {
            return { ...this.settings };
        }
    }

    window.PoliMiAudioEnhancer = AudioEnhancerEngine;
    window.__polimiAudioEnhancer = new AudioEnhancerEngine();
})();
