/**
 * PoliMi Webex Enhancer - audio_enhancer.js
 * Motore avanzato di elaborazione audio in tempo reale:
 * 1. Soppressione del rumore neurale AI tramite RNNoise compilato in WebAssembly (WASM).
 * 2. Filtro Passa-Alto (High-Pass) anti-ronzio e rombo a bassa frequenza (50/60 Hz).
 * 3. Filtro Passa-Basso (Low-Pass / De-Hiss) anti-fruscio e sibili acuti.
 * 4. Noise Gate dinamico per silenziare il rumore di fondo dell'aula durante le pause del docente.
 * 5. Controllo volume boost unificato (100% - 300%) e analizzatore di silenzio per il salto pause.
 */

(function () {
    if (window.__polimiAudioEnhancer) {
        return;
    }

    class AudioEnhancerEngine {
        constructor() {
            this.audioCtx = null;
            this.sourceNode = null;
            this.currentVideo = null;

            // Pipeline Nodes
            this.highpassNode = null;
            this.lowpassNode = null;
            this.rnnoiseNode = null;
            this.rnnoiseDryGain = null;
            this.rnnoiseWetGain = null;
            this.noiseGateNode = null;
            this.gateDryGain = null;
            this.gateWetGain = null;
            this.gainNode = null;
            this.silenceAnalyser = null;
            this.silenceDataArray = null;

            // Flags
            this.isWorkletLoaded = false;
            this.isWorkletLoading = false;
            this.isInitialized = false;
            this.wasmBinary = null;

            // Settings
            this.settings = {
                rnnoiseEnabled: false,
                highpassEnabled: false,
                highpassFreq: 90,
                lowpassEnabled: false,
                lowpassFreq: 8000,
                noiseGateEnabled: false,
                noiseGateThreshold: -45, // dB
                volumeBoost: 1.0,
                preset: 'none'
            };

            this.listeners = [];
            this.loadStoredSettings();
        }

        loadStoredSettings() {
            try {
                if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.get(["polimi_audio_filters"], (res) => {
                        if (res && res.polimi_audio_filters) {
                            Object.assign(this.settings, res.polimi_audio_filters);
                            this.notifyChange();
                            if (this.isAnyFilterActive() && this.currentVideo) {
                                this.initPipeline();
                            }
                        }
                    });
                }
            } catch (e) {
                console.warn("[PoliMiAudioEnhancer] Load settings error:", e);
            }
        }

        saveSettings() {
            try {
                if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                    chrome.storage.local.set({ polimi_audio_filters: this.settings });
                }
            } catch (e) {
                console.warn("[PoliMiAudioEnhancer] Save settings error:", e);
            }
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

        isAnyFilterActive() {
            return this.settings.rnnoiseEnabled ||
                this.settings.highpassEnabled ||
                this.settings.lowpassEnabled ||
                this.settings.noiseGateEnabled ||
                this.settings.volumeBoost > 1.0;
        }

        attachVideo(video) {
            if (!video) return;
            if (this.currentVideo === video && this.audioCtx) {
                if (this.audioCtx.state === "suspended") {
                    this.audioCtx.resume().catch(() => {});
                }
                return;
            }

            this.currentVideo = video;
            if (this.isAnyFilterActive()) {
                this.initPipeline();
            }

            // Auto-resume AudioContext on user play
            video.addEventListener("play", () => {
                if (this.audioCtx && this.audioCtx.state === "suspended") {
                    this.audioCtx.resume().catch(() => {});
                }
            }, { passive: true });
        }

        async initPipeline() {
            if (!this.currentVideo) return;
            try {
                const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtxClass) return;

                if (!this.audioCtx) {
                    // RNNoise operates natively at 48kHz. Chrome auto-resamples to/from hardware.
                    try {
                        this.audioCtx = new AudioCtxClass({ sampleRate: 48000 });
                    } catch (_) {
                        this.audioCtx = new AudioCtxClass();
                    }
                }

                if (this.audioCtx.state === "suspended") {
                    this.audioCtx.resume().catch(() => {});
                }

                if (!this.sourceNode) {
                    // Cache source node on media element to prevent InvalidStateError
                    if (!this.currentVideo.__polimiSourceNode) {
                        this.currentVideo.__polimiSourceNode = this.audioCtx.createMediaElementSource(this.currentVideo);
                    }
                    this.sourceNode = this.currentVideo.__polimiSourceNode;
                }

                if (!this.gainNode) {
                    this.gainNode = this.audioCtx.createGain();
                    this.gainNode.gain.setValueAtTime(this.settings.volumeBoost || 1.0, this.audioCtx.currentTime);
                }

                if (!this.silenceAnalyser) {
                    this.silenceAnalyser = this.audioCtx.createAnalyser();
                    this.silenceAnalyser.fftSize = 512;
                    this.silenceAnalyser.smoothingTimeConstant = 0.2;
                    this.silenceDataArray = new Uint8Array(this.silenceAnalyser.frequencyBinCount);
                }

                // 1. High-Pass Filter (Anti-Rumble/Hum)
                if (!this.highpassNode) {
                    this.highpassNode = this.audioCtx.createBiquadFilter();
                    this.highpassNode.type = "highpass";
                    this.updateHighpassNode();
                }

                // 2. Low-Pass Filter (Anti-Hiss/Treble)
                if (!this.lowpassNode) {
                    this.lowpassNode = this.audioCtx.createBiquadFilter();
                    this.lowpassNode.type = "lowpass";
                    this.updateLowpassNode();
                }

                // 3. RNNoise Dry/Wet crossfade nodes
                if (!this.rnnoiseDryGain) {
                    this.rnnoiseDryGain = this.audioCtx.createGain();
                    this.rnnoiseWetGain = this.audioCtx.createGain();
                    this.rnnoiseDryGain.gain.setValueAtTime(this.settings.rnnoiseEnabled ? 0 : 1, this.audioCtx.currentTime);
                    this.rnnoiseWetGain.gain.setValueAtTime(this.settings.rnnoiseEnabled ? 1 : 0, this.audioCtx.currentTime);
                }

                // 4. Noise Gate Dry/Wet crossfade nodes
                if (!this.gateDryGain) {
                    this.gateDryGain = this.audioCtx.createGain();
                    this.gateWetGain = this.audioCtx.createGain();
                    this.gateDryGain.gain.setValueAtTime(this.settings.noiseGateEnabled ? 0 : 1, this.audioCtx.currentTime);
                    this.gateWetGain.gain.setValueAtTime(this.settings.noiseGateEnabled ? 1 : 0, this.audioCtx.currentTime);
                }

                // Build Base Routing:
                // sourceNode -> highpassNode -> lowpassNode -> rnnoiseDryGain -> gateDryGain -> gainNode -> destination
                try {
                    this.sourceNode.disconnect();
                } catch (_) {}

                this.sourceNode.connect(this.highpassNode);
                this.sourceNode.connect(this.silenceAnalyser); // for silence skip

                this.highpassNode.connect(this.lowpassNode);

                // RNNoise stage
                this.lowpassNode.connect(this.rnnoiseDryGain);
                this.rnnoiseDryGain.connect(this.gateDryGain);

                // Noise Gate stage
                this.gateDryGain.connect(this.gainNode);
                this.gainNode.connect(this.audioCtx.destination);

                this.isInitialized = true;

                // Load AudioWorklet for RNNoise and NoiseGate if needed
                if (this.settings.rnnoiseEnabled || this.settings.noiseGateEnabled) {
                    this.ensureWorklets();
                }
            } catch (err) {
                console.error("[PoliMiAudioEnhancer] initPipeline error:", err);
            }
        }

        async ensureWorklets() {
            if (this.isWorkletLoaded || this.isWorkletLoading || !this.audioCtx) return;
            this.isWorkletLoading = true;
            try {
                // Fetch WASM binary
                const wasmUrl = (typeof chrome !== "undefined" && chrome.runtime) ?
                    chrome.runtime.getURL("rnnoise.wasm") : "rnnoise.wasm";

                const wasmRes = await fetch(wasmUrl);
                this.wasmBinary = await wasmRes.arrayBuffer();

                // Add AudioWorklet module
                const workletUrl = (typeof chrome !== "undefined" && chrome.runtime) ?
                    chrome.runtime.getURL("rnnoise_worklet.js") : "rnnoise_worklet.js";

                await this.audioCtx.audioWorklet.addModule(workletUrl);
                this.isWorkletLoaded = true;
                this.isWorkletLoading = false;

                // Create RNNoise worklet node
                this.createRNNoiseNode();
                // Create Noise Gate worklet node
                this.createNoiseGateNode();
            } catch (err) {
                console.warn("[PoliMiAudioEnhancer] Failed to load AudioWorklet/WASM:", err);
                this.isWorkletLoading = false;
            }
        }

        createRNNoiseNode() {
            if (!this.audioCtx || !this.isWorkletLoaded || !this.wasmBinary) return;
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

                // Connect lowpassNode -> rnnoiseNode -> rnnoiseWetGain -> gateDryGain (or gateInput)
                this.lowpassNode.connect(this.rnnoiseNode);
                this.rnnoiseNode.connect(this.rnnoiseWetGain);
                this.rnnoiseWetGain.connect(this.gateDryGain);

                this.updateRNNoiseRouting();
            } catch (e) {
                console.warn("[PoliMiAudioEnhancer] createRNNoiseNode error:", e);
            }
        }

        createNoiseGateNode() {
            if (!this.audioCtx || !this.isWorkletLoaded) return;
            try {
                if (this.noiseGateNode) {
                    try { this.noiseGateNode.disconnect(); } catch (_) {}
                }

                const thresh = this.settings.noiseGateThreshold || -45;
                this.noiseGateNode = new AudioWorkletNode(this.audioCtx, "@sapphi-red/web-noise-suppressor/noise-gate", {
                    processorOptions: {
                        openThreshold: thresh,
                        closeThreshold: thresh - 3,
                        holdMs: 150,
                        maxChannels: 2
                    }
                });

                // Gate wet routing
                this.rnnoiseDryGain.connect(this.noiseGateNode);
                if (this.rnnoiseWetGain) this.rnnoiseWetGain.connect(this.noiseGateNode);

                this.noiseGateNode.connect(this.gateWetGain);
                this.gateWetGain.connect(this.gainNode);

                this.updateNoiseGateRouting();
            } catch (e) {
                console.warn("[PoliMiAudioEnhancer] createNoiseGateNode error:", e);
            }
        }

        updateRNNoiseRouting() {
            if (!this.audioCtx || !this.rnnoiseDryGain || !this.rnnoiseWetGain) return;
            const now = this.audioCtx.currentTime;
            const isEnabled = this.settings.rnnoiseEnabled && this.rnnoiseNode;
            this.rnnoiseWetGain.gain.setValueAtTime(isEnabled ? 1 : 0, now);
            this.rnnoiseDryGain.gain.setValueAtTime(isEnabled ? 0 : 1, now);
        }

        updateNoiseGateRouting() {
            if (!this.audioCtx || !this.gateDryGain || !this.gateWetGain) return;
            const now = this.audioCtx.currentTime;
            const isEnabled = this.settings.noiseGateEnabled && this.noiseGateNode;
            this.gateWetGain.gain.setValueAtTime(isEnabled ? 1 : 0, now);
            this.gateDryGain.gain.setValueAtTime(isEnabled ? 0 : 1, now);
        }

        updateHighpassNode() {
            if (!this.highpassNode || !this.audioCtx) return;
            const now = this.audioCtx.currentTime;
            if (this.settings.highpassEnabled) {
                this.highpassNode.frequency.setValueAtTime(this.settings.highpassFreq || 90, now);
            } else {
                // Transparent bypass
                this.highpassNode.frequency.setValueAtTime(10, now);
            }
        }

        updateLowpassNode() {
            if (!this.lowpassNode || !this.audioCtx) return;
            const now = this.audioCtx.currentTime;
            if (this.settings.lowpassEnabled) {
                this.lowpassNode.frequency.setValueAtTime(this.settings.lowpassFreq || 8000, now);
            } else {
                // Transparent bypass
                this.lowpassNode.frequency.setValueAtTime(22050, now);
            }
        }

        // ==========================================
        // PUBLIC API
        // ==========================================

        async setRNNoise(enabled) {
            this.settings.rnnoiseEnabled = !!enabled;
            this.settings.preset = 'custom';
            if (enabled && !this.isInitialized) {
                await this.initPipeline();
            }
            if (enabled && !this.isWorkletLoaded) {
                await this.ensureWorklets();
            }
            this.updateRNNoiseRouting();
            this.saveSettings();
        }

        setHighPass(enabled, freq) {
            this.settings.highpassEnabled = !!enabled;
            if (typeof freq === "number") this.settings.highpassFreq = Math.max(30, Math.min(300, freq));
            this.settings.preset = 'custom';
            if (enabled && !this.isInitialized) {
                this.initPipeline();
            }
            this.updateHighpassNode();
            this.saveSettings();
        }

        setLowPass(enabled, freq) {
            this.settings.lowpassEnabled = !!enabled;
            if (typeof freq === "number") this.settings.lowpassFreq = Math.max(3000, Math.min(16000, freq));
            this.settings.preset = 'custom';
            if (enabled && !this.isInitialized) {
                this.initPipeline();
            }
            this.updateLowpassNode();
            this.saveSettings();
        }

        async setNoiseGate(enabled, threshold) {
            this.settings.noiseGateEnabled = !!enabled;
            if (typeof threshold === "number") this.settings.noiseGateThreshold = Math.max(-70, Math.min(-20, threshold));
            this.settings.preset = 'custom';
            if (enabled && !this.isInitialized) {
                await this.initPipeline();
            }
            if (enabled && !this.isWorkletLoaded) {
                await this.ensureWorklets();
            }
            if (this.isWorkletLoaded) {
                this.createNoiseGateNode();
            }
            this.updateNoiseGateRouting();
            this.saveSettings();
        }

        setVolumeBoost(mult) {
            this.settings.volumeBoost = Math.max(1.0, Math.min(3.0, mult));
            if (this.settings.volumeBoost > 1.0 && !this.isInitialized) {
                this.initPipeline();
            }
            if (this.gainNode && this.audioCtx) {
                this.gainNode.gain.setValueAtTime(this.settings.volumeBoost, this.audioCtx.currentTime);
            }
            this.saveSettings();
        }

        async applyPreset(presetName) {
            switch (presetName) {
                case "clear_voice": // Voce Chiara (Consigliato)
                    this.settings.rnnoiseEnabled = true;
                    this.settings.highpassEnabled = true;
                    this.settings.highpassFreq = 95;
                    this.settings.lowpassEnabled = true;
                    this.settings.lowpassFreq = 8500;
                    this.settings.noiseGateEnabled = false;
                    this.settings.preset = "clear_voice";
                    break;
                case "noisy_room": // Aula Rumorosa / Ventole
                    this.settings.rnnoiseEnabled = true;
                    this.settings.highpassEnabled = true;
                    this.settings.highpassFreq = 120;
                    this.settings.lowpassEnabled = true;
                    this.settings.lowpassFreq = 7500;
                    this.settings.noiseGateEnabled = true;
                    this.settings.noiseGateThreshold = -42;
                    this.settings.preset = "noisy_room";
                    break;
                case "light_filters": // Solo Filtri Leggeri (senza AI)
                    this.settings.rnnoiseEnabled = false;
                    this.settings.highpassEnabled = true;
                    this.settings.highpassFreq = 85;
                    this.settings.lowpassEnabled = true;
                    this.settings.lowpassFreq = 9000;
                    this.settings.noiseGateEnabled = false;
                    this.settings.preset = "light_filters";
                    break;
                case "reset": // Audio Originale
                    this.settings.rnnoiseEnabled = false;
                    this.settings.highpassEnabled = false;
                    this.settings.highpassFreq = 90;
                    this.settings.lowpassEnabled = false;
                    this.settings.lowpassFreq = 8000;
                    this.settings.noiseGateEnabled = false;
                    this.settings.noiseGateThreshold = -45;
                    this.settings.preset = "none";
                    break;
            }

            if (this.isAnyFilterActive()) {
                if (!this.isInitialized) await this.initPipeline();
                if (this.settings.rnnoiseEnabled || this.settings.noiseGateEnabled) {
                    await this.ensureWorklets();
                }
            }

            this.updateHighpassNode();
            this.updateLowpassNode();
            this.updateRNNoiseRouting();
            this.updateNoiseGateRouting();
            this.saveSettings();
        }

        getSilenceAnalyser() {
            if (!this.silenceAnalyser && this.currentVideo) {
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
