# Privacy Policy for PoliMi Webex Enhancer

**Last updated:** October 24, 2026  
**Developer:** Francesco Vagli  
**Contact:** [francescovagli@gmail.com](mailto:francescovagli@gmail.com) / [GitHub Repository](https://github.com/fravagli/Polimi-webex-enhancer)

---

### 1. Overview
**PoliMi Webex Enhancer** is an open-source browser extension designed to optimize video lecture playback, audio clarity, and offline study accessibility for students of Politecnico di Milano attending lectures on Cisco Webex and Microsoft SharePoint/Stream.

We are committed to user privacy. This Privacy Policy describes how the extension handles user data.

---

### 2. Information Collection and Usage

#### 2.1 No Personal Data Collected
PoliMi Webex Enhancer **does NOT collect, store, transmit, or sell any personally identifiable information (PII)**, user analytics, browsing history, or biometric data.

#### 2.2 Local Storage (IndexedDB and Chrome Storage API)
All settings and media processed by the extension are stored **strictly locally** on your device:
- **User Preferences:** Audio filter levels (volume boost, RNNoise, lowpass/highpass, noise gate), playback speeds, video filter selections, and keyboard shortcut configurations are saved locally via `chrome.storage.local`.
- **Offline Lecture Library:** Video and audio files downloaded for offline study are cached locally on the user's hard drive via the browser's `IndexedDB` API (`offline_db`). No offline content is ever uploaded to any external server.
- **Study Notes & Bookmarks:** Any notes or timestamps created during video playback remain entirely on your device.

#### 2.3 Optional AI Audio Transcription (Groq Cloud API)
The extension includes an optional AI transcription feature powered by Whisper via the Groq Cloud API:
- This feature is **strictly opt-in** and requires the user to provide their own Groq API key.
- When enabled, isolated audio snippets are sent directly from the user's browser to `https://api.groq.com/` solely to produce text transcripts and subtitles.
- No personal user identifiers are attached to these requests.
- The API key is stored securely and exclusively in the user's local `chrome.storage.local`.

---

### 3. Permissions Justification
The extension requests only the minimum permissions necessary for its intended functionality:
- `storage` / `unlimitedStorage`: To store user playback preferences and enable the local offline lecture database without arbitrary browser storage limits.
- `downloads`: To allow the user to export transcripts (TXT, SRT, JSON), study notes (Markdown), and offline video recordings to their local computer.
- `activeTab`: To interact with the current Webex or SharePoint lecture tab when opening the extension popup.
- `declarativeNetRequest` / `webRequest`: To intercept and route multimedia streams (HLS/video fragments) for the local player and bypass cross-origin restrictions on authenticated educational streams.
- `host_permissions` (`*.webex.com`, `*.sharepoint.com`, `*.microsoftstream.com`, `*.wbx2.com`): To inject player enhancement controls and keyboard shortcuts exclusively on the official Politecnico di Milano educational platforms.

---

### 4. Third-Party Sharing
We do **not** sell, trade, rent, or transfer any user data to outside parties.

---

### 5. Open Source Transparency
PoliMi Webex Enhancer is fully open source. You can audit the complete source code at any time on GitHub:  
[https://github.com/fravagli/Polimi-webex-enhancer](https://github.com/fravagli/Polimi-webex-enhancer)

---

### 6. Contact
If you have any questions or concerns regarding this Privacy Policy, please open an issue on GitHub or contact the developer at:  
**Email:** [francescovagli@gmail.com](mailto:francescovagli@gmail.com)
