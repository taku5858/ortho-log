(() => {
  "use strict";

  const DB_NAME = "ortho-log-db";
  const DB_VERSION = 1;
  const STORE = "records";
  const MAX_DIM = 1600;
  const JPEG_WEBP_QUALITY = 0.85;

  const captureBtn = document.getElementById("captureBtn");
  const cameraInput = document.getElementById("cameraInput");
  const libraryBtn = document.getElementById("libraryBtn");
  const libraryInput = document.getElementById("libraryInput");

  const cameraOverlay = document.getElementById("cameraOverlay");
  const cameraVideo = document.getElementById("cameraVideo");
  const shutterBtn = document.getElementById("shutterBtn");
  const cancelCameraBtn = document.getElementById("cancelCameraBtn");

  const cropOverlay = document.getElementById("cropOverlay");
  const cropViewport = document.getElementById("cropViewport");
  const cropImage = document.getElementById("cropImage");
  const zoomSlider = document.getElementById("zoomSlider");
  const cropCancelBtn = document.getElementById("cropCancelBtn");
  const cropConfirmBtn = document.getElementById("cropConfirmBtn");

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
  let mediaStream = null;
  let cropState = null; // pan/zoom state while the crop overlay is open

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

  // Last-resort decode path for formats createImageBitmap can't handle
  // (e.g. an edge-case HEIC file Safari didn't transcode). A plain <img>
  // element can decode almost anything the browser can render at all.
  function loadImageElement(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした"));
      };
      img.src = url;
    });
  }

  async function loadBitmap(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) {
      try {
        return await createImageBitmap(file);
      } catch (e2) {
        return await loadImageElement(file);
      }
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

  // Renders the source (camera capture / library photo) to a full-resolution,
  // orientation-corrected JPEG. This becomes the working image for the crop
  // step below; it is never stored — only the final cropped+compressed blob is.
  async function loadOrientedImageBlob(file) {
    const bitmap = await loadBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
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
    cameraInput.value = "";
    libraryInput.value = "";
  }

  // --- 撮影ガイド（自前カメラ画面） ---------------------------------------
  // ネイティブのカメラアプリ（capture="environment"での起動）には補助線を
  // 重ねられないため、getUserMediaでその場にカメラ映像を表示し、位置合わせ
  // ガイドを重ねる。取得できない・拒否された場合は、既存のネイティブカメラ
  // 起動（cameraInput.click()）に自動でフォールバックする。
  async function openCameraGuide() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraInput.click();
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      cameraVideo.srcObject = mediaStream;
      cameraOverlay.hidden = false;
      await cameraVideo.play().catch(() => {});
    } catch (e) {
      console.warn("In-page camera unavailable, falling back to native camera:", e);
      stopMediaStream();
      cameraOverlay.hidden = true;
      cameraInput.click();
    }
  }

  function stopMediaStream() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    cameraVideo.srcObject = null;
  }

  function closeCameraGuide() {
    stopMediaStream();
    cameraOverlay.hidden = true;
  }

  captureBtn.addEventListener("click", () => {
    openCameraGuide();
  });

  libraryBtn.addEventListener("click", () => {
    libraryInput.click();
  });

  cancelCameraBtn.addEventListener("click", () => {
    closeCameraGuide();
  });

  shutterBtn.addEventListener("click", () => {
    try {
      const vw = cameraVideo.videoWidth;
      const vh = cameraVideo.videoHeight;
      if (!vw || !vh) return;
      const canvas = document.createElement("canvas");
      canvas.width = vw;
      canvas.height = vh;
      canvas.getContext("2d").drawImage(cameraVideo, 0, 0, vw, vh);
      closeCameraGuide();
      canvas.toBlob(
        (blob) => {
          if (blob) {
            handleFileSelected(blob);
          } else {
            setStatus("撮影に失敗しました。もう一度お試しください。", true);
          }
        },
        "image/jpeg",
        0.92
      );
    } catch (e) {
      console.error(e);
      closeCameraGuide();
      setStatus("撮影に失敗しました。もう一度お試しください。", true);
    }
  });

  // --- トリミング画面（手動での位置・拡大縮小調整） -----------------------
  function applyCropTransform() {
    if (!cropState) return;
    cropImage.style.transform = `translate(${cropState.translateX}px, ${cropState.translateY}px) scale(${cropState.scale})`;
  }

  function clampCropTranslate() {
    const s = cropState;
    const minX = s.viewportW - s.naturalWidth * s.scale;
    const minY = s.viewportH - s.naturalHeight * s.scale;
    s.translateX = Math.min(0, Math.max(minX, s.translateX));
    s.translateY = Math.min(0, Math.max(minY, s.translateY));
  }

  function openCropUI(sourceBlob) {
    const url = URL.createObjectURL(sourceBlob);
    const img = new Image();
    img.onload = () => {
      // Reveal the overlay BEFORE measuring: while [hidden], the viewport
      // has no layout box, so getBoundingClientRect() would read back 0x0
      // and poison every scale/translate computation below (this was the
      // root cause of the blank gray preview on iOS Safari).
      cropOverlay.hidden = false;

      const rect = cropViewport.getBoundingClientRect();
      const viewportW = rect.width;
      const viewportH = rect.height;
      const baseScale = Math.max(viewportW / img.naturalWidth, viewportH / img.naturalHeight);

      cropState = {
        url,
        img,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        viewportW,
        viewportH,
        baseScale,
        scale: baseScale,
        translateX: (viewportW - img.naturalWidth * baseScale) / 2,
        translateY: (viewportH - img.naturalHeight * baseScale) / 2,
        dragging: false,
        lastX: 0,
        lastY: 0,
      };

      cropImage.src = url;
      zoomSlider.value = "1";
      applyCropTransform();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus("写真の読み込みに失敗しました。別の写真でお試しください。", true);
    };
    img.src = url;
  }

  function closeCropUI() {
    if (cropState && cropState.url) URL.revokeObjectURL(cropState.url);
    cropState = null;
    cropImage.src = "";
    cropOverlay.hidden = true;
  }

  cropImage.addEventListener("dragstart", (e) => e.preventDefault());

  cropViewport.addEventListener("pointerdown", (e) => {
    if (!cropState) return;
    cropState.dragging = true;
    cropState.lastX = e.clientX;
    cropState.lastY = e.clientY;
  });

  // Listening on window (rather than relying on setPointerCapture, which has
  // had inconsistent behavior on iOS Safari) keeps the drag going even if a
  // finger slides outside the crop viewport, and avoids any risk of a stuck
  // capture blocking taps on the Cancel/Save buttons afterwards.
  window.addEventListener("pointermove", (e) => {
    if (!cropState || !cropState.dragging) return;
    const dx = e.clientX - cropState.lastX;
    const dy = e.clientY - cropState.lastY;
    cropState.lastX = e.clientX;
    cropState.lastY = e.clientY;
    cropState.translateX += dx;
    cropState.translateY += dy;
    clampCropTranslate();
    applyCropTransform();
  });

  function endCropDrag() {
    if (cropState) cropState.dragging = false;
  }
  window.addEventListener("pointerup", endCropDrag);
  window.addEventListener("pointercancel", endCropDrag);

  zoomSlider.addEventListener("input", () => {
    if (!cropState) return;
    const s = cropState;
    const zoomMultiplier = parseFloat(zoomSlider.value);
    const newScale = s.baseScale * zoomMultiplier;
    const centerX = s.viewportW / 2;
    const centerY = s.viewportH / 2;
    const sourceCenterX = (centerX - s.translateX) / s.scale;
    const sourceCenterY = (centerY - s.translateY) / s.scale;
    s.scale = newScale;
    s.translateX = centerX - sourceCenterX * s.scale;
    s.translateY = centerY - sourceCenterY * s.scale;
    clampCropTranslate();
    applyCropTransform();
  });

  cropCancelBtn.addEventListener("click", () => {
    closeCropUI();
  });

  cropConfirmBtn.addEventListener("click", async () => {
    if (!cropState) return;
    const s = cropState;
    try {
      const sx0 = Math.max(0, (0 - s.translateX) / s.scale);
      const sy0 = Math.max(0, (0 - s.translateY) / s.scale);
      const sx1 = Math.min(s.naturalWidth, (s.viewportW - s.translateX) / s.scale);
      const sy1 = Math.min(s.naturalHeight, (s.viewportH - s.translateY) / s.scale);
      const cropW = Math.max(1, Math.round(sx1 - sx0));
      const cropH = Math.max(1, Math.round(sy1 - sy0));

      if (!Number.isFinite(cropW) || !Number.isFinite(cropH)) {
        throw new Error("トリミング範囲の計算に失敗しました");
      }

      const canvas = document.createElement("canvas");
      canvas.width = cropW;
      canvas.height = cropH;
      canvas.getContext("2d").drawImage(s.img, sx0, sy0, cropW, cropH, 0, 0, cropW, cropH);

      const croppedBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
      if (!croppedBlob) {
        throw new Error("画像の書き出しに失敗しました");
      }
      closeCropUI();
      await finalizePhoto(croppedBlob);
    } catch (e) {
      console.error(e);
      closeCropUI();
      setStatus("トリミングに失敗しました。もう一度お試しください。", true);
    }
  });

  // --- 写真選択の入口（カメラ撮影・ライブラリ選択の共通処理） --------------
  // EXIF撮影日時は元ファイルから読み取り、続けて向き補正済みの画像をトリミ
  // ング画面に渡す。既存の圧縮処理（processImageFile）はトリミング確定後に
  // 呼び出される（finalizePhoto）。
  async function handleFileSelected(file) {
    if (!file) return;

    setStatus("写真を読み込み中...", false);
    try {
      const [orientedBlob, exifDate] = await Promise.all([
        loadOrientedImageBlob(file),
        extractExifDateTaken(file),
      ]);
      pendingCapturedAt = exifDate || new Date();
      setStatus("", false);
      openCropUI(orientedBlob);
    } catch (e) {
      console.error(e);
      setStatus("写真の読み込みに失敗しました。別の写真でお試しください。", true);
    }
  }

  async function finalizePhoto(blob) {
    setStatus("写真を処理中...", false);
    try {
      const processed = await processImageFile(blob);
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
      pendingPhoto = processed;
      pendingPreviewUrl = URL.createObjectURL(processed.blob);
      previewImg.src = pendingPreviewUrl;
      capturedAtText.textContent = `撮影日：${formatDate(pendingCapturedAt.toISOString())}`;
      previewWrap.hidden = false;
      saveBtn.disabled = false;
      setStatus("", false);
    } catch (e) {
      console.error(e);
      setStatus("写真の処理に失敗しました。別の写真でお試しください。", true);
    }
  }

  cameraInput.addEventListener("change", () => {
    handleFileSelected(cameraInput.files && cameraInput.files[0]);
  });

  libraryInput.addEventListener("change", () => {
    handleFileSelected(libraryInput.files && libraryInput.files[0]);
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
