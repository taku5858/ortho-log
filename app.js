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
    previewWrap.hidden = true;
    previewImg.src = "";
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
      const processed = await processImageFile(file);
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      pendingPhoto = processed;
      pendingPreviewUrl = URL.createObjectURL(processed.blob);
      previewImg.src = pendingPreviewUrl;
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
        date: new Date().toISOString(),
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
