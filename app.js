(() => {
  "use strict";

  const DB_NAME = "ortho-log-db";
  const DB_VERSION = 1;
  const STORE = "records";
  const MAX_DIM = 1600;
  const JPEG_WEBP_QUALITY = 0.85;

  const captureBtn = document.getElementById("captureBtn");
  const fileInput = document.getElementById("fileInput");
  const previewWrap = document.getElementById("previewWrap");
  const previewImg = document.getElementById("previewImg");
  const capturedAtText = document.getElementById("capturedAtText");
  const clearPreviewBtn = document.getElementById("clearPreviewBtn");
  const memoInput = document.getElementById("memoInput");
  const saveBtn = document.getElementById("saveBtn");
  const statusMsg = document.getElementById("statusMsg");
  const recordList = document.getElementById("recordList");
  const emptyMsg = document.getElementById("emptyMsg");
  const storageInfo = document.getElementById("storageInfo");

  let dbPromise = null;
  let pendingPhoto = null; // { blob, mime }
  let pendingPreviewUrl = null;
  let pendingCapturedAt = null; // Date: EXIF DateTimeOriginal, or fallback to now
  let listObjectUrls = [];
  let supportsWebp = false;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          store.createIndex("date", "date");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function addRecord(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getAllRecords() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteRecordById(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function detectWebpSupport() {
    return new Promise((resolve) => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        canvas.toBlob((blob) => {
          resolve(!!blob && blob.type === "image/webp");
        }, "image/webp");
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      return await createImageBitmap(file);
    }
  }

  async function processImageFile(file) {
    const bitmap = await loadBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_DIM / Math.max(width, height));
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, outW, outH);
    if (bitmap.close) bitmap.close();

    const mime = supportsWebp ? "image/webp" : "image/jpeg";
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, mime, JPEG_WEBP_QUALITY)
    );
    return { blob, mime };
  }

  // --- Minimal EXIF reader (no external library) -----------------------
  // Reads only the DateTimeOriginal (fallback: DateTime) tag from a JPEG's
  // EXIF block, entirely in-memory on the device. Returns null (never
  // throws) when the file isn't JPEG or has no usable EXIF date, so the
  // caller can silently fall back to the current time.
  const EXIF_READ_BYTES = 262144; // 256KB is enough to reach the date tags on virtually all camera JPEGs

  function readAsciiAt(view, offset, length) {
    let out = "";
    for (let i = 0; i < length; i++) {
      const code = view.getUint8(offset + i);
      if (code === 0) break;
      out += String.fromCharCode(code);
    }
    return out;
  }

  function parseExifDateString(str) {
    const m = /^(\d{4}):(\d{2}):(\d{2})\s(\d{2}):(\d{2}):(\d{2})/.exec(str || "");
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m.map(Number);
    const date = new Date(y, mo - 1, d, h, mi, s);
    return isNaN(date.getTime()) ? null : date;
  }

  function readIfdDateTag(view, ifdOffset, tiffOffset, littleEndian, tagId) {
    const entryCount = view.getUint16(ifdOffset, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = view.getUint16(entryOffset, littleEndian);
      if (tag !== tagId) continue;
      const type = view.getUint16(entryOffset + 2, littleEndian);
      const count = view.getUint32(entryOffset + 4, littleEndian);
      if (type !== 2) return null; // expect ASCII
      const valueFieldOffset = entryOffset + 8;
      const dataOffset =
        count <= 4 ? valueFieldOffset : tiffOffset + view.getUint32(valueFieldOffset, littleEndian);
      return readAsciiAt(view, dataOffset, count);
    }
    return null;
  }

  function findIfdPointer(view, ifdOffset, littleEndian, tagId) {
    const entryCount = view.getUint16(ifdOffset, littleEndian);
    for (let i = 0; i < entryCount; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = view.getUint16(entryOffset, littleEndian);
      if (tag === tagId) {
        return view.getUint32(entryOffset + 8, littleEndian);
      }
    }
    return null;
  }

  function extractDateFromExifBuffer(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // not a JPEG (SOI marker)

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);

      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) break; // start of scan: no more metadata follows

      const segmentSize = view.getUint16(offset + 2);
      if (marker === 0xe1 && offset + 4 + 6 <= view.byteLength) {
        const isExif = readAsciiAt(view, offset + 4, 4) === "Exif";
        if (isExif) {
          const tiffOffset = offset + 4 + 6;
          if (tiffOffset + 8 > view.byteLength) return null;
          const byteOrderMark = view.getUint16(tiffOffset);
          const littleEndian = byteOrderMark === 0x4949;
          if (!littleEndian && byteOrderMark !== 0x4d4d) return null;

          const ifd0Offset = tiffOffset + view.getUint32(tiffOffset + 4, littleEndian);
          const exifIfdPointer = findIfdPointer(view, ifd0Offset, littleEndian, 0x8769);

          if (exifIfdPointer) {
            const exifIfdOffset = tiffOffset + exifIfdPointer;
            const original = readIfdDateTag(view, exifIfdOffset, tiffOffset, littleEndian, 0x9003);
            const parsed = parseExifDateString(original);
            if (parsed) return parsed;
          }
          const fallbackTag = readIfdDateTag(view, ifd0Offset, tiffOffset, littleEndian, 0x0132);
          return parseExifDateString(fallbackTag);
        }
      }
      offset += 2 + segmentSize;
    }
    return null;
  }

  async function extractExifDateTaken(file) {
    try {
      const slice = file.slice(0, EXIF_READ_BYTES);
      const buffer = await slice.arrayBuffer();
      return extractDateFromExifBuffer(buffer);
    } catch (e) {
      return null;
    }
  }
  // -----------------------------------------------------------------------

  function setStatus(text, isError) {
    statusMsg.textContent = text || "";
    statusMsg.classList.toggle("error", !!isError);
  }

  function resetForm() {
    if (pendingPreviewUrl) {
      URL.revokeObjectURL(pendingPreviewUrl);
      pendingPreviewUrl = null;
    }
    pendingPhoto = null;
    pendingCapturedAt = null;
    previewWrap.hidden = true;
    previewImg.src = "";
    capturedAtText.textContent = "";
    memoInput.value = "";
    saveBtn.disabled = true;
    fileInput.value = "";
  }

  captureBtn.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    setStatus("写真を処理中...", false);
    try {
      const [processed, exifDate] = await Promise.all([
        processImageFile(file),
        extractExifDateTaken(file),
      ]);
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      pendingPhoto = processed;
      pendingCapturedAt = exifDate || new Date();
      pendingPreviewUrl = URL.createObjectURL(processed.blob);
      previewImg.src = pendingPreviewUrl;
      capturedAtText.textContent = `撮影日：${formatDate(pendingCapturedAt.toISOString())}`;
      previewWrap.hidden = false;
      saveBtn.disabled = false;
      setStatus("", false);
    } catch (e) {
      console.error(e);
      setStatus("写真の読み込みに失敗しました。別の写真でお試しください。", true);
    }
  });

  clearPreviewBtn.addEventListener("click", () => {
    resetForm();
  });

  saveBtn.addEventListener("click", async () => {
    if (!pendingPhoto) return;
    saveBtn.disabled = true;
    setStatus("保存中...", false);
    try {
      const record = {
        date: (pendingCapturedAt || new Date()).toISOString(),
        memo: memoInput.value.trim(),
        photoBlob: pendingPhoto.blob,
        photoType: pendingPhoto.mime,
      };
      await addRecord(record);
      resetForm();
      setStatus("保存しました", false);
      await renderList();
      await updateStorageInfo();
    } catch (e) {
      console.error(e);
      if (e && (e.name === "QuotaExceededError" || e.name === "QuotaExceededErrorDOMException")) {
        setStatus("保存容量が不足しています。不要な記録を削除してから、もう一度お試しください。", true);
      } else {
        setStatus("保存に失敗しました。もう一度お試しください。", true);
      }
      saveBtn.disabled = false;
    }
  });

  function revokeListObjectUrls() {
    listObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    listObjectUrls = [];
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }

  async function renderList() {
    const records = await getAllRecords();
    records.sort((a, b) => new Date(b.date) - new Date(a.date));

    revokeListObjectUrls();
    recordList.innerHTML = "";

    emptyMsg.hidden = records.length > 0;

    for (const record of records) {
      const url = URL.createObjectURL(record.photoBlob);
      listObjectUrls.push(url);

      const card = document.createElement("div");
      card.className = "record-card";

      const dateEl = document.createElement("div");
      dateEl.className = "record-date";
      dateEl.textContent = formatDate(record.date);

      const img = document.createElement("img");
      img.className = "record-photo";
      img.src = url;
      img.alt = "記録した写真";

      const memoEl = document.createElement("div");
      memoEl.className = "record-memo";
      memoEl.textContent = record.memo || "";

      const actions = document.createElement("div");
      actions.className = "record-actions";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "delete-btn";
      delBtn.textContent = "削除";
      delBtn.addEventListener("click", async () => {
        const ok = window.confirm("この記録を削除しますか？この操作は取り消せません。");
        if (!ok) return;
        try {
          await deleteRecordById(record.id);
          await renderList();
          await updateStorageInfo();
        } catch (e) {
          console.error(e);
          window.alert("削除に失敗しました。もう一度お試しください。");
        }
      });
      actions.appendChild(delBtn);

      card.appendChild(dateEl);
      card.appendChild(img);
      card.appendChild(memoEl);
      card.appendChild(actions);
      recordList.appendChild(card);
    }
  }

  async function updateStorageInfo() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        const usageMB = (usage / (1024 * 1024)).toFixed(1);
        if (quota) {
          const quotaMB = (quota / (1024 * 1024)).toFixed(0);
          storageInfo.textContent = `使用容量: 約${usageMB}MB / ${quotaMB}MB`;
        } else {
          storageInfo.textContent = `使用容量: 約${usageMB}MB`;
        }
      } catch (e) {
        storageInfo.textContent = "";
      }
    } else {
      storageInfo.textContent = "";
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    // Service Worker requires a secure context (HTTPS, or http://localhost).
    // On http://<LAN-IP> (used to test from a phone) registration will simply
    // fail silently and the app still works without offline/installability.
    navigator.serviceWorker.register("sw.js").catch((e) => {
      console.warn("Service Worker registration failed:", e);
    });
  }

  async function init() {
    supportsWebp = await detectWebpSupport();
    await renderList();
    await updateStorageInfo();
    registerServiceWorker();
  }

  init();
})();
