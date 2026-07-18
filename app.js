/**
 * Shubh PDF Converter - Core Application Logic (Offline Edition)
 * ─────────────────────────────────────────────────────────────────────────────
 * Architecture: 100% offline, air-gapped, zero cloud dependencies.
 * Storage:      File System Access API → writes to OS filesystem directly.
 *   · ./uploads/  — raw image buffers during session
 *   · ./output/   — final compiled PDF documents
 * Cleanup:      uploads/ is purged automatically after successful PDF write.
 *
 * Browser Support: Chrome/Edge 86+. Graceful fallback message for Firefox/Safari.
 * Format Support:  PNG, JPG, JPEG, WebP, SVG, BMP, TIFF (via UTIF.js).
 */

// ─── Application State ───────────────────────────────────────────────────────
let selectedImages    = [];    // [{ id, file, name, src, fsHandle }]
let sortableInstance  = null;
let isGenerating      = false;
let dragHintDismissed = false;
let lightboxIndex     = -1;

// ─── File System Handles ─────────────────────────────────────────────────────
let rootDirHandle    = null;   // FileSystemDirectoryHandle → "New folder"
let uploadsDirHandle = null;   // FileSystemDirectoryHandle → "New folder/uploads"
let outputDirHandle  = null;   // FileSystemDirectoryHandle → "New folder/output"
const FS_API_SUPPORTED = ('showDirectoryPicker' in window);

// ─── DOM Elements – core ─────────────────────────────────────────────────────
const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const clearQueueBtn     = document.getElementById('clear-queue-btn');
const addMoreBtn        = document.getElementById('add-more-btn');
const emptyState        = document.getElementById('empty-state');
const thumbnailGrid     = document.getElementById('thumbnail-grid');
const convertBtn        = document.getElementById('convert-btn');
const progressContainer = document.getElementById('progress-container');
const progressStatus    = document.getElementById('progress-status');
const progressPercent   = document.getElementById('progress-percent');
const progressFill      = document.getElementById('progress-fill');
const imageCount        = document.getElementById('image-count');
const summaryText       = document.getElementById('summary-text');
const toast             = document.getElementById('toast');
const toastMessage      = document.getElementById('toast-message');
const toastIcon         = document.getElementById('toast-icon');

// ─── DOM Elements – folder setup ─────────────────────────────────────────────
const folderSetupBanner  = document.getElementById('folder-setup-banner');
const selectFolderBtn    = document.getElementById('select-folder-btn');
const folderStatusText   = document.getElementById('folder-status-text');
const uploadsPathBadge   = document.getElementById('uploads-path-badge');
const outputPathBadge    = document.getElementById('output-path-badge');
const pathIndicatorRow   = document.getElementById('path-indicator-row');
const fsWarningBanner    = document.getElementById('fs-warning-banner');

// ─── DOM Elements – drag hint ─────────────────────────────────────────────────
const dragHint      = document.getElementById('drag-hint');
const dragHintClose = document.getElementById('drag-hint-close');

// ─── DOM Elements – lightbox ──────────────────────────────────────────────────
const lightboxOverlay = document.getElementById('lightbox-overlay');
const lightboxImg     = document.getElementById('lightbox-img');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxClose   = document.getElementById('lightbox-close');
const lightboxPrev    = document.getElementById('lightbox-prev');
const lightboxNext    = document.getElementById('lightbox-next');

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (typeof lucide !== 'undefined') lucide.createIcons();
  checkFSApiSupport();
  setupEventListeners();
});

// ─── File System API Compatibility Check ─────────────────────────────────────
function checkFSApiSupport() {
  if (!FS_API_SUPPORTED) {
    // Show warning; hide folder setup; fall back to download-only mode
    if (fsWarningBanner)    fsWarningBanner.classList.remove('hidden');
    if (folderSetupBanner)  folderSetupBanner.classList.add('hidden');
    if (pathIndicatorRow)   pathIndicatorRow.classList.add('hidden');
    showToast('Your browser does not support the File System Access API. PDF will download normally instead of saving to disk.', 'error');
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
function setupEventListeners() {
  // Folder selection
  if (selectFolderBtn) {
    selectFolderBtn.addEventListener('click', setupProjectDirectory);
  }

  // Drop-zone drag events
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', (e) => {
    if (dropZone.contains(e.relatedTarget)) return;
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (isGenerating) return;
    handleFiles(e.dataTransfer.files);
  });

  // File picker input
  fileInput.addEventListener('change', (e) => {
    if (isGenerating) return;
    handleFiles(e.target.files);
    fileInput.value = '';
  });

  // Add More
  addMoreBtn.addEventListener('click', () => {
    if (isGenerating) return;
    fileInput.click();
  });

  // Clear Queue
  clearQueueBtn.addEventListener('click', () => {
    if (isGenerating) return;
    clearQueue();
  });

  // Convert to PDF
  convertBtn.addEventListener('click', () => {
    if (isGenerating || selectedImages.length === 0) return;
    generatePDF();
  });

  // Drag hint dismiss
  dragHintClose.addEventListener('click', dismissDragHint);

  // Lightbox controls
  lightboxClose.addEventListener('click', closeLightbox);
  lightboxOverlay.addEventListener('click', (e) => {
    if (e.target === lightboxOverlay) closeLightbox();
  });
  lightboxPrev.addEventListener('click', () => navigateLightbox(-1));
  lightboxNext.addEventListener('click', () => navigateLightbox(1));

  // Keyboard: Escape closes lightbox, arrows navigate
  document.addEventListener('keydown', (e) => {
    if (!lightboxOverlay.classList.contains('open')) return;
    if (e.key === 'Escape')     closeLightbox();
    if (e.key === 'ArrowLeft')  navigateLightbox(-1);
    if (e.key === 'ArrowRight') navigateLightbox(1);
  });
}

// ─── File System: Setup Project Directory ────────────────────────────────────
/**
 * Prompts user to select the root project directory (e.g. "New folder").
 * Creates uploads/ and output/ subdirectories inside it.
 * Grants all subsequent FS operations access to those handles.
 */
async function setupProjectDirectory() {
  if (!FS_API_SUPPORTED) return;

  try {
    // Ask user to pick the project root folder
    rootDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    // Validate: warn if the name doesn't match "New folder"
    if (rootDirHandle.name !== 'New folder') {
      showToast(`Warning: You selected "${rootDirHandle.name}" — expected "New folder". Proceeding anyway.`, 'error');
    }

    // Create uploads/ sub-directory (create if missing)
    uploadsDirHandle = await rootDirHandle.getDirectoryHandle('uploads', { create: true });

    // Create output/ sub-directory (create if missing)
    outputDirHandle = await rootDirHandle.getDirectoryHandle('output', { create: true });

    // Update UI
    folderStatusText.textContent = `✔ Connected: ${rootDirHandle.name}`;
    folderStatusText.classList.add('status-connected');

    if (uploadsPathBadge) uploadsPathBadge.textContent = `${rootDirHandle.name}/uploads/`;
    if (outputPathBadge)  outputPathBadge.textContent  = `${rootDirHandle.name}/output/`;
    if (pathIndicatorRow) pathIndicatorRow.classList.remove('hidden');

    // Collapse the setup banner after connection
    folderSetupBanner.classList.add('connected');

    showToast(`Folder connected! Uploads → "${rootDirHandle.name}/uploads/"  ·  PDFs → "${rootDirHandle.name}/output/"`, 'success');

  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled picker — do nothing
    console.error('Directory setup failed:', err);
    showToast('Failed to access the selected folder. Please try again.', 'error');
  }
}

// ─── File System: Save Image to uploads/ ─────────────────────────────────────
/**
 * Writes an image File object to the uploads/ subdirectory.
 * Returns the FileSystemFileHandle for later reference/deletion.
 * Falls back gracefully (no-op) if FS API not available/not set up.
 */
async function saveImageToUploads(file, uniqueName) {
  if (!uploadsDirHandle) return null;

  try {
    const fileHandle = await uploadsDirHandle.getFileHandle(uniqueName, { create: true });
    const writable   = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
    return fileHandle;
  } catch (err) {
    console.warn(`Could not save "${uniqueName}" to uploads/:`, err);
    return null;
  }
}

// ─── File System: Write PDF to output/ ───────────────────────────────────────
/**
 * Writes a PDF Blob into the output/ subdirectory.
 * Returns true on success, false on failure.
 */
async function writePdfToOutput(pdfBlob, filename) {
  if (!outputDirHandle) return false;

  try {
    const fileHandle = await outputDirHandle.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();
    await writable.write(pdfBlob);
    await writable.close();
    return true;
  } catch (err) {
    console.error('Failed to write PDF to output/:', err);
    return false;
  }
}

// ─── File System: Delete One File from uploads/ ───────────────────────────────
async function deleteFromUploads(uniqueName) {
  if (!uploadsDirHandle) return;
  try {
    await uploadsDirHandle.removeEntry(uniqueName);
  } catch (err) {
    // Non-fatal; file may have already been removed
    console.warn(`Could not delete "${uniqueName}" from uploads/:`, err);
  }
}

// ─── File System: Cleanup uploads/ ───────────────────────────────────────────
/**
 * Removes every file from the uploads/ directory.
 * Called after the PDF is successfully written to output/.
 */
async function cleanupUploads() {
  if (!uploadsDirHandle) return;

  try {
    const deletions = [];
    for await (const [name] of uploadsDirHandle.entries()) {
      deletions.push(uploadsDirHandle.removeEntry(name));
    }
    await Promise.all(deletions);
    console.log(`Uploads folder purged (${deletions.length} files removed).`);
  } catch (err) {
    console.warn('Cleanup of uploads/ partially failed:', err);
  }
}

// ─── Accepted Formats ────────────────────────────────────────────────────────
const ACCEPTED_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png',
  'image/webp', 'image/svg+xml', 'image/bmp', 'image/tiff',
]);
const ACCEPTED_EXTENSIONS = new Set(['.jpg','.jpeg','.png','.webp','.svg','.bmp','.tif','.tiff']);

function isAcceptedFile(file) {
  if (ACCEPTED_MIME_TYPES.has(file.type)) return true;
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return ACCEPTED_EXTENSIONS.has(ext);
}

// ─── File Processing ──────────────────────────────────────────────────────────
async function handleFiles(files) {
  const validFiles = [];
  const skipped    = [];

  Array.from(files).forEach(file => {
    if (isAcceptedFile(file)) {
      validFiles.push(file);
    } else {
      skipped.push(file.name);
    }
  });

  if (skipped.length > 0) {
    showToast(
      `Skipped ${skipped.length} unsupported file${skipped.length > 1 ? 's' : ''}: "${skipped[0]}"${skipped.length > 1 ? ` +${skipped.length - 1} more` : ''}. Accepted: PNG, JPG, WebP, SVG, BMP, TIFF`,
      'error'
    );
  }

  if (validFiles.length === 0) return;

  // Process each file: persist to uploads/ and create object URL for preview
  const addedCount = validFiles.length;
  for (const file of validFiles) {
    const id         = 'img_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    const uniqueName = id + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Write to disk (non-blocking; falls back gracefully if no folder set up)
    const fsHandle = await saveImageToUploads(file, uniqueName);

    selectedImages.push({
      id,
      file,
      name: file.name,
      uniqueName,       // filename inside uploads/ directory
      fsHandle,         // FileSystemFileHandle (null if FS API not used)
      src: URL.createObjectURL(file),  // blob:// URL for thumbnail display
    });
  }

  renderGallery();

  if (uploadsDirHandle) {
    showToast(`Saved ${addedCount} image${addedCount > 1 ? 's' : ''} → uploads/ · Ready to queue.`, 'success');
  } else {
    showToast(`Added ${addedCount} image${addedCount > 1 ? 's' : ''} successfully.`, 'success');
  }
}

// ─── Render Gallery Grid ──────────────────────────────────────────────────────
function renderGallery() {
  const count = selectedImages.length;

  if (count === 0) {
    emptyState.classList.remove('hidden');
    thumbnailGrid.classList.add('hidden');
    clearQueueBtn.classList.add('hidden');
    addMoreBtn.classList.add('hidden');
    convertBtn.disabled = true;
    imageCount.textContent  = '0 images';
    summaryText.textContent = 'No files selected';
    hideDragHint();
    return;
  }

  emptyState.classList.add('hidden');
  thumbnailGrid.classList.remove('hidden');
  clearQueueBtn.classList.remove('hidden');
  addMoreBtn.classList.remove('hidden');
  convertBtn.disabled = false;
  imageCount.textContent  = `${count} image${count !== 1 ? 's' : ''}`;
  summaryText.textContent = `${count} image${count !== 1 ? 's' : ''} queued`;

  if (!dragHintDismissed) showDragHint();

  // Build Grid Items
  thumbnailGrid.innerHTML = '';
  selectedImages.forEach((imgObj, index) => {
    const isFirst = index === 0;
    const isLast  = index === count - 1;

    const card = document.createElement('div');
    card.className  = 'image-card';
    card.dataset.id = imgObj.id;

    card.innerHTML = `
      <!-- Drag handle indicator (purely visual) -->
      <div class="drag-handle" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9"  cy="5"  r="1"/><circle cx="15" cy="5"  r="1"/>
          <circle cx="9"  cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
          <circle cx="9"  cy="19" r="1"/><circle cx="15" cy="19" r="1"/>
        </svg>
      </div>

      <!-- Delete button -->
      <button class="trash-overlay" title="Remove image">
        <svg xmlns="http://www.w3.org/2000/svg" class="trash-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6"/>
          <path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>

      <!-- Disk status badge -->
      <div class="disk-badge ${imgObj.fsHandle ? 'disk-saved' : 'disk-memory'}" title="${imgObj.fsHandle ? 'Saved to uploads/' : 'In memory only'}">
        ${imgObj.fsHandle ? '💾' : '🧠'}
      </div>

      <!-- Clickable image area -->
      <div class="image-wrapper">
        <img src="${imgObj.src}" alt="${imgObj.name}" draggable="false">
        <!-- Eye / preview button -->
        <button class="preview-btn" title="Preview full size">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      </div>

      <!-- Move arrows + page badge row -->
      <div class="move-btns">
        <button class="move-btn move-left-btn"  title="Move left"  ${isFirst ? 'disabled' : ''}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <button class="move-btn move-right-btn" title="Move right" ${isLast ? 'disabled' : ''}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      </div>

      <div class="card-details">
        <span class="page-badge">${index + 1}</span>
        <span class="format-badge format-badge--${getFormatBadge(imgObj.file).toLowerCase()}">${getFormatBadge(imgObj.file)}</span>
        <span class="file-name" title="${imgObj.name}">${imgObj.name}</span>
      </div>
    `;

    // Delete handler
    card.querySelector('.trash-overlay').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isGenerating) return;
      removeImage(imgObj.id, card);
    });

    // Image wrapper click → open lightbox
    card.querySelector('.image-wrapper').addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(index);
    });

    // Move Left
    card.querySelector('.move-left-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isGenerating || index === 0) return;
      moveImage(index, index - 1);
    });

    // Move Right
    card.querySelector('.move-right-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isGenerating || index === count - 1) return;
      moveImage(index, index + 1);
    });

    thumbnailGrid.appendChild(card);
  });

  if (typeof lucide !== 'undefined') lucide.createIcons();
  initSortable();
}

// ─── Move Image ───────────────────────────────────────────────────────────────
function moveImage(fromIndex, toIndex) {
  const item = selectedImages.splice(fromIndex, 1)[0];
  selectedImages.splice(toIndex, 0, item);
  renderGallery();
  setTimeout(() => {
    const cards = thumbnailGrid.querySelectorAll('.image-card');
    animateBadge(cards[toIndex]);
  }, 50);
}

// ─── Animate Page Badge ────────────────────────────────────────────────────────
function animateBadge(card) {
  if (!card) return;
  const badge = card.querySelector('.page-badge');
  if (!badge) return;
  badge.classList.remove('badge-pop');
  void badge.offsetWidth;
  badge.classList.add('badge-pop');
  badge.addEventListener('animationend', () => badge.classList.remove('badge-pop'), { once: true });
}

// ─── Re-initialize SortableJS ─────────────────────────────────────────────────
function initSortable() {
  if (sortableInstance) sortableInstance.destroy();
  if (typeof Sortable === 'undefined') return;

  sortableInstance = new Sortable(thumbnailGrid, {
    animation: 200,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    filter: '.move-btn, .trash-overlay, .preview-btn',
    preventOnFilter: true,
    onEnd: function() {
      const cards = thumbnailGrid.querySelectorAll('.image-card');
      const reorderedList = [];
      cards.forEach(card => {
        const imgObj = selectedImages.find(img => img.id === card.dataset.id);
        if (imgObj) reorderedList.push(imgObj);
      });
      selectedImages = reorderedList;
      updatePageNumbers();
      if (!dragHintDismissed) dismissDragHint();
    }
  });
}

// ─── Update Page Badges ────────────────────────────────────────────────────────
function updatePageNumbers() {
  const cards = thumbnailGrid.querySelectorAll('.image-card');
  cards.forEach((card, index) => {
    const badge = card.querySelector('.page-badge');
    if (badge && badge.textContent !== String(index + 1)) {
      badge.textContent = index + 1;
      animateBadge(card);
    }
    const moveLeft  = card.querySelector('.move-left-btn');
    const moveRight = card.querySelector('.move-right-btn');
    if (moveLeft)  moveLeft.disabled  = (index === 0);
    if (moveRight) moveRight.disabled = (index === selectedImages.length - 1);
  });

  const count = selectedImages.length;
  imageCount.textContent  = `${count} image${count !== 1 ? 's' : ''}`;
  summaryText.textContent = `${count} image${count !== 1 ? 's' : ''} queued`;
}

// ─── Remove Individual Image ──────────────────────────────────────────────────
async function removeImage(id, cardElement) {
  const imgIndex = selectedImages.findIndex(img => img.id === id);
  if (imgIndex === -1) return;

  if (lightboxOverlay.classList.contains('open') && lightboxIndex === imgIndex) {
    closeLightbox();
  }

  const imgObj = selectedImages[imgIndex];

  // Remove from disk (uploads/)
  if (imgObj.uniqueName) {
    await deleteFromUploads(imgObj.uniqueName);
  }

  URL.revokeObjectURL(imgObj.src);
  selectedImages.splice(imgIndex, 1);

  cardElement.style.transition = 'opacity 0.2s, transform 0.2s';
  cardElement.style.opacity    = '0';
  cardElement.style.transform  = 'scale(0.8)';

  setTimeout(() => {
    cardElement.remove();
    if (selectedImages.length === 0) {
      renderGallery();
    } else {
      updatePageNumbers();
    }
  }, 200);
}

// ─── Clear Entire Queue ────────────────────────────────────────────────────────
async function clearQueue() {
  selectedImages.forEach(img => URL.revokeObjectURL(img.src));
  selectedImages = [];

  if (lightboxOverlay.classList.contains('open')) closeLightbox();

  // Purge uploads/ directory
  await cleanupUploads();

  renderGallery();
  showToast('Queue cleared and uploads/ folder cleaned.', 'success');
}

// ─── Drag Hint Banner ─────────────────────────────────────────────────────────
function showDragHint()    { dragHint.classList.add('visible'); }
function hideDragHint()    { dragHint.classList.remove('visible'); }
function dismissDragHint() {
  dragHintDismissed = true;
  dragHint.style.transition = 'opacity 0.3s, max-height 0.4s, padding 0.3s, margin 0.3s';
  dragHint.style.opacity    = '0';
  dragHint.style.maxHeight  = '0';
  dragHint.style.padding    = '0';
  dragHint.style.margin     = '0';
  dragHint.style.overflow   = 'hidden';
  setTimeout(() => dragHint.classList.remove('visible'), 400);
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
function openLightbox(index) {
  if (index < 0 || index >= selectedImages.length) return;
  lightboxIndex = index;

  const imgObj = selectedImages[index];
  lightboxImg.src = imgObj.src;
  lightboxCaption.textContent = `Page ${index + 1} of ${selectedImages.length}  ·  ${imgObj.name}`;

  lightboxPrev.disabled = index === 0;
  lightboxNext.disabled = index === selectedImages.length - 1;

  lightboxOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightboxOverlay.classList.remove('open');
  document.body.style.overflow = '';
  setTimeout(() => {
    lightboxImg.src = '';
    lightboxIndex   = -1;
  }, 300);
}

function navigateLightbox(direction) {
  const next = lightboxIndex + direction;
  if (next >= 0 && next < selectedImages.length) {
    lightboxImg.style.opacity   = '0';
    lightboxImg.style.transform = 'scale(0.92)';
    setTimeout(() => {
      openLightbox(next);
      lightboxImg.style.transition = 'opacity 0.2s, transform 0.2s';
      lightboxImg.style.opacity    = '1';
      lightboxImg.style.transform  = 'scale(1)';
    }, 150);
  }
}

// ─── Format Badge Helper ──────────────────────────────────────────────────────
function getFormatBadge(file) {
  const mimeMap = {
    'image/jpeg'   : 'JPG',
    'image/jpg'    : 'JPG',
    'image/png'    : 'PNG',
    'image/webp'   : 'WEBP',
    'image/svg+xml': 'SVG',
    'image/bmp'    : 'BMP',
    'image/tiff'   : 'TIFF',
  };
  if (mimeMap[file.type]) return mimeMap[file.type];
  const ext    = file.name.split('.').pop().toLowerCase();
  const extMap = { jpg:'JPG', jpeg:'JPG', png:'PNG', webp:'WEBP', svg:'SVG', bmp:'BMP', tif:'TIFF', tiff:'TIFF' };
  return extMap[ext] || ext.toUpperCase();
}

// ─── Universal Image Rasterizer ───────────────────────────────────────────────
/**
 * Rasterizes any supported image to a PNG data URL via an off-screen canvas.
 * TIFF: decoded via UTIF.js. SVG with no intrinsic size: defaults to 2048×2048.
 * Returns: { dataUrl, width, height }
 */
async function rasterizeImage(imgObj) {
  const file   = imgObj.file;
  const isTiff = file.type === 'image/tiff' ||
                 file.name.toLowerCase().endsWith('.tif') ||
                 file.name.toLowerCase().endsWith('.tiff');

  if (isTiff) {
    if (typeof UTIF === 'undefined') {
      throw new Error('UTIF.js not loaded — cannot decode TIFF file.');
    }
    const arrayBuffer = await file.arrayBuffer();
    const ifds = UTIF.decode(arrayBuffer);
    if (!ifds || ifds.length === 0) throw new Error('TIFF decode failed: no IFDs found.');
    UTIF.decodeImage(arrayBuffer, ifds[0]);
    const rgba   = UTIF.toRGBA8(ifds[0]);
    const w      = ifds[0].width;
    const h      = ifds[0].height;
    const canvas = document.createElement('canvas');
    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(w, h);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
  }

  // All other formats: draw via <img> element
  const img = await loadImage(imgObj.src);
  let w = img.naturalWidth  || img.width;
  let h = img.naturalHeight || img.height;

  if (w === 0 || h === 0) { w = 2048; h = 2048; }

  const canvas = document.createElement('canvas');
  canvas.width  = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL('image/png'), width: w, height: h };
}

// ─── Load Image Helper ────────────────────────────────────────────────────────
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img   = new Image();
    img.onload  = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src     = src;
  });
}

// ─── PDF Generation ───────────────────────────────────────────────────────────
async function generatePDF() {
  if (selectedImages.length === 0 || isGenerating) return;

  isGenerating = true;
  setUIBusyState(true);

  convertBtn.innerHTML = `
    <svg class="spinner-icon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
    </svg>
    <span>Generating…</span>
  `;

  try {
    const { jsPDF } = window.jspdf;
    let pdf = null;
    const total = selectedImages.length;

    updateProgress(0, 'Initializing compiler...');

    for (let i = 0; i < total; i++) {
      const item = selectedImages[i];
      const fmt  = getFormatBadge(item.file);
      const stepPercent = Math.round((i / total) * 85);
      updateProgress(stepPercent, `Rasterizing page ${i + 1} of ${total} (${fmt})...`);

      try {
        const { dataUrl, width, height } = await rasterizeImage(item);
        const orientation = width > height ? 'l' : 'p';

        if (pdf === null) {
          pdf = new jsPDF({
            orientation,
            unit: 'px',
            format: [width, height],
            hotfixes: ['px_snapshots'],
          });
        } else {
          pdf.addPage([width, height], orientation);
        }

        pdf.addImage(dataUrl, 'PNG', 0, 0, width, height, undefined, 'FAST');

      } catch (imgLoadError) {
        console.error(`Failed to render image ${item.name}:`, imgLoadError);
        showToast(`Skipped page ${i + 1} (${item.name}) — rendering error.`, 'error');
      }
    }

    if (pdf) {
      updateProgress(90, 'Compiling PDF binary...');
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename  = `shubh-pdf_${timestamp}.pdf`;

      // ── Write to output/ via File System Access API ──────────────────────
      if (outputDirHandle) {
        updateProgress(93, `Saving to output/ → ${filename}...`);

        // Get PDF as a Blob (not base64 string) for efficient binary write
        const pdfBlob = pdf.output('blob');
        const saved   = await writePdfToOutput(pdfBlob, filename);

        if (saved) {
          updateProgress(97, 'Cleaning up uploads/...');
          await cleanupUploads();

          // Clear fsHandle references (files are gone from disk)
          selectedImages.forEach(img => { img.fsHandle = null; });

          updateProgress(100, `Saved to output/${filename}!`);
          showToast(`PDF saved → ${rootDirHandle.name}/output/${filename}`, 'success');

          // Flash the output path badge to indicate new file
          if (outputPathBadge) {
            outputPathBadge.classList.add('badge-flash');
            setTimeout(() => outputPathBadge.classList.remove('badge-flash'), 1500);
          }
        } else {
          // FS write failed — fall back to browser download
          updateProgress(97, 'Disk write failed — downloading instead...');
          pdf.save(filename);
          updateProgress(100, 'Downloaded via browser!');
          showToast('Could not write to output/ — PDF downloaded via browser instead.', 'error');
        }

      } else {
        // ── Fallback: no directory selected — trigger browser download ────
        updateProgress(95, 'Generating download...');
        pdf.save(filename);
        updateProgress(100, 'Download triggered!');
        showToast(
          uploadsDirHandle
            ? `PDF downloaded. (Tip: Select project folder to save directly to output/)`
            : `PDF downloaded. Connect a folder to save directly to disk.`,
          'success'
        );
      }
    } else {
      showToast('Could not compile PDF. No valid images resolved.', 'error');
    }

  } catch (error) {
    console.error('PDF generation error:', error);
    showToast('Failed to compile PDF. Please check your image files.', 'error');
  } finally {
    setTimeout(() => {
      setUIBusyState(false);
      isGenerating = false;
      convertBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"
             fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             class="btn-icon">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9"  y1="15" x2="15" y2="15"/>
        </svg>
        <span>Convert to PDF</span>
      `;
    }, 2000);
  }
}

// ─── UI State Management ──────────────────────────────────────────────────────
function setUIBusyState(busy) {
  if (busy) {
    convertBtn.disabled    = true;
    clearQueueBtn.disabled = true;
    addMoreBtn.disabled    = true;
    progressContainer.classList.remove('hidden');
    summaryText.classList.add('hidden');
    dropZone.style.opacity       = '0.4';
    dropZone.style.pointerEvents = 'none';

    thumbnailGrid.querySelectorAll('.trash-overlay, .move-btn, .preview-btn')
      .forEach(el => el.classList.add('hidden'));

    if (sortableInstance) sortableInstance.option('disabled', true);
  } else {
    convertBtn.disabled    = false;
    clearQueueBtn.disabled = false;
    addMoreBtn.disabled    = false;
    progressContainer.classList.add('hidden');
    summaryText.classList.remove('hidden');
    dropZone.style.opacity       = '1';
    dropZone.style.pointerEvents = 'auto';

    thumbnailGrid.querySelectorAll('.trash-overlay, .move-btn, .preview-btn')
      .forEach(el => el.classList.remove('hidden'));

    if (sortableInstance) sortableInstance.option('disabled', false);
  }
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function updateProgress(percent, statusMessage) {
  progressFill.style.width    = `${percent}%`;
  progressPercent.textContent = `${percent}%`;
  progressStatus.textContent  = statusMessage;
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
let toastTimeout = null;
function showToast(message, type = 'success') {
  if (toastTimeout) clearTimeout(toastTimeout);

  toastMessage.textContent = message;

  if (type === 'error') {
    toastIcon.setAttribute('data-lucide', 'alert-circle');
    toastIcon.className   = 'toast-icon text-danger';
    toastIcon.style.color = 'var(--danger)';
  } else {
    toastIcon.setAttribute('data-lucide', 'check-circle');
    toastIcon.className   = 'toast-icon text-success';
    toastIcon.style.color = 'var(--success)';
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();

  toast.classList.add('show');
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 5000);
}
