/* ============================================
   InstaSquare - Simple
   ============================================ */

(function () {
    'use strict';

    // ---- Config ----
    const MAX_FILES = 20;
    const JPEG_QUALITY = 0.92;
    const PREVIEW_MAX_W = 540;
    const PREVIEW_MAX_H = 600;
    const ZOOM_MIN = 1.0;
    const ZOOM_MAX = 4.0;

    // ---- DOM ----
    const $ = (id) => document.getElementById(id);

    const uploadArea = $('uploadArea');
    const fileInput = $('fileInput');
    const uploadSection = $('uploadSection');
    const uploadCount = $('uploadCount');
    const countText = $('countText');

    const editorSection = $('editorSection');
    const thumbStrip = $('thumbStrip');
    const addMoreBtn = $('addMoreBtn');

    const editorPreview = $('editorPreview');
    const previewCanvas = $('previewCanvas');
    const previewCtx = previewCanvas.getContext('2d');
    const previewMeta = $('previewMeta');

    const blurRange = $('blurRange');
    const blurValueEl = $('blurValue');
    const brightnessRange = $('brightnessRange');
    const brightnessValueEl = $('brightnessValue');

    const downloadBtn = $('downloadBtn');
    const resetBtn = $('resetBtn');
    const removeOneBtn = $('removeOneBtn');
    const clearAllBtn = $('clearAllBtn');

    const processingSection = $('processingSection');
    const processingText = $('processingText');
    const progressFill = $('progressFill');

    const procCanvas = $('processingCanvas');

    // ---- State ----
    let aspectRatio = '1:1';
    let images = [];
    let editingId = null;
    let nextId = 1;
    let faceDetector = null;
    let faceDetectionSupported = false;

    // Pointer / drag / pinch
    const activePointers = new Map();
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let dragStartCx = 0.5, dragStartCy = 0.5;
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    // ---- Init ----
    initFaceDetection();
    bindEvents();

    async function initFaceDetection() {
        if (typeof window.FaceDetector !== 'undefined') {
            try {
                faceDetector = new FaceDetector({ maxDetectedFaces: 10, fastMode: true });
                faceDetectionSupported = true;
            } catch (e) {
                console.log('FaceDetector init failed:', e);
            }
        }
    }

    const OUTPUT_SIZES = {
        '1:1': { w: 1080, h: 1080 },
        '4:3': { w: 1440, h: 1080 },
        '9:16': { w: 1080, h: 1920 }
    };

    function getOutputSize() {
        return OUTPUT_SIZES[aspectRatio] || OUTPUT_SIZES['1:1'];
    }

    // ---- Image load with EXIF orientation ----
    async function loadBitmap(file) {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (e) {
            return await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = URL.createObjectURL(file);
            });
        }
    }

    // ---- Thumbnail (square center crop) ----
    function makeThumb(bitmap) {
        const size = 128;
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        const r = Math.min(bitmap.width, bitmap.height);
        const sx = (bitmap.width - r) / 2;
        const sy = (bitmap.height - r) / 2;
        cx.drawImage(bitmap, sx, sy, r, r, 0, 0, size, size);
        return c.toDataURL('image/jpeg', 0.75);
    }

    // ---- Auto crop center suggestion (face → saliency → center) ----
    async function autoSuggestCrop(bitmap) {
        const w = bitmap.width;
        const h = bitmap.height;

        if (faceDetectionSupported && faceDetector) {
            try {
                const faces = await faceDetector.detect(bitmap);
                if (faces && faces.length > 0) {
                    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
                    for (const f of faces) {
                        const b = f.boundingBox;
                        minX = Math.min(minX, b.x);
                        minY = Math.min(minY, b.y);
                        maxX = Math.max(maxX, b.x + b.width);
                        maxY = Math.max(maxY, b.y + b.height);
                    }
                    const cx = ((minX + maxX) / 2) / w;
                    let cy = ((minY + maxY) / 2) / h;
                    cy = Math.max(0, cy - 0.04);
                    return { cx, cy };
                }
            } catch (e) {
                console.warn('Face detection failed:', e);
            }
        }
        return saliencyFallback(bitmap, w, h);
    }

    function saliencyFallback(bitmap, imgW, imgH) {
        const analysisScale = Math.min(1, 400 / Math.max(imgW, imgH));
        const aW = Math.max(2, Math.round(imgW * analysisScale));
        const aH = Math.max(2, Math.round(imgH * analysisScale));

        procCanvas.width = aW;
        procCanvas.height = aH;
        const cx = procCanvas.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bitmap, 0, 0, aW, aH);

        let data;
        try {
            data = cx.getImageData(0, 0, aW, aH).data;
        } catch (e) {
            return { cx: 0.5, cy: 0.5 };
        }

        let total = 0, wx = 0, wy = 0;
        for (let y = 0; y < aH; y++) {
            for (let x = 0; x < aW; x++) {
                const idx = (y * aW + x) * 4;
                const r = data[idx];
                const g = data[idx + 1];
                const b = data[idx + 2];

                let w = 0;
                if (isSkinTone(r, g, b)) w += 3.0;
                const mx = Math.max(r, g, b);
                const mn = Math.min(r, g, b);
                const sat = mx === 0 ? 0 : (mx - mn) / mx;
                const brt = mx / 255;
                w += sat * 0.5 + brt * 0.3;
                const ncx = (x / aW - 0.5) * 2;
                const ncy = (y / aH - 0.5) * 2;
                w += Math.exp(-(ncx * ncx + ncy * ncy) * 1.5) * 0.8;

                total += w;
                wx += x * w;
                wy += y * w;
            }
        }

        if (total <= 0) return { cx: 0.5, cy: 0.5 };
        return { cx: (wx / total) / aW, cy: (wy / total) / aH };
    }

    function isSkinTone(r, g, b) {
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        if (r <= 60 || g <= 40 || b <= 20) return false;
        if (mx - mn <= 15) return false;
        if (Math.abs(r - g) <= 5 && b > g) return false;
        if (r > 60 && g > 40 && b > 20 && r > g && r > b && (r - g) > 5 && mx - mn > 15) return true;
        if (r > 170 && g > 120 && b > 80 && r > g && g > b && (r - b) > 30) return true;
        if (r > 80 && g > 50 && b > 30 && r > g && r > b && (r - g) > 8 && (r - g) < 80 && mx - mn > 20) return true;
        return false;
    }

    // ---- Clamp crop so image fully covers frame ----
    function clampCrop(value, image, isX) {
        const out = getOutputSize();
        const bw = image.bitmap.width;
        const bh = image.bitmap.height;
        const baseScale = Math.max(out.w / bw, out.h / bh);
        const scale = baseScale * (image.zoom || 1);

        if (isX) {
            const half = (out.w / 2) / (bw * scale);
            const minV = half;
            const maxV = 1 - half;
            if (maxV <= minV) return 0.5;
            return Math.max(minV, Math.min(maxV, value));
        } else {
            const half = (out.h / 2) / (bh * scale);
            const minV = half;
            const maxV = 1 - half;
            if (maxV <= minV) return 0.5;
            return Math.max(minV, Math.min(maxV, value));
        }
    }

    // ---- Preview sizing ----
    // Compute available height = viewport - all other visible UI elements
    function computeAvailableHeight() {
        const header = document.querySelector('.header');
        const tabs = document.querySelector('.aspect-tabs');
        const strip = document.querySelector('.thumb-strip-wrap');
        const filters = document.querySelector('.editor-filters');
        const actions = document.querySelector('.editor-actions');
        const previewWrap = editorPreview.parentElement;

        let used = 0;
        [header, tabs, strip, filters, actions].forEach(el => {
            if (el && el.offsetParent !== null) used += el.offsetHeight;
        });

        // editor-preview-wrap padding (top + bottom)
        const wrapStyle = window.getComputedStyle(previewWrap);
        used += parseFloat(wrapStyle.paddingTop) + parseFloat(wrapStyle.paddingBottom);

        // container gaps (~6 gaps of 8px) + paddings + safe areas (estimate)
        used += 56;

        const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        return Math.max(140, vh - used);
    }

    function resizePreview() {
        const out = getOutputSize();
        const ratio = out.w / out.h;

        const parent = editorPreview.parentElement;
        const parentStyle = window.getComputedStyle(parent);
        const parentInnerWidth = parent.clientWidth
            - parseFloat(parentStyle.paddingLeft)
            - parseFloat(parentStyle.paddingRight);

        const availableH = computeAvailableHeight();

        let pvW, pvH;
        if (ratio >= 1) {
            // 1:1 — width-bound or height-bound, whichever smaller
            pvW = Math.min(parentInnerWidth, availableH * ratio, PREVIEW_MAX_W);
            pvH = pvW / ratio;
        } else {
            // 9:16 — height-driven, with width fallback
            pvH = Math.min(availableH, PREVIEW_MAX_H);
            pvW = pvH * ratio;
            if (pvW > parentInnerWidth) {
                pvW = parentInnerWidth;
                pvH = pvW / ratio;
            }
        }

        pvW = Math.max(80, pvW);
        pvH = Math.max(80, pvH);

        const dpr = window.devicePixelRatio || 1;
        previewCanvas._dpr = dpr;
        previewCanvas.width = Math.round(pvW * dpr);
        previewCanvas.height = Math.round(pvH * dpr);
        previewCanvas.style.width = `${pvW}px`;
        previewCanvas.style.height = `${pvH}px`;
        editorPreview.style.width = `${pvW}px`;
        editorPreview.style.height = `${pvH}px`;
    }

    // ---- Draw image with crop into target ctx ----
    function drawImageWithCrop(targetCtx, image, outW, outH, dispW, dispH) {
        const dispScale = dispW / outW;
        const bw = image.bitmap.width;
        const bh = image.bitmap.height;
        const baseScale = Math.max(outW / bw, outH / bh);
        const scale = baseScale * (image.zoom || 1);

        const centerOutX = outW / 2 - (image.cropCx - 0.5) * bw * scale;
        const centerOutY = outH / 2 - (image.cropCy - 0.5) * bh * scale;

        const centerDispX = centerOutX * dispScale;
        const centerDispY = centerOutY * dispScale;
        const drawW = bw * scale * dispScale;
        const drawH = bh * scale * dispScale;

        targetCtx.save();
        targetCtx.imageSmoothingEnabled = true;
        targetCtx.imageSmoothingQuality = 'high';
        targetCtx.drawImage(
            image.bitmap,
            centerDispX - drawW / 2,
            centerDispY - drawH / 2,
            drawW,
            drawH
        );
        targetCtx.restore();
    }

    // ---- Render preview ----
    function renderPreview() {
        if (editingId === null) return;
        const image = images.find(i => i.id === editingId);
        if (!image) return;

        const cw = previewCanvas.width;
        const ch = previewCanvas.height;
        previewCtx.clearRect(0, 0, cw, ch);
        previewCtx.fillStyle = '#000';
        previewCtx.fillRect(0, 0, cw, ch);

        const out = getOutputSize();
        drawImageWithCrop(previewCtx, image, out.w, out.h, cw, ch);
    }

    // ---- CSS filter for preview (live) ----
    function previewFilterString(image) {
        const parts = [];
        if (image.blur > 0) parts.push(`blur(${image.blur}px)`);
        if (image.brightness !== 0) parts.push(`brightness(${1 + image.brightness / 200})`);
        return parts.join(' ') || 'none';
    }

    function updatePreviewFilter() {
        if (editingId === null) return;
        const image = images.find(i => i.id === editingId);
        if (!image) return;
        previewCanvas.style.filter = previewFilterString(image);
    }

    // ---- Downscale blur for output (ctx.filter 非対応環境のフォールバック) ----
    // radius = ctx.filter blur(radius px) 相当の強さ。
    // 目標半径から縮小率を逆算し、半減を繰り返して縮小→段階的に拡大で戻す
    // （バイリニア補間の累積でガウシアン風のぼかしになる。端の黒フチも出ない）
    function applyDownscaleBlur(canvas, radius) {
        if (radius <= 0) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const targetScale = 1 / Math.max(1, radius / 6);

        const a = document.createElement('canvas');
        const b = document.createElement('canvas');
        a.width = w; a.height = h;
        a.getContext('2d').drawImage(canvas, 0, 0);

        let src = a, dst = b, cw = w, ch = h;

        const step = (nw, nh) => {
            dst.width = Math.max(dst.width, nw);
            dst.height = Math.max(dst.height, nh);
            const dctx = dst.getContext('2d');
            dctx.imageSmoothingEnabled = true;
            dctx.imageSmoothingQuality = 'high';
            dctx.drawImage(src, 0, 0, cw, ch, 0, 0, nw, nh);
            const t = src; src = dst; dst = t;
            cw = nw; ch = nh;
        };

        // 半減を繰り返して目標縮小率まで落とす
        while (cw * 0.5 > w * targetScale && cw > 4 && ch > 4) {
            step(Math.max(2, Math.round(cw * 0.5)), Math.max(2, Math.round(ch * 0.5)));
        }
        const fw = Math.max(2, Math.round(w * targetScale));
        const fh = Math.max(2, Math.round(h * targetScale));
        if (fw < cw && fh < ch) step(fw, fh);

        // 段階的に拡大して戻す
        while (cw * 2 < w) {
            step(Math.min(w, cw * 2), Math.min(h, ch * 2));
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, cw, ch, 0, 0, w, h);
    }

    // ---- Output blur: プレビュー(CSS blur)と同じ見え方になるよう換算して適用 ----
    // ctx.filter 対応環境では blur(...) を使い、半径 = blur × (出力幅 / プレビュー表示幅)。
    // ぼけた層をシャープ層の上に重ねて端の黒フチ(フェード)を防ぐ。非対応なら縮小方式にフォールバック。
    const SUPPORTS_CANVAS_FILTER = (() => {
        try {
            const c = document.createElement('canvas').getContext('2d');
            c.filter = 'blur(1px)';
            return c.filter === 'blur(1px)';
        } catch (e) {
            return false;
        }
    })();

    function applyOutputBlur(outCanvas, oc, image, out) {
        if (image.blur <= 0) return;
        const dpr = previewCanvas._dpr || 1;
        const previewDisplayW = (previewCanvas.width / dpr) || out.w;
        const radius = image.blur * (out.w / previewDisplayW);

        if (SUPPORTS_CANVAS_FILTER) {
            const temp = document.createElement('canvas');
            temp.width = out.w;
            temp.height = out.h;
            const tc = temp.getContext('2d');
            tc.filter = `blur(${radius}px)`;
            tc.drawImage(outCanvas, 0, 0);
            tc.filter = 'none';
            oc.drawImage(temp, 0, 0); // ぼけ層をシャープ層に重ねる（端フェード防止）
        } else {
            applyDownscaleBlur(outCanvas, radius);
        }
    }

    // ---- Brightness fallback (ctx.filter 非対応 = 古いSafari等) ----
    // CSS brightness() と同じ線形乗算をピクセル直接操作で再現する
    function applyBrightnessPixels(canvas, ctx, brightness) {
        const factor = 1 + brightness / 200;
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            d[i] = Math.min(255, d[i] * factor);
            d[i + 1] = Math.min(255, d[i + 1] * factor);
            d[i + 2] = Math.min(255, d[i + 2] * factor);
        }
        ctx.putImageData(imgData, 0, 0);
    }

    // ---- Process for output ----
    async function processForOutput(image) {
        const out = getOutputSize();
        const outCanvas = document.createElement('canvas');
        outCanvas.width = out.w;
        outCanvas.height = out.h;
        const oc = outCanvas.getContext('2d');

        oc.fillStyle = '#000';
        oc.fillRect(0, 0, out.w, out.h);

        drawImageWithCrop(oc, image, out.w, out.h, out.w, out.h);

        applyOutputBlur(outCanvas, oc, image, out);

        if (image.brightness !== 0) {
            if (SUPPORTS_CANVAS_FILTER) {
                const temp = document.createElement('canvas');
                temp.width = out.w;
                temp.height = out.h;
                const tc = temp.getContext('2d');
                tc.filter = `brightness(${1 + image.brightness / 200})`;
                tc.drawImage(outCanvas, 0, 0);
                tc.filter = 'none';
                oc.clearRect(0, 0, out.w, out.h);
                oc.drawImage(temp, 0, 0);
            } else {
                applyBrightnessPixels(outCanvas, oc, image.brightness);
            }
        }

        return new Promise((resolve, reject) => {
            outCanvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error('Blob creation failed'));
            }, 'image/jpeg', JPEG_QUALITY);
        });
    }

    // ---- Thumb strip ----
    function rebuildThumbStrip() {
        thumbStrip.innerHTML = '';
        images.forEach((img, idx) => {
            const div = document.createElement('div');
            div.className = 'thumb-item' + (img.id === editingId ? ' active' : '');
            div.dataset.id = img.id;
            div.innerHTML = `
                <img src="${img.thumbDataUrl}" alt="">
                <span class="thumb-index">${idx + 1}</span>
            `;
            div.addEventListener('click', () => setEditingImage(img.id));
            thumbStrip.appendChild(div);
        });
    }

    // ---- Set editing image ----
    function setEditingImage(id) {
        editingId = id;
        document.querySelectorAll('.thumb-item').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.id, 10) === id);
        });

        const image = images.find(i => i.id === id);
        if (!image) return;

        // Sync sliders to this image's values
        blurRange.value = image.blur;
        blurValueEl.textContent = `${image.blur}`;
        brightnessRange.value = image.brightness;
        brightnessValueEl.textContent = image.brightness >= 0 ? `+${image.brightness}` : `${image.brightness}`;

        previewMeta.textContent = `${image.name} (${image.bitmap.width}×${image.bitmap.height})`;

        resizePreview();
        // Clamp crop in case aspect changed
        image.cropCx = clampCrop(image.cropCx, image, true);
        image.cropCy = clampCrop(image.cropCy, image, false);
        updatePreviewFilter();
        renderPreview();
    }

    // ---- Handle file upload ----
    async function handleFiles(files) {
        const remaining = MAX_FILES - images.length;
        if (remaining <= 0) {
            showToast(`最大${MAX_FILES}枚までです`);
            return;
        }
        const valid = files
            .filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type))
            .slice(0, remaining);

        if (valid.length === 0) {
            showToast('対応していないファイル形式です');
            return;
        }
        if (files.length > remaining) {
            showToast(`残り${remaining}枚まで。最初の${valid.length}枚を処理します`);
        }

        processingSection.style.display = 'block';
        progressFill.style.width = '0%';

        for (let i = 0; i < valid.length; i++) {
            const f = valid[i];
            processingText.textContent = `読み込み中... (${i + 1}/${valid.length})`;
            progressFill.style.width = `${(i / valid.length) * 100}%`;

            try {
                const bitmap = await loadBitmap(f);
                const suggested = await autoSuggestCrop(bitmap);
                const thumb = makeThumb(bitmap);

                const imageObj = {
                    id: nextId++,
                    name: f.name,
                    bitmap,
                    thumbDataUrl: thumb,
                    cropCx: suggested.cx,
                    cropCy: suggested.cy,
                    autoSuggested: { cx: suggested.cx, cy: suggested.cy },
                    blur: 0,
                    brightness: 0,
                    zoom: 1.0
                };

                imageObj.cropCx = clampCrop(imageObj.cropCx, imageObj, true);
                imageObj.cropCy = clampCrop(imageObj.cropCy, imageObj, false);

                images.push(imageObj);
            } catch (err) {
                console.error('Load failed:', err);
                showToast(`「${f.name}」の読み込みに失敗`);
            }

            progressFill.style.width = `${((i + 1) / valid.length) * 100}%`;
            await new Promise(r => setTimeout(r, 0));
        }

        processingSection.style.display = 'none';

        if (images.length > 0) {
            uploadSection.style.display = 'none';
            editorSection.style.display = 'block';
            rebuildThumbStrip();
            if (editingId === null || !images.find(i => i.id === editingId)) {
                setEditingImage(images[0].id);
            } else {
                setEditingImage(editingId);
            }
        }
        updateUploadCount();
        fileInput.value = '';
    }

    function updateUploadCount() {
        if (images.length > 0) {
            uploadCount.style.display = 'block';
            countText.textContent = `${images.length} / ${MAX_FILES} 枚`;
        } else {
            uploadCount.style.display = 'none';
        }
    }

    // ---- Download current ----
    async function downloadCurrent() {
        if (editingId === null) return;
        const image = images.find(i => i.id === editingId);
        if (!image) return;

        downloadBtn.disabled = true;
        try {
            const blob = await processForOutput(image);
            const aspectTag = aspectRatio.replace(':', 'x');
            const baseName = image.name.replace(/\.[^/.]+$/, '');
            const result = await triggerDownload(blob, `${baseName}_${aspectTag}.jpg`);
            if (result === 'shared') showToast('保存・共有しました');
            else if (result === 'downloaded') showToast('ダウンロードしました');
            // 'canceled'（共有シートを閉じた）は何も出さない
        } catch (err) {
            console.error(err);
            showToast('ダウンロードに失敗');
        } finally {
            downloadBtn.disabled = false;
        }
    }

    // blob を保存する。
    // 通常ブラウザ（Android Chrome / PC）は <a download> で「即ダウンロード保存」。
    // アプリ内ブラウザ（Instagram/LINE等）と iOS は <a download> が効かない/不安定なため、
    // Web Share API（共有・保存シート）にフォールバックする。
    // 戻り値: 'shared' | 'downloaded' | 'canceled'
    async function triggerDownload(blob, filename) {
        const ua = navigator.userAgent || '';
        // アプリ内ブラウザ（<a download> が無効化される）の検出
        const inAppBrowser = /Line\/|Instagram|FBAN|FBAV|FB_IAB|Twitter|MicroMessenger|; wv\)/i.test(ua);
        // iOS は <a download> が不安定（タブ内に開いてしまう）なので共有シート側へ
        const isIOS = /iPhone|iPad|iPod/i.test(ua);

        // --- アプリ内ブラウザ / iOS のみ: Web Share API ---
        if ((inAppBrowser || isIOS) && typeof File !== 'undefined' && navigator.canShare) {
            const file = new File([blob], filename, { type: 'image/jpeg' });
            if (navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({ files: [file] });
                    return 'shared';
                } catch (err) {
                    if (err && err.name === 'AbortError') return 'canceled';
                    // それ以外（共有失敗）は下のダウンロードにフォールバック
                }
            }
        }

        // --- 通常ブラウザ（Android Chrome / PC）: 直接ダウンロード＝即ストレージ保存 ---
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return 'downloaded';
    }

    // ---- Reset current ----
    function resetCurrent() {
        if (editingId === null) return;
        const image = images.find(i => i.id === editingId);
        if (!image) return;
        image.blur = 0;
        image.brightness = 0;
        image.zoom = 1.0;
        image.cropCx = image.autoSuggested.cx;
        image.cropCy = image.autoSuggested.cy;
        image.cropCx = clampCrop(image.cropCx, image, true);
        image.cropCy = clampCrop(image.cropCy, image, false);

        blurRange.value = 0;
        blurValueEl.textContent = '0';
        brightnessRange.value = 0;
        brightnessValueEl.textContent = '±0';

        updatePreviewFilter();
        renderPreview();
        showToast('この画像をリセットしました');
    }

    // ---- Remove current ----
    function removeCurrent() {
        if (editingId === null) return;
        const idx = images.findIndex(i => i.id === editingId);
        if (idx === -1) return;

        const img = images[idx];
        if (img.bitmap && typeof img.bitmap.close === 'function') {
            try { img.bitmap.close(); } catch (_) { }
        }
        images.splice(idx, 1);

        if (images.length === 0) {
            editingId = null;
            editorSection.style.display = 'none';
            uploadSection.style.display = 'block';
            thumbStrip.innerHTML = '';
            updateUploadCount();
            return;
        }

        rebuildThumbStrip();
        const newIdx = Math.min(idx, images.length - 1);
        setEditingImage(images[newIdx].id);
        updateUploadCount();
    }

    // ---- Clear all ----
    function clearAll() {
        if (!confirm('すべての画像をクリアしますか？')) return;
        images.forEach(img => {
            if (img.bitmap && typeof img.bitmap.close === 'function') {
                try { img.bitmap.close(); } catch (_) { }
            }
        });
        images = [];
        editingId = null;
        editorSection.style.display = 'none';
        uploadSection.style.display = 'block';
        thumbStrip.innerHTML = '';
        updateUploadCount();
        showToast('すべてクリアしました');
    }

    // ---- Toast ----
    function showToast(msg) {
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        document.body.appendChild(t);
        requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
        setTimeout(() => {
            t.classList.remove('show');
            setTimeout(() => t.remove(), 400);
        }, 3000);
    }

    // ---- Drag + Pinch handlers ----
    function attachDragHandlers() {
        editorPreview.addEventListener('pointerdown', (e) => {
            if (editingId === null) return;
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (activePointers.size === 1) {
                isDragging = true;
                editorPreview.classList.add('dragging');
                try { editorPreview.setPointerCapture(e.pointerId); } catch (_) { }
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                const image = images.find(i => i.id === editingId);
                if (image) {
                    dragStartCx = image.cropCx;
                    dragStartCy = image.cropCy;
                }
            } else if (activePointers.size === 2) {
                // Start pinch: stop drag, record distance and current zoom
                isDragging = false;
                editorPreview.classList.remove('dragging');
                const pts = [...activePointers.values()];
                pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                const image = images.find(i => i.id === editingId);
                if (image) pinchStartZoom = image.zoom || 1;
            }
        });

        editorPreview.addEventListener('pointermove', (e) => {
            if (!activePointers.has(e.pointerId)) return;
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;

            // Pinch — 2 pointers
            if (activePointers.size === 2) {
                const pts = [...activePointers.values()];
                const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                if (pinchStartDist > 0) {
                    const newZoom = pinchStartZoom * (dist / pinchStartDist);
                    image.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
                    image.cropCx = clampCrop(image.cropCx, image, true);
                    image.cropCy = clampCrop(image.cropCy, image, false);
                    renderPreview();
                }
                return;
            }

            // Drag — single pointer
            if (isDragging && activePointers.size === 1) {
                const dx = e.clientX - dragStartX;
                const dy = e.clientY - dragStartY;

                const out = getOutputSize();
                const bw = image.bitmap.width;
                const bh = image.bitmap.height;
                const baseScale = Math.max(out.w / bw, out.h / bh);
                const scale = baseScale * (image.zoom || 1);
                const dispScale = (previewCanvas.width / (previewCanvas._dpr || 1)) / out.w;

                const deltaCx = -dx / (bw * scale * dispScale);
                const deltaCy = -dy / (bh * scale * dispScale);

                image.cropCx = clampCrop(dragStartCx + deltaCx, image, true);
                image.cropCy = clampCrop(dragStartCy + deltaCy, image, false);
                renderPreview();
            }
        });

        const endPointer = (e) => {
            activePointers.delete(e.pointerId);
            if (activePointers.size < 2) pinchStartDist = 0;

            // Pinch → 1-pointer drag transition: re-anchor remaining pointer
            if (activePointers.size === 1 && editingId !== null) {
                const remaining = [...activePointers.values()][0];
                dragStartX = remaining.x;
                dragStartY = remaining.y;
                const image = images.find(i => i.id === editingId);
                if (image) {
                    dragStartCx = image.cropCx;
                    dragStartCy = image.cropCy;
                    isDragging = true;
                    editorPreview.classList.add('dragging');
                }
            }

            if (activePointers.size === 0) {
                isDragging = false;
                editorPreview.classList.remove('dragging');
            }
            try { editorPreview.releasePointerCapture(e.pointerId); } catch (_) { }
        };

        editorPreview.addEventListener('pointerup', endPointer);
        editorPreview.addEventListener('pointercancel', endPointer);

        // Wheel zoom (PC convenience)
        editorPreview.addEventListener('wheel', (e) => {
            if (editingId === null) return;
            e.preventDefault();
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            image.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (image.zoom || 1) + delta));
            image.cropCx = clampCrop(image.cropCx, image, true);
            image.cropCy = clampCrop(image.cropCy, image, false);
            renderPreview();
        }, { passive: false });
    }

    // ---- Bind events ----
    function bindEvents() {
        // Aspect tabs
        document.querySelectorAll('.aspect-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const newAspect = tab.dataset.aspect;
                if (newAspect === aspectRatio) return;
                aspectRatio = newAspect;
                document.querySelectorAll('.aspect-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Reset crop + zoom for all images (aspect change → meaning changes)
                images.forEach(img => {
                    img.cropCx = 0.5;
                    img.cropCy = 0.5;
                    img.zoom = 1.0;
                });

                if (editingId !== null) {
                    setEditingImage(editingId);
                } else {
                    resizePreview();
                    renderPreview();
                }
            });
        });

        // Upload click
        uploadArea.addEventListener('click', () => {
            if (images.length >= MAX_FILES) {
                showToast(`最大${MAX_FILES}枚までです`);
                return;
            }
            fileInput.click();
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                handleFiles(Array.from(e.target.files));
            } else {
                fileInput.value = '';
            }
        });

        // Drag & drop
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('drag-over');
        });
        uploadArea.addEventListener('dragleave', () => {
            uploadArea.classList.remove('drag-over');
        });
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('drag-over');
            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            if (files.length > 0) handleFiles(files);
        });

        addMoreBtn.addEventListener('click', () => {
            if (images.length >= MAX_FILES) {
                showToast(`最大${MAX_FILES}枚までです`);
                return;
            }
            fileInput.click();
        });

        // Blur slider - per image
        blurRange.addEventListener('input', () => {
            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            image.blur = parseInt(blurRange.value, 10);
            blurValueEl.textContent = `${image.blur}`;
            updatePreviewFilter();
        });

        // Brightness slider - per image
        brightnessRange.addEventListener('input', () => {
            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            image.brightness = parseInt(brightnessRange.value, 10);
            brightnessValueEl.textContent = image.brightness >= 0 ? `+${image.brightness}` : `${image.brightness}`;
            updatePreviewFilter();
        });

        // Actions
        downloadBtn.addEventListener('click', downloadCurrent);
        resetBtn.addEventListener('click', resetCurrent);
        removeOneBtn.addEventListener('click', removeCurrent);
        clearAllBtn.addEventListener('click', clearAll);

        // Resize - both window and visualViewport (iOS address bar)
        let resizeTimer = null;
        const onResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (editingId !== null) {
                    resizePreview();
                    renderPreview();
                }
            }, 100);
        };
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', onResize);
        }

        attachDragHandlers();
    }

})();
