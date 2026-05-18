/* ============================================
   InstaSquare - Multi-aspect Photo Editor
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

    const PRESETS = {
        none: [],
        vivid: ['brightness(1.05)', 'contrast(1.10)', 'saturate(1.25)'],
        mute: ['brightness(0.98)', 'contrast(1.05)', 'saturate(0.80)', 'sepia(0.10)'],
        film: ['brightness(1.02)', 'contrast(1.08)', 'saturate(1.10)', 'sepia(0.15)'],
        mono: ['saturate(0)', 'contrast(1.08)'],
        warm: ['brightness(1.03)', 'saturate(1.10)', 'sepia(0.20)', 'hue-rotate(-10deg)'],
        cool: ['brightness(1.02)', 'saturate(1.05)', 'hue-rotate(15deg)']
    };

    // ---- DOM helpers ----
    const $ = (id) => document.getElementById(id);

    const uploadArea = $('uploadArea');
    const fileInput = $('fileInput');
    const uploadSection = $('uploadSection');
    const uploadCount = $('uploadCount');
    const countText = $('countText');
    const editorSection = $('editorSection');
    const thumbStrip = $('thumbStrip');
    const addMoreBtnTop = $('addMoreBtnTop');

    const editorPreview = $('editorPreview');
    const previewCanvas = $('previewCanvas');
    const previewCtx = previewCanvas.getContext('2d');
    const beforeBadge = $('beforeBadge');
    const previewMeta = $('previewMeta');

    const zoomRange = $('zoomRange');
    const zoomValueEl = $('zoomValue');
    const rotateBtn = $('rotateBtn');
    const flipBtn = $('flipBtn');
    const autoBtn = $('autoBtn');
    const resetBtn = $('resetBtn');
    const beforeToggleBtn = $('beforeToggleBtn');
    const removeOneBtn = $('removeOneBtn');

    const blurRange = $('blurRange');
    const blurValueEl = $('blurValue');
    const brightnessRange = $('brightnessRange');
    const brightnessValueEl = $('brightnessValue');
    const contrastRange = $('contrastRange');
    const contrastValueEl = $('contrastValue');
    const saturationRange = $('saturationRange');
    const saturationValueEl = $('saturationValue');

    const filenamePrefixInput = $('filenamePrefix');
    const downloadSingleBtn = $('downloadSingleBtn');
    const downloadAllBtn = $('downloadAllBtn');
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
    let beforeMode = false;
    let faceDetector = null;
    let faceDetectionSupported = false;

    const global = {
        blur: 0,
        brightness: 0,
        contrast: 0,
        saturation: 0,
        preset: 'none'
    };

    // Pointer / drag state
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

    // ---- Output size ----
    function getOutputSize() {
        if (aspectRatio === '1:1') return { w: 1080, h: 1080 };
        return { w: 1080, h: 1920 };
    }

    // ---- Image load with EXIF orientation ----
    async function loadBitmap(file) {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (e) {
            // Fallback: HTMLImageElement (modern browsers also auto-apply EXIF)
            return await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = reject;
                img.src = URL.createObjectURL(file);
            });
        }
    }

    // ---- Make thumbnail (square center crop) ----
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

    // ---- Auto crop suggestion ----
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
                    cy = Math.max(0, cy - 0.04); // slightly above face center
                    return { cx, cy, faceDetected: true };
                }
            } catch (e) {
                console.warn('Face detection failed, falling back:', e);
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

        let imageData;
        try {
            imageData = cx.getImageData(0, 0, aW, aH);
        } catch (e) {
            return { cx: 0.5, cy: 0.5, faceDetected: false };
        }
        const data = imageData.data;

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

        if (total <= 0) return { cx: 0.5, cy: 0.5, faceDetected: false };
        return {
            cx: (wx / total) / aW,
            cy: (wy / total) / aH,
            faceDetected: false
        };
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

    // ---- Clamp crop so the image fully covers the output frame ----
    function clampCrop(value, image, isX) {
        const out = getOutputSize();
        const isSideways = image.rotation === 90 || image.rotation === 270;
        const dispImgW = isSideways ? image.bitmap.height : image.bitmap.width;
        const dispImgH = isSideways ? image.bitmap.width : image.bitmap.height;
        const baseScale = Math.max(out.w / dispImgW, out.h / dispImgH);
        const scale = baseScale * image.zoom;

        if (isX) {
            const half = (out.w / 2) / (dispImgW * scale);
            const minV = half;
            const maxV = 1 - half;
            if (maxV <= minV) return 0.5;
            return Math.max(minV, Math.min(maxV, value));
        } else {
            const half = (out.h / 2) / (dispImgH * scale);
            const minV = half;
            const maxV = 1 - half;
            if (maxV <= minV) return 0.5;
            return Math.max(minV, Math.min(maxV, value));
        }
    }

    // ---- Preview sizing ----
    function resizePreview() {
        const out = getOutputSize();
        const ratio = out.w / out.h;

        const parent = editorPreview.parentElement;
        const parentWidth = parent.clientWidth - 32; // padding

        let pvW, pvH;

        if (ratio >= 1) {
            // 1:1
            pvW = Math.min(parentWidth, PREVIEW_MAX_W);
            pvH = pvW / ratio;
        } else {
            // 9:16 (tall)
            pvH = Math.min(PREVIEW_MAX_H, window.innerHeight * 0.62);
            pvW = pvH * ratio;
            if (pvW > parentWidth) {
                pvW = parentWidth;
                pvH = pvW / ratio;
            }
        }

        const dpr = window.devicePixelRatio || 1;
        previewCanvas._dpr = dpr;

        previewCanvas.width = Math.round(pvW * dpr);
        previewCanvas.height = Math.round(pvH * dpr);
        previewCanvas.style.width = `${pvW}px`;
        previewCanvas.style.height = `${pvH}px`;

        editorPreview.style.width = `${pvW}px`;
        editorPreview.style.height = `${pvH}px`;
    }

    // ---- Draw image with crop/rotate/flip into target ctx ----
    function drawImageWithCropRotate(targetCtx, image, outW, outH, dispW, dispH) {
        const dispScale = dispW / outW;

        const isSideways = image.rotation === 90 || image.rotation === 270;
        const bw = image.bitmap.width;
        const bh = image.bitmap.height;
        const dispImgW = isSideways ? bh : bw;
        const dispImgH = isSideways ? bw : bh;

        const baseScale = Math.max(outW / dispImgW, outH / dispImgH);
        const scale = baseScale * image.zoom;

        const centerOutX = outW / 2 - (image.cropCx - 0.5) * dispImgW * scale;
        const centerOutY = outH / 2 - (image.cropCy - 0.5) * dispImgH * scale;

        const centerDispX = centerOutX * dispScale;
        const centerDispY = centerOutY * dispScale;

        const drawWDisp = bw * scale * dispScale;
        const drawHDisp = bh * scale * dispScale;

        targetCtx.save();
        targetCtx.translate(centerDispX, centerDispY);
        if (image.rotation) targetCtx.rotate(image.rotation * Math.PI / 180);
        if (image.flipH) targetCtx.scale(-1, 1);
        targetCtx.imageSmoothingEnabled = true;
        targetCtx.imageSmoothingQuality = 'high';
        targetCtx.drawImage(image.bitmap, -drawWDisp / 2, -drawHDisp / 2, drawWDisp, drawHDisp);
        targetCtx.restore();
    }

    // ---- Render preview (canvas) ----
    function renderPreview() {
        if (editingId === null) return;
        const image = images.find(i => i.id === editingId);
        if (!image) return;

        const cw = previewCanvas.width;
        const ch = previewCanvas.height;

        previewCtx.clearRect(0, 0, cw, ch);
        previewCtx.fillStyle = '#000';
        previewCtx.fillRect(0, 0, cw, ch);

        if (beforeMode) {
            const bw = image.bitmap.width;
            const bh = image.bitmap.height;
            const sc = Math.min(cw / bw, ch / bh);
            const dw = bw * sc;
            const dh = bh * sc;
            const dx = (cw - dw) / 2;
            const dy = (ch - dh) / 2;
            previewCtx.imageSmoothingEnabled = true;
            previewCtx.imageSmoothingQuality = 'high';
            previewCtx.drawImage(image.bitmap, dx, dy, dw, dh);
            return;
        }

        const out = getOutputSize();
        drawImageWithCropRotate(previewCtx, image, out.w, out.h, cw, ch);
    }

    // ---- Filter strings ----
    function buildPreviewFilterString() {
        const filters = [];
        const preset = PRESETS[global.preset];
        if (preset && preset.length) filters.push(...preset);
        if (global.blur > 0) filters.push(`blur(${global.blur}px)`);
        if (global.brightness !== 0) filters.push(`brightness(${1 + global.brightness / 200})`);
        if (global.contrast !== 0) filters.push(`contrast(${1 + global.contrast / 200})`);
        if (global.saturation !== 0) filters.push(`saturate(${Math.max(0, 1 + global.saturation / 100)})`);
        return filters.join(' ') || 'none';
    }

    function buildColorFilterString() {
        const filters = [];
        const preset = PRESETS[global.preset];
        if (preset && preset.length) filters.push(...preset);
        if (global.brightness !== 0) filters.push(`brightness(${1 + global.brightness / 200})`);
        if (global.contrast !== 0) filters.push(`contrast(${1 + global.contrast / 200})`);
        if (global.saturation !== 0) filters.push(`saturate(${Math.max(0, 1 + global.saturation / 100)})`);
        return filters.length ? filters.join(' ') : 'none';
    }

    function hasColorFilter() {
        return global.preset !== 'none' || global.brightness !== 0 || global.contrast !== 0 || global.saturation !== 0;
    }

    function updatePreviewFilter() {
        if (beforeMode) {
            previewCanvas.style.filter = 'none';
        } else {
            previewCanvas.style.filter = buildPreviewFilterString();
        }
    }

    // ---- Downscale blur (artifact-free, rectangle-friendly) ----
    function applyDownscaleBlur(canvas, amount) {
        if (amount <= 0) return;
        const ctx = canvas.getContext('2d');
        const finalW = canvas.width;
        const finalH = canvas.height;

        const passes = Math.min(Math.ceil(amount / 5), 20);
        const scaleFactor = Math.max(0.01, 1 - (amount / 120));

        const temp = document.createElement('canvas');
        const tctx = temp.getContext('2d');

        for (let i = 0; i < passes; i++) {
            const smallW = Math.max(2, Math.round(finalW * scaleFactor));
            const smallH = Math.max(2, Math.round(finalH * scaleFactor));

            temp.width = smallW;
            temp.height = smallH;
            tctx.imageSmoothingEnabled = true;
            tctx.imageSmoothingQuality = 'high';
            tctx.drawImage(canvas, 0, 0, smallW, smallH);

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.clearRect(0, 0, finalW, finalH);
            ctx.drawImage(temp, 0, 0, finalW, finalH);
        }
    }

    // ---- Process for output (final render) ----
    async function processForOutput(image) {
        const out = getOutputSize();
        const outCanvas = document.createElement('canvas');
        outCanvas.width = out.w;
        outCanvas.height = out.h;
        const oc = outCanvas.getContext('2d');

        oc.fillStyle = '#000';
        oc.fillRect(0, 0, out.w, out.h);

        drawImageWithCropRotate(oc, image, out.w, out.h, out.w, out.h);

        // Step 1: Blur (downscale method)
        if (global.blur > 0) {
            applyDownscaleBlur(outCanvas, global.blur);
        }

        // Step 2: Color filters via ctx.filter on a copy
        if (hasColorFilter()) {
            const temp = document.createElement('canvas');
            temp.width = out.w;
            temp.height = out.h;
            const tc = temp.getContext('2d');
            tc.filter = buildColorFilterString();
            tc.drawImage(outCanvas, 0, 0);
            tc.filter = 'none';

            oc.clearRect(0, 0, out.w, out.h);
            oc.drawImage(temp, 0, 0);
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
                <img src="${img.thumbDataUrl}" alt="${escapeHtml(img.name)}">
                <span class="thumb-index">${idx + 1}</span>
                ${img.faceDetected ? '<span class="thumb-face">👤</span>' : ''}
            `;
            div.addEventListener('click', () => setEditingImage(img.id));
            thumbStrip.appendChild(div);
        });
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // ---- Set editing image ----
    function setEditingImage(id) {
        editingId = id;
        beforeMode = false;
        beforeToggleBtn.classList.remove('active');
        beforeBadge.style.display = 'none';

        document.querySelectorAll('.thumb-item').forEach(el => {
            el.classList.toggle('active', parseInt(el.dataset.id, 10) === id);
        });

        const image = images.find(i => i.id === id);
        if (!image) return;

        zoomRange.value = Math.round(image.zoom * 100);
        zoomValueEl.textContent = `${image.zoom.toFixed(1)}x`;

        previewMeta.textContent = `${image.name} (${image.bitmap.width}×${image.bitmap.height})`;

        resizePreview();
        updatePreviewFilter();
        renderPreview();
    }

    // ---- Handle file upload ----
    async function handleFiles(files) {
        const remaining = MAX_FILES - images.length;
        if (remaining <= 0) {
            showToast(`最大${MAX_FILES}枚までアップロードできます`);
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
            showToast(`残り${remaining}枚までアップロード可能。最初の${valid.length}枚を処理します`);
        }

        processingSection.style.display = 'block';
        progressFill.style.width = '0%';

        for (let i = 0; i < valid.length; i++) {
            const f = valid[i];
            processingText.textContent = `画像を読み込み中... (${i + 1}/${valid.length})`;
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
                    zoom: 1.0,
                    rotation: 0,
                    flipH: false,
                    autoSuggested: { cx: suggested.cx, cy: suggested.cy },
                    faceDetected: suggested.faceDetected
                };

                // Clamp initial crop based on aspect
                imageObj.cropCx = clampCrop(imageObj.cropCx, imageObj, true);
                imageObj.cropCy = clampCrop(imageObj.cropCy, imageObj, false);

                images.push(imageObj);
            } catch (err) {
                console.error('Image load failed:', err);
                showToast(`「${f.name}」の読み込みに失敗しました`);
            }

            progressFill.style.width = `${((i + 1) / valid.length) * 100}%`;

            // Yield to UI
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
            countText.textContent = `${images.length} / ${MAX_FILES} 枚アップロード済み`;
        } else {
            uploadCount.style.display = 'none';
        }
    }

    // ---- Download single ----
    async function downloadSingleCurrent() {
        if (editingId === null) return;
        const image = images.find(i => i.id === editingId);
        if (!image) return;

        downloadSingleBtn.disabled = true;
        try {
            const blob = await processForOutput(image);
            const aspectTag = aspectRatio === '1:1' ? '1x1' : '9x16';
            const baseName = image.name.replace(/\.[^/.]+$/, '');
            triggerDownload(blob, `${baseName}_${aspectTag}.jpg`);
            showToast('ダウンロードしました');
        } catch (err) {
            console.error(err);
            showToast('ダウンロードに失敗しました');
        } finally {
            downloadSingleBtn.disabled = false;
        }
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke later to ensure download starts
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ---- Download all as ZIP ----
    async function downloadAllAsZip() {
        if (images.length === 0) return;
        if (typeof JSZip === 'undefined') {
            showToast('ZIPライブラリの読み込みに失敗しました');
            return;
        }

        downloadAllBtn.disabled = true;
        const originalHtml = downloadAllBtn.innerHTML;
        downloadAllBtn.textContent = 'ZIP作成中...';

        processingSection.style.display = 'block';
        progressFill.style.width = '0%';

        try {
            const zip = new JSZip();
            const folder = zip.folder('InstaSquare');

            const rawPrefix = filenamePrefixInput.value.trim();
            const prefix = sanitizeFilename(rawPrefix) || 'insta';
            const padLen = Math.max(2, String(images.length).length);
            const aspectTag = aspectRatio === '1:1' ? '1x1' : '9x16';

            for (let i = 0; i < images.length; i++) {
                processingText.textContent = `加工中... (${i + 1}/${images.length})`;
                progressFill.style.width = `${(i / images.length) * 100}%`;
                const blob = await processForOutput(images[i]);
                const num = String(i + 1).padStart(padLen, '0');
                const fname = `${prefix}_${num}_${aspectTag}.jpg`;
                folder.file(fname, blob);
                await new Promise(r => setTimeout(r, 0));
            }

            processingText.textContent = 'ZIP生成中...';
            const content = await zip.generateAsync({ type: 'blob' });
            triggerDownload(content, `${prefix}_${aspectTag}.zip`);

            showToast(`${images.length}枚をZIPでダウンロードしました`);
        } catch (err) {
            console.error('ZIP creation failed:', err);
            showToast('ZIPの作成に失敗しました');
        } finally {
            downloadAllBtn.disabled = false;
            downloadAllBtn.innerHTML = originalHtml;
            processingSection.style.display = 'none';
        }
    }

    function sanitizeFilename(s) {
        return s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 60);
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

    // ---- Remove current image ----
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

    // ---- Pointer / drag / pinch ----
    function attachPointerHandlers() {
        editorPreview.addEventListener('pointerdown', (e) => {
            if (beforeMode || editingId === null) return;
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (activePointers.size === 1) {
                isDragging = true;
                editorPreview.classList.add('dragging');
                try { editorPreview.setPointerCapture(e.pointerId); } catch (_) { }
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                const image = images.find(i => i.id === editingId);
                dragStartCx = image.cropCx;
                dragStartCy = image.cropCy;
            } else if (activePointers.size === 2) {
                isDragging = false;
                editorPreview.classList.remove('dragging');
                const pts = [...activePointers.values()];
                pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                const image = images.find(i => i.id === editingId);
                pinchStartZoom = image.zoom;
            }
        });

        editorPreview.addEventListener('pointermove', (e) => {
            if (!activePointers.has(e.pointerId)) return;
            activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;

            if (activePointers.size === 2) {
                const pts = [...activePointers.values()];
                const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                if (pinchStartDist > 0) {
                    image.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchStartZoom * (dist / pinchStartDist)));
                    zoomRange.value = Math.round(image.zoom * 100);
                    zoomValueEl.textContent = `${image.zoom.toFixed(1)}x`;
                    image.cropCx = clampCrop(image.cropCx, image, true);
                    image.cropCy = clampCrop(image.cropCy, image, false);
                    renderPreview();
                }
                return;
            }

            if (isDragging && activePointers.size === 1) {
                const dx = e.clientX - dragStartX;
                const dy = e.clientY - dragStartY;

                const out = getOutputSize();
                const isSideways = image.rotation === 90 || image.rotation === 270;
                const dispImgW = isSideways ? image.bitmap.height : image.bitmap.width;
                const dispImgH = isSideways ? image.bitmap.width : image.bitmap.height;
                const baseScale = Math.max(out.w / dispImgW, out.h / dispImgH);
                const scale = baseScale * image.zoom;

                const dispScale = (previewCanvas.width / (previewCanvas._dpr || 1)) / out.w;

                const deltaCx = -dx / (dispImgW * scale * dispScale);
                const deltaCy = -dy / (dispImgH * scale * dispScale);

                image.cropCx = clampCrop(dragStartCx + deltaCx, image, true);
                image.cropCy = clampCrop(dragStartCy + deltaCy, image, false);
                renderPreview();
            }
        });

        const endPointer = (e) => {
            activePointers.delete(e.pointerId);
            if (activePointers.size < 2) pinchStartDist = 0;

            if (activePointers.size === 1 && editingId !== null) {
                // Transition from pinch back to drag: re-anchor the remaining pointer
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

        // Wheel zoom
        editorPreview.addEventListener('wheel', (e) => {
            if (beforeMode || editingId === null) return;
            e.preventDefault();
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            image.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, image.zoom + delta));
            zoomRange.value = Math.round(image.zoom * 100);
            zoomValueEl.textContent = `${image.zoom.toFixed(1)}x`;
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

                // Reset crop center for all images
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
                showToast(`最大${MAX_FILES}枚までアップロードできます`);
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

        // Add more (top button in editor)
        addMoreBtnTop.addEventListener('click', () => {
            if (images.length >= MAX_FILES) {
                showToast(`最大${MAX_FILES}枚までアップロードできます`);
                return;
            }
            fileInput.click();
        });

        // Zoom slider
        zoomRange.addEventListener('input', () => {
            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            image.zoom = parseInt(zoomRange.value, 10) / 100;
            zoomValueEl.textContent = `${image.zoom.toFixed(1)}x`;
            image.cropCx = clampCrop(image.cropCx, image, true);
            image.cropCy = clampCrop(image.cropCy, image, false);
            renderPreview();
        });

        // Rotate
        rotateBtn.addEventListener('click', () => {
            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            image.rotation = (image.rotation + 90) % 360;
            // Rotation changes axis meaning → reset crop center
            image.cropCx = 0.5;
            image.cropCy = 0.5;
            image.cropCx = clampCrop(image.cropCx, image, true);
            image.cropCy = clampCrop(image.cropCy, image, false);
            renderPreview();
        });

        // Flip
        flipBtn.addEventListener('click', () => {
            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            image.flipH = !image.flipH;
            image.cropCx = 1 - image.cropCx;
            image.cropCx = clampCrop(image.cropCx, image, true);
            renderPreview();
        });

        // Auto (re-detect)
        autoBtn.addEventListener('click', async () => {
            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            autoBtn.disabled = true;
            try {
                const suggested = await autoSuggestCrop(image.bitmap);
                image.cropCx = suggested.cx;
                image.cropCy = suggested.cy;
                image.autoSuggested = { cx: suggested.cx, cy: suggested.cy };
                image.faceDetected = suggested.faceDetected;
                image.zoom = 1.0;
                image.rotation = 0;
                image.flipH = false;
                zoomRange.value = 100;
                zoomValueEl.textContent = '1.0x';
                image.cropCx = clampCrop(image.cropCx, image, true);
                image.cropCy = clampCrop(image.cropCy, image, false);
                renderPreview();
                rebuildThumbStrip();
                showToast('自動配置を実行しました');
            } catch (e) {
                console.error(e);
                showToast('自動配置に失敗しました');
            } finally {
                autoBtn.disabled = false;
            }
        });

        // Reset
        resetBtn.addEventListener('click', () => {
            if (editingId === null) return;
            const image = images.find(i => i.id === editingId);
            if (!image) return;
            image.cropCx = image.autoSuggested.cx;
            image.cropCy = image.autoSuggested.cy;
            image.zoom = 1.0;
            image.rotation = 0;
            image.flipH = false;
            zoomRange.value = 100;
            zoomValueEl.textContent = '1.0x';
            image.cropCx = clampCrop(image.cropCx, image, true);
            image.cropCy = clampCrop(image.cropCy, image, false);
            renderPreview();
        });

        // Before/After toggle
        beforeToggleBtn.addEventListener('click', () => {
            beforeMode = !beforeMode;
            beforeToggleBtn.classList.toggle('active', beforeMode);
            beforeBadge.style.display = beforeMode ? 'block' : 'none';
            updatePreviewFilter();
            renderPreview();
        });

        // Remove current
        removeOneBtn.addEventListener('click', removeCurrent);

        // Preset buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                global.preset = btn.dataset.preset;
                updatePreviewFilter();
            });
        });

        // Filter sliders
        blurRange.addEventListener('input', () => {
            global.blur = parseInt(blurRange.value, 10);
            blurValueEl.textContent = `${global.blur}px`;
            updatePreviewFilter();
        });
        brightnessRange.addEventListener('input', () => {
            global.brightness = parseInt(brightnessRange.value, 10);
            brightnessValueEl.textContent = global.brightness >= 0 ? `+${global.brightness}` : `${global.brightness}`;
            updatePreviewFilter();
        });
        contrastRange.addEventListener('input', () => {
            global.contrast = parseInt(contrastRange.value, 10);
            contrastValueEl.textContent = global.contrast >= 0 ? `+${global.contrast}` : `${global.contrast}`;
            updatePreviewFilter();
        });
        saturationRange.addEventListener('input', () => {
            global.saturation = parseInt(saturationRange.value, 10);
            saturationValueEl.textContent = global.saturation >= 0 ? `+${global.saturation}` : `${global.saturation}`;
            updatePreviewFilter();
        });

        // Outputs
        downloadSingleBtn.addEventListener('click', downloadSingleCurrent);
        downloadAllBtn.addEventListener('click', downloadAllAsZip);
        clearAllBtn.addEventListener('click', clearAll);

        // Window resize
        let resizeTimer = null;
        window.addEventListener('resize', () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (editingId !== null) {
                    resizePreview();
                    renderPreview();
                }
            }, 100);
        });

        attachPointerHandlers();
    }

})();
