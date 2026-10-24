/**
 * IndexedDB storage for offline Webex & SharePoint lectures.
 * Supports custom course folders, sorting, PC folder handle persistence,
 * isolated lightweight metadata caching, and high-performance querying.
 */

const WebexOfflineDB = (function () {
    const DB_NAME = "WebexOfflineDB";
    const DB_VERSION = 5;
    const STORE_NAME = "lectures";
    const METADATA_STORE = "lectures_meta";
    const FOLDER_STORE = "folders";
    const SETTINGS_STORE = "settings";

    // In-memory session cache for instant, zero-I/O querying (< 1ms)
    let _metadataCache = null;
    let _foldersCache = null;

    function extractMetadata(item) {
        if (!item || !item.id) return null;
        return {
            id: item.id,
            title: item.title || item.id,
            originalTitle: item.originalTitle || item.title || item.id,
            url: item.url || "",
            webexUrl: item.webexUrl || item.url || "",
            webexRecordingId: item.webexRecordingId || (item.id.startsWith("mirror_") ? "" : item.id),
            size: item.size || 0,
            duration: item.duration || 0,
            bufferedPercent: item.bufferedPercent || 100,
            date: item.date || new Date().toISOString(),
            folder: (item.folder && item.folder !== "Generale") ? item.folder : "",
            isLocalMirror: !!item.isLocalMirror,
            fileName: item.fileName || (item.fileHandle ? item.fileHandle.name : null),
            fileHandle: item.fileHandle || null,
            hasSubtitles: !!(item.subtitlesData || item.transcript || item.subtitles),
            hasBookmarks: !!(item.bookmarks && item.bookmarks.length > 0),
            hasNotes: !!(item.notes && item.notes.length > 0)
        };
    }

    function invalidateCache() {
        _metadataCache = null;
        _foldersCache = null;
    }

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                const tx = e.target.transaction;
                let store;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
                } else {
                    store = tx.objectStore(STORE_NAME);
                }

                if (!store.indexNames.contains("by_webexRecordingId")) {
                    store.createIndex("by_webexRecordingId", "webexRecordingId", { unique: false });
                }
                if (!store.indexNames.contains("by_url")) {
                    store.createIndex("by_url", "url", { unique: false });
                }
                if (!store.indexNames.contains("by_folder")) {
                    store.createIndex("by_folder", "folder", { unique: false });
                }

                // Dedicated lightweight metadata store (stores NO Blobs, NO Transcripts)
                let metaStore;
                if (!db.objectStoreNames.contains(METADATA_STORE)) {
                    metaStore = db.createObjectStore(METADATA_STORE, { keyPath: "id" });
                    metaStore.createIndex("by_folder", "folder", { unique: false });
                    metaStore.createIndex("by_date", "date", { unique: false });
                    metaStore.createIndex("by_title", "title", { unique: false });

                    // Initial migration: populate metadata from existing STORE_NAME
                    if (db.objectStoreNames.contains(STORE_NAME)) {
                        try {
                            const lStore = tx.objectStore(STORE_NAME);
                            lStore.openCursor().onsuccess = (ev) => {
                                const cursor = ev.target.result;
                                if (cursor) {
                                    const m = extractMetadata(cursor.value);
                                    if (m) metaStore.put(m);
                                    cursor.continue();
                                }
                            };
                        } catch (_) {}
                    }
                }

                if (!db.objectStoreNames.contains(FOLDER_STORE)) {
                    db.createObjectStore(FOLDER_STORE, { keyPath: "name" });
                } else {
                    try {
                        const fStore = tx.objectStore(FOLDER_STORE);
                        fStore.delete("Generale");
                    } catch (_) {}
                }
                if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
                    db.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
                }
            };
            request.onblocked = () => {
                console.warn("[WebexOfflineDB] Database upgrade/open blocked by another active connection.");
            };
            request.onsuccess = (e) => {
                const db = e.target.result;
                db.onversionchange = () => {
                    console.warn("[WebexOfflineDB] Database version change requested, closing connection.");
                    try { db.close(); } catch (_) {}
                };
                resolve(db);
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    async function saveLecture(data) {
        invalidateCache();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE, FOLDER_STORE], "readwrite");
            tx.onabort = (e) => reject(tx.error || new Error("Transaction aborted"));
            tx.onerror = (e) => reject(tx.error || e.target.error);
            const store = tx.objectStore(STORE_NAME);
            const metaStore = tx.objectStore(METADATA_STORE);
            const folderStore = tx.objectStore(FOLDER_STORE);

            // Clean folder name - default is empty (belongs to all lectures)
            const rawFolder = data.folder ? data.folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : "";
            const folder = (rawFolder && rawFolder !== "Generale") ? rawFolder : "";
            data.folder = folder;

            // Preserve persistent metadata
            if (!data.originalTitle && data.title) data.originalTitle = data.title;
            if (!data.webexUrl && data.url) data.webexUrl = data.url;
            if (!data.webexRecordingId && data.id && !data.id.startsWith("mirror_")) data.webexRecordingId = data.id;

            // If user assigned a custom folder, track all hierarchy levels in folderStore
            if (folder) {
                const parts = folder.split('/');
                let acc = '';
                for (const p of parts) {
                    acc = acc ? `${acc}/${p}` : p;
                    folderStore.put({ name: acc, createdAt: Date.now() });
                }
            }

            // Check if record already exists to preserve all existing properties, notes, mirrors, and blobs
            const getReq = store.get(data.id);
            getReq.onsuccess = () => {
                const existing = getReq.result;
                let toSave = data;
                if (existing) {
                    toSave = Object.assign({}, existing, data);
                    if (!data.blob && existing.blob) toSave.blob = existing.blob;
                    if (!data.size && existing.size) toSave.size = existing.size;
                    if (!data.notes && existing.notes) toSave.notes = existing.notes;
                    if (!data.bookmarks && existing.bookmarks) toSave.bookmarks = existing.bookmarks;
                    if (!data.duration && existing.duration) toSave.duration = existing.duration;
                    if (!data.fileHandle && existing.fileHandle) toSave.fileHandle = existing.fileHandle;
                    if (!data.fileName && existing.fileName) toSave.fileName = existing.fileName;
                    if (!data.isLocalMirror && existing.isLocalMirror) toSave.isLocalMirror = existing.isLocalMirror;
                    if (!data.folder && existing.folder) toSave.folder = existing.folder;

                    if (data.clearSubtitles) {
                        delete toSave.subtitlesData;
                        delete toSave.transcript;
                        delete toSave.subtitles;
                        toSave.clearSubtitles = true;
                    } else {
                        if (data.transcript === undefined && existing.transcript !== undefined) toSave.transcript = existing.transcript;
                        if (data.subtitlesData === undefined && existing.subtitlesData !== undefined) toSave.subtitlesData = existing.subtitlesData;
                        if (data.subtitles === undefined && existing.subtitles !== undefined) toSave.subtitles = existing.subtitles;
                    }
                }
                const req = store.put(toSave);
                const meta = extractMetadata(toSave);
                if (meta) metaStore.put(meta);
                req.onsuccess = () => resolve(true);
                req.onerror = (e) => reject(e.target.error);
            };
            getReq.onerror = () => {
                const req = store.put(data);
                const meta = extractMetadata(data);
                if (meta) metaStore.put(meta);
                req.onsuccess = () => resolve(true);
                req.onerror = (e) => reject(e.target.error);
            };
        });
    }

    async function deleteSubtitles(id) {
        if (!id) return false;
        invalidateCache();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE], "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const metaStore = tx.objectStore(METADATA_STORE);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const item = getReq.result;
                if (!item) {
                    resolve(false);
                    return;
                }
                delete item.subtitlesData;
                delete item.transcript;
                delete item.subtitles;
                item.clearSubtitles = true;
                store.put(item);
                const meta = extractMetadata(item);
                if (meta) metaStore.put(meta);
                resolve(true);
            };
            getReq.onerror = () => resolve(false);
        });
    }

    async function getLecture(id) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(id);
            req.onsuccess = async (e) => {
                const item = e.target.result || null;
                if (!item) {
                    resolve(null);
                    return;
                }
                // If item is backed by a PC FileSystemFileHandle, load the File object
                if ((!item.blob || item.isLocalMirror) && item.fileHandle) {
                    try {
                        const f = await item.fileHandle.getFile();
                        item.blob = f;
                    } catch (err) {
                        console.warn("[WebexOfflineDB] Warning loading file from fileHandle:", err);
                    }
                }
                resolve(item);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    function filterAndSort(results, folderFilter, sortBy, sortOrder) {
        if (folderFilter && folderFilter !== "all" && folderFilter !== "Tutte") {
            results = results.filter(item => {
                if (!item.folder) return false;
                return item.folder === folderFilter || item.folder.startsWith(folderFilter + "/");
            });
        }

        results.sort((a, b) => {
            let cmp = 0;
            if (sortBy === "name" || sortBy === "title") {
                cmp = (a.title || a.id).localeCompare(b.title || b.id, undefined, { numeric: true, sensitivity: 'base' });
            } else if (sortBy === "size") {
                cmp = (a.size || 0) - (b.size || 0);
            } else if (sortBy === "duration") {
                cmp = (a.duration || 0) - (b.duration || 0);
            } else { // date (default)
                cmp = new Date(a.date).getTime() - new Date(b.date).getTime();
            }
            return sortOrder === "desc" ? -cmp : cmp;
        });

        return results;
    }

    async function listLectures(folderFilter = null, sortBy = "date", sortOrder = "desc") {
        // Fast Path 1: Check in-memory session cache (< 0.5ms)
        if (_metadataCache && Array.isArray(_metadataCache)) {
            return filterAndSort([..._metadataCache], folderFilter, sortBy, sortOrder);
        }

        const db = await openDB();
        return new Promise((resolve, reject) => {
            // Fast Path 2: Read from lightweight METADATA_STORE (NO Blobs, NO heavy I/O!)
            const tx = db.transaction(METADATA_STORE, "readonly");
            const metaStore = tx.objectStore(METADATA_STORE);
            const req = metaStore.getAll();

            req.onsuccess = (e) => {
                let rawList = e.target.result || [];
                if (rawList.length === 0) {
                    // Fallback for upgrade transition: read from STORE_NAME and populate
                    fallbackReadFromStore(db).then(migrated => {
                        _metadataCache = migrated;
                        resolve(filterAndSort([...migrated], folderFilter, sortBy, sortOrder));
                    }).catch(reject);
                    return;
                }

                let results = rawList
                    .filter(item => !!(item && item.id && (item.fileHandle || (item.size && item.size > 0) || item.isLocalMirror || item.title || item.webexRecordingId)))
                    .map(item => extractMetadata(item));

                _metadataCache = results;
                resolve(filterAndSort([...results], folderFilter, sortBy, sortOrder));
            };

            req.onerror = () => {
                fallbackReadFromStore(db).then(migrated => {
                    _metadataCache = migrated;
                    resolve(filterAndSort([...migrated], folderFilter, sortBy, sortOrder));
                }).catch(reject);
            };
        });
    }

    function fallbackReadFromStore(db) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = (e) => {
                const raw = e.target.result || [];
                const res = raw
                    .filter(item => !!(item && item.id && (item.fileHandle || (item.size && item.size > 0) || item.isLocalMirror || item.title || item.webexRecordingId)))
                    .map(item => extractMetadata(item));
                resolve(res);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function deleteLecture(id) {
        invalidateCache();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE], "readwrite");
            tx.objectStore(STORE_NAME).delete(id);
            tx.objectStore(METADATA_STORE).delete(id);
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    async function moveLecture(id, newFolder) {
        invalidateCache();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE, FOLDER_STORE], "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const metaStore = tx.objectStore(METADATA_STORE);
            const folderStore = tx.objectStore(FOLDER_STORE);

            const raw = newFolder ? newFolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : "";
            const folder = (raw && raw !== "Generale") ? raw : "";

            if (folder) {
                const parts = folder.split('/');
                let acc = '';
                for (const p of parts) {
                    acc = acc ? `${acc}/${p}` : p;
                    folderStore.put({ name: acc, createdAt: Date.now() });
                }
            }

            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const item = getReq.result;
                if (!item) {
                    resolve(false);
                    return;
                }
                item.folder = folder;
                store.put(item);
                const meta = extractMetadata(item);
                if (meta) metaStore.put(meta);
                resolve(true);
            };
            getReq.onerror = (e) => reject(e.target.error);
        });
    }

    async function getFolders() {
        if (_foldersCache && Array.isArray(_foldersCache)) {
            return [..._foldersCache];
        }

        const db = await openDB();
        return new Promise((resolve, reject) => {
            // Read from FOLDER_STORE and lightweight METADATA_STORE (NEVER from STORE_NAME!)
            const tx = db.transaction([FOLDER_STORE, METADATA_STORE], "readonly");
            const fStore = tx.objectStore(FOLDER_STORE);
            const mStore = tx.objectStore(METADATA_STORE);

            const set = new Set();

            const fReq = fStore.getAll();
            fReq.onsuccess = () => {
                (fReq.result || []).forEach(f => {
                    if (f.name && f.name.trim() && f.name !== "Generale") {
                        const clean = f.name.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                        set.add(clean);
                        const parts = clean.split('/');
                        let acc = '';
                        for (const p of parts) {
                            acc = acc ? `${acc}/${p}` : p;
                            set.add(acc);
                        }
                    }
                });

                const mReq = mStore.getAll();
                mReq.onsuccess = () => {
                    (mReq.result || []).forEach(l => {
                        if (l.folder && l.folder.trim() && l.folder !== "Generale") {
                            const cleanF = l.folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                            set.add(cleanF);
                            const parts = cleanF.split('/');
                            let acc = '';
                            for (const p of parts) {
                                acc = acc ? `${acc}/${p}` : p;
                                set.add(acc);
                            }
                        }
                    });
                    const res = Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
                    _foldersCache = res;
                    resolve(res);
                };
                mReq.onerror = () => {
                    const res = Array.from(set).sort();
                    _foldersCache = res;
                    resolve(res);
                };
            };
            fReq.onerror = (e) => reject(e.target.error);
        });
    }

    async function createFolder(name) {
        if (!name || !name.trim()) return false;
        invalidateCache();
        const clean = name.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if (!clean || clean === "Generale") return false;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(FOLDER_STORE, "readwrite");
            const store = tx.objectStore(FOLDER_STORE);
            const parts = clean.split('/');
            let acc = '';
            for (const p of parts) {
                acc = acc ? `${acc}/${p}` : p;
                store.put({ name: acc, createdAt: Date.now() });
            }
            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);
        });
    }

    async function deleteFolder(folderName) {
        if (!folderName || folderName === "Generale") return false;
        invalidateCache();
        const cleanTarget = folderName.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE, FOLDER_STORE], "readwrite");
            const lStore = tx.objectStore(STORE_NAME);
            const mStore = tx.objectStore(METADATA_STORE);
            const fStore = tx.objectStore(FOLDER_STORE);

            tx.oncomplete = () => resolve(true);
            tx.onerror = (e) => reject(e.target.error);

            // Delete this folder and all subfolders starting with cleanTarget + '/'
            const fReq = fStore.getAll();
            fReq.onsuccess = () => {
                const fList = fReq.result || [];
                fList.forEach(f => {
                    const fname = f.name;
                    if (fname === cleanTarget || fname.startsWith(cleanTarget + "/")) {
                        fStore.delete(fname);
                    }
                });

                // Reset lectures in this folder or its subfolders to parent or root
                const mReq = mStore.getAll();
                mReq.onsuccess = () => {
                    const list = mReq.result || [];
                    list.forEach(item => {
                        const iFolder = (item.folder || "").replace(/\\/g, '/');
                        if (iFolder === cleanTarget || iFolder.startsWith(cleanTarget + "/")) {
                            const parent = cleanTarget.includes('/') ? cleanTarget.substring(0, cleanTarget.lastIndexOf('/')) : "";
                            item.folder = parent;
                            mStore.put(item);
                            // Also update heavy store
                            const getL = lStore.get(item.id);
                            getL.onsuccess = () => {
                                if (getL.result) {
                                    getL.result.folder = parent;
                                    lStore.put(getL.result);
                                }
                            };
                        }
                    });
                };
            };
        });
    }

    async function saveSetting(key, val) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SETTINGS_STORE, "readwrite");
            const store = tx.objectStore(SETTINGS_STORE);
            const req = store.put({ key, val, updatedAt: Date.now() });
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function getSetting(key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SETTINGS_STORE, "readonly");
            const store = tx.objectStore(SETTINGS_STORE);
            const req = store.get(key);
            req.onsuccess = (e) => resolve(e.target.result ? e.target.result.val : null);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function removeSetting(key) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(SETTINGS_STORE, "readwrite");
            const store = tx.objectStore(SETTINGS_STORE);
            const req = store.delete(key);
            req.onsuccess = () => resolve(true);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    // Unified Notes & Bookmarks Persistence
    async function saveNotes(lectureId, notes) {
        if (!lectureId) return false;
        invalidateCache();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE], "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const metaStore = tx.objectStore(METADATA_STORE);
            const req = store.get(lectureId);
            req.onsuccess = () => {
                let item = req.result;
                if (!item) {
                    item = { id: lectureId, notes: notes, createdAt: Date.now() };
                } else {
                    item.notes = notes;
                    item.updatedAt = Date.now();
                }
                store.put(item);
                const meta = extractMetadata(item);
                if (meta) metaStore.put(meta);
                resolve(true);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function getNotes(lectureId) {
        if (!lectureId) return [];
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(lectureId);
            req.onsuccess = () => {
                const item = req.result;
                resolve(item && Array.isArray(item.notes) ? item.notes : []);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function saveBookmarks(lectureId, bookmarks) {
        if (!lectureId) return false;
        invalidateCache();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE], "readwrite");
            const store = tx.objectStore(STORE_NAME);
            const metaStore = tx.objectStore(METADATA_STORE);
            const req = store.get(lectureId);
            req.onsuccess = () => {
                let item = req.result;
                if (!item) {
                    item = { id: lectureId, bookmarks: bookmarks, createdAt: Date.now() };
                } else {
                    item.bookmarks = bookmarks;
                    item.updatedAt = Date.now();
                }
                store.put(item);
                const meta = extractMetadata(item);
                if (meta) metaStore.put(meta);
                resolve(true);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function getBookmarks(lectureId) {
        if (!lectureId) return [];
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const req = store.get(lectureId);
            req.onsuccess = () => {
                const item = req.result;
                resolve(item && Array.isArray(item.bookmarks) ? item.bookmarks : []);
            };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async function findLecture(query) {
        if (!query) return null;
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);

            // Fast path 1: by exact ID (key)
            if (query.recordingId) {
                const directReq = store.get(query.recordingId);
                directReq.onsuccess = async () => {
                    if (directReq.result) {
                        const match = directReq.result;
                        if ((!match.blob || match.isLocalMirror) && match.fileHandle) {
                            try { match.blob = await match.fileHandle.getFile(); } catch (_) {}
                        }
                        resolve(match);
                        return;
                    }

                    if (store.indexNames.contains("by_webexRecordingId")) {
                        const idxReq = store.index("by_webexRecordingId").get(query.recordingId);
                        idxReq.onsuccess = async () => {
                            if (idxReq.result) {
                                const match = idxReq.result;
                                if ((!match.blob || match.isLocalMirror) && match.fileHandle) {
                                    try { match.blob = await match.fileHandle.getFile(); } catch (_) {}
                                }
                                resolve(match);
                                return;
                            }
                            performFallbackScan();
                        };
                        idxReq.onerror = () => performFallbackScan();
                    } else {
                        performFallbackScan();
                    }
                };
                directReq.onerror = () => performFallbackScan();
                return;
            }

            performFallbackScan();

            function performFallbackScan() {
                const req = store.getAll();
                req.onsuccess = async (e) => {
                    const list = e.target.result || [];

                    if (query.recordingId) {
                        const match = list.find(item => 
                            item.id === query.recordingId || 
                            item.webexRecordingId === query.recordingId
                        );
                        if (match) {
                            if ((!match.blob || match.isLocalMirror) && match.fileHandle) {
                                try { match.blob = await match.fileHandle.getFile(); } catch (_) {}
                            }
                            resolve(match);
                            return;
                        }
                    }

                    if (query.pageUrl) {
                        const cleanQ = query.pageUrl.split('?')[0].split('#')[0].toLowerCase();
                        const match = list.find(item => {
                            const u = (item.webexUrl || item.url || "").split('?')[0].split('#')[0].toLowerCase();
                            return u && (u === cleanQ || cleanQ.includes(u) || u.includes(cleanQ));
                        });
                        if (match) {
                            if ((!match.blob || match.isLocalMirror) && match.fileHandle) {
                                try { match.blob = await match.fileHandle.getFile(); } catch (_) {}
                            }
                            resolve(match);
                            return;
                        }
                    }

                    if (query.pageTitle) {
                        const normalize = (s) => (s || '')
                            .toLowerCase()
                            .replace(/[-_~|:/\\]/g, ' ')
                            .replace(/\s+/g, ' ')
                            .replace(/\.mp4$|\.webm$|\.mkv$/i, '')
                            .replace(/\b(polimi|webex|lezione|videolezione|recording|enhancer)\b/gi, '')
                            .trim();

                        const targetNorm = normalize(query.pageTitle);
                        if (targetNorm.length >= 3) {
                            const match = list.find(item => {
                                const nOrig = normalize(item.originalTitle);
                                const nTitle = normalize(item.title);
                                const nFile = normalize(item.fileName || (item.fileHandle ? item.fileHandle.name : ""));
                                return (
                                    (nOrig && (nOrig === targetNorm || targetNorm.includes(nOrig) || nOrig.includes(targetNorm))) ||
                                    (nTitle && (nTitle === targetNorm || targetNorm.includes(nTitle) || nTitle.includes(targetNorm))) ||
                                    (nFile && (nFile === targetNorm || targetNorm.includes(nFile) || nFile.includes(targetNorm)))
                                );
                            });
                            if (match) {
                                if ((!match.blob || match.isLocalMirror) && match.fileHandle) {
                                    try { match.blob = await match.fileHandle.getFile(); } catch (_) {}
                                }
                                resolve(match);
                                return;
                            }
                        }
                    }

                    resolve(null);
                };
                req.onerror = (e) => reject(e.target.error);
            }
        });
    }

    async function clearAllLecturesAndTranscripts() {
        invalidateCache();
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME, METADATA_STORE, FOLDER_STORE], "readwrite");
            tx.oncomplete = () => {
                console.log("[WebexOfflineDB] Purged all lectures, metadata, and course folders from IndexedDB.");
                try {
                    for (let i = localStorage.length - 1; i >= 0; i--) {
                        const k = localStorage.key(i);
                        if (k && (
                            k.startsWith("webex_subtitles_") ||
                            k.startsWith("offline_subtitles_") ||
                            k.startsWith("webex_notes_") ||
                            k.startsWith("offline_notes_") ||
                            k.startsWith("webex_bookmarks_") ||
                            k.startsWith("offline_bookmarks_")
                        )) {
                            localStorage.removeItem(k);
                        }
                    }
                } catch (_) {}
                resolve(true);
            };
            tx.onerror = (e) => reject(tx.error || e.target.error);
            try {
                tx.objectStore(STORE_NAME).clear();
                tx.objectStore(METADATA_STORE).clear();
                tx.objectStore(FOLDER_STORE).clear();
            } catch (err) {
                reject(err);
            }
        });
    }

    return {
        saveLecture,
        getLecture,
        findLecture,
        listLectures,
        deleteLecture,
        deleteSubtitles,
        moveLecture,
        getFolders,
        createFolder,
        deleteFolder,
        saveSetting,
        getSetting,
        removeSetting,
        saveNotes,
        getNotes,
        saveBookmarks,
        getBookmarks,
        clearAllLecturesAndTranscripts,
        invalidateCache
    };
})();

// Support Worker, Service Worker, Window, or Global
if (typeof self !== "undefined") {
    self.WebexOfflineDB = WebexOfflineDB;
}
if (typeof window !== "undefined") {
    window.WebexOfflineDB = WebexOfflineDB;
}
