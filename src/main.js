const { invoke } = window.__TAURI__.core;
const { open, save } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

let audioFiles = [];
let subDirectories = [];
let selectedFiles = new Set();
let visibleAudioFilePaths = [];
let currentPlayingPath = null;
let currentPlayingDuration = null;
let lastPlayedPath = null; // 最後に再生したファイルのパス（停止後も保持）
let lastPlayedDuration = null; // 最後に再生したファイルの長さ
let currentFolder = null;
let lastCopiedDestination = null;
let searchQuery = "";
let selectedTagFilters = new Set();
let favoritesOnlyFilter = false;
let favoriteFiles = new Map(); // Map<filePath, FavoriteItem>
let isListView = localStorage.getItem("sound-pad-view") !== "grid";
let playbackUpdateInterval = null;
let playbackUpdateInFlight = false;
let allTags = [];
let editingTagsFilePath = null;
let editingTags = [];
let selectedFavorites = new Set(); // お気に入り画面での選択状態
let bulkTags = []; // 一括付与するタグ
let bulkExistingTags = []; // 選択項目のいずれかに存在するタグ
let bulkTagsToRemove = []; // 一括削除するタグ
let focusedFilePath = null;
let masterVolume = Number.parseInt(localStorage.getItem("sound-pad-volume") || "35", 10);
let lastAudibleVolume = masterVolume > 0 ? masterVolume : 35;
let playlistStore = null;
let breadcrumbResizeObserver = null;
let repairState = null;

// LocalStorage キー
const HISTORY_KEY = "sound-pad-history";
const BOOKMARKS_KEY = "sound-pad-bookmarks";
const BOOKMARKS_RECOVERY_KEY = "sound-pad-bookmarks-recovered-v1";
const THEME_KEY = "sound-pad-theme";

// パスからフォルダ名を取得
function getFolderName(path) {
  // Windowsパスとunixパスの両方に対応
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

// フォルダ名を20文字に制限
function truncateFolderName(name, maxLength = 20) {
  if (name.length <= maxLength) {
    return name;
  }
  return name.substring(0, maxLength) + '...';
}

// 秒数をMM:SS形式に変換
function formatDuration(seconds) {
  if (!seconds || seconds < 0) {
    return "--:--";
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 検索クエリをマッチングパターンに変換
function createSearchMatcher(query) {
  if (!query) {
    return () => true;
  }

  // 正規表現パターン: /pattern/ または /pattern/flags
  const regexMatch = query.match(/^\/(.+?)\/([gimuy]*)$/);
  if (regexMatch) {
    try {
      const pattern = regexMatch[1];
      const flags = regexMatch[2] || 'i';
      const regex = new RegExp(pattern, flags);
      return (text) => regex.test(text);
    } catch (e) {
      console.error('Invalid regex:', e);
      // 正規表現が無効な場合は部分一致にフォールバック
      return (text) => text.toLowerCase().includes(query.toLowerCase());
    }
  }

  // ワイルドカードパターン: *.mp3, test*.wav など
  if (query.includes('*') || query.includes('?')) {
    // ワイルドカードを正規表現に変換
    const regexPattern = query
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 特殊文字をエスケープ
      .replace(/\*/g, '.*')  // * を .* に変換
      .replace(/\?/g, '.');  // ? を . に変換
    try {
      const regex = new RegExp(`^${regexPattern}$`, 'i');
      return (text) => regex.test(text);
    } catch (e) {
      console.error('Invalid wildcard pattern:', e);
      return (text) => text.toLowerCase().includes(query.toLowerCase());
    }
  }

  // 通常の部分一致検索（大文字小文字を区別しない）
  const lowerQuery = query.toLowerCase();
  return (text) => text.toLowerCase().includes(lowerQuery);
}

// 履歴を取得
function getHistory() {
  const stored = localStorage.getItem(HISTORY_KEY);
  return stored ? JSON.parse(stored) : [];
}

// 履歴を保存
function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

// 履歴に追加
function addToHistory(path) {
  let history = getHistory();
  // 既存の履歴から削除
  history = history.filter(p => p !== path);
  // 先頭に追加
  history.unshift(path);
  // 最大10件まで
  if (history.length > 10) {
    history = history.slice(0, 10);
  }
  saveHistory(history);
  renderHistory();
}

// ブックマークを取得（オブジェクト形式に正規化）
function getBookmarks() {
  const stored = localStorage.getItem(BOOKMARKS_KEY);
  if (!stored) return [];

  const parsed = JSON.parse(stored);
  // 後方互換性: 文字列の配列の場合はオブジェクト形式に変換
  return parsed.map(item => {
    if (typeof item === 'string') {
      return { path: item, alias: null };
    }
    return item;
  });
}

// ブックマークを保存
function saveBookmarks(bookmarks) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

function normalizeFilePath(path) {
  return String(path || "")
    .trim()
    .replace(/\//g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

function isPathWithinFolder(filePath, folderPath) {
  const normalizedFile = normalizeFilePath(filePath);
  const normalizedFolder = normalizeFilePath(folderPath);
  return Boolean(
    normalizedFile &&
    normalizedFolder &&
    (normalizedFile === normalizedFolder || normalizedFile.startsWith(`${normalizedFolder}\\`))
  );
}

function getCurrentProjectFolder() {
  if (!currentFolder) return null;
  const containingBookmark = getBookmarks()
    .filter(bookmark => isPathWithinFolder(currentFolder, bookmark.path))
    .sort((left, right) => normalizeFilePath(right.path).length - normalizeFilePath(left.path).length)[0];
  return containingBookmark?.path || currentFolder;
}

function recoverBookmarksFromFavorites() {
  if (localStorage.getItem(BOOKMARKS_RECOVERY_KEY)) return;
  const recoveredPaths = new Set();
  favoriteFiles.forEach(item => {
    const parent = getParentFolder(item.file_path);
    const folderName = parent ? getFolderName(parent).toUpperCase() : "";
    if (folderName === "BGM" || folderName === "SE") recoveredPaths.add(parent);
  });

  const bookmarks = getBookmarks();
  recoveredPaths.forEach(path => {
    if (!bookmarks.some(bookmark => bookmark.path.toLowerCase() === path.toLowerCase())) {
      bookmarks.push({ path, alias: null });
    }
  });
  saveBookmarks(bookmarks);
  localStorage.setItem(BOOKMARKS_RECOVERY_KEY, "1");
  renderBookmarks();
}

// ブックマークに追加
function addBookmark(path) {
  let bookmarks = getBookmarks();
  if (!bookmarks.some(b => b.path === path)) {
    bookmarks.push({ path: path, alias: null });
    saveBookmarks(bookmarks);
    renderBookmarks();
  }
}

// ブックマークから削除
function removeBookmark(path) {
  let bookmarks = getBookmarks();
  bookmarks = bookmarks.filter(b => b.path !== path);
  saveBookmarks(bookmarks);
  renderBookmarks();
}

// ブックマークの別名を更新
function updateBookmarkAlias(path, alias) {
  let bookmarks = getBookmarks();
  const bookmark = bookmarks.find(b => b.path === path);
  if (bookmark) {
    bookmark.alias = alias || null;
    saveBookmarks(bookmarks);
    renderBookmarks();
  }
}

// パスからブックマークの表示名を取得
function getBookmarkDisplayName(bookmark) {
  if (bookmark.alias) {
    return bookmark.alias;
  }
  return getFolderName(bookmark.path);
}

// お気に入りファイルを取得
async function getFavoriteFiles() {
  try {
    const favorites = await invoke("get_favorites");
    favoriteFiles = new Map();
    favorites.forEach(item => {
      favoriteFiles.set(item.file_path, item);
    });
    recoverBookmarksFromFavorites();
    // タグ一覧も取得
    allTags = await invoke("get_all_tags");
    // メイン画面のタグフィルターも更新
    updateMainTagFilterOptions();
    renderLibrarySidebar();
  } catch (error) {
    console.error("Error loading favorites:", error);
  }
}

// お気に入りファイルを追加
async function addFavorite(filePath, tags = []) {
  try {
    await invoke("add_favorite", { filePath, tags });
    favoriteFiles.set(filePath, {
      file_path: filePath,
      tags: tags,
      added_at: Date.now().toString()
    });
    renderAudioFiles();
    renderLibrarySidebar();
  } catch (error) {
    console.error("Error adding favorite:", error);
    alert("お気に入りの追加中にエラーが発生しました: " + error);
  }
}

// お気に入りファイルを削除
async function removeFavorite(filePath) {
  try {
    await invoke("remove_favorite", { filePath });
    favoriteFiles.delete(filePath);
    renderAudioFiles();
    renderFavoritesList();
    renderLibrarySidebar();
  } catch (error) {
    console.error("Error removing favorite:", error);
    alert("お気に入りの削除中にエラーが発生しました: " + error);
  }
}

// タグを更新
async function updateFavoriteTags(filePath, tags) {
  try {
    await invoke("update_favorite_tags", { filePath, tags });
    const item = favoriteFiles.get(filePath);
    if (item) {
      item.tags = tags;
    }
    allTags = await invoke("get_all_tags");
    renderFavoritesList();
    updateTagFilterOptions();
    updateMainTagFilterOptions();
    renderAudioFiles();
    updateInspector(filePath);
    renderLibrarySidebar();
  } catch (error) {
    console.error("Error updating tags:", error);
    alert("タグの更新中にエラーが発生しました: " + error);
  }
}

// 履歴を表示
function renderHistory() {
  const history = getHistory();
  const container = document.getElementById("history-list");

  if (history.length === 0) {
    container.innerHTML = '<p class="empty-message">履歴はありません</p>';
    return;
  }

  container.innerHTML = "";
  history.forEach(path => {
    const item = document.createElement("div");
    item.className = "shortcut-item";

    const folderName = getFolderName(path);
    const pathSpan = document.createElement("span");
    pathSpan.className = "shortcut-path";
    pathSpan.textContent = truncateFolderName(folderName);
    pathSpan.title = path;

    item.appendChild(pathSpan);
    item.addEventListener("click", () => {
      openFolder(path);
      closeDrawer();
    });

    container.appendChild(item);
  });
}

// ブックマークを表示
function renderBookmarks() {
  const bookmarks = getBookmarks();
  const container = document.getElementById("bookmarks-list");
  const workspaceSelect = document.getElementById("workspace-select");

  if (workspaceSelect) {
    workspaceSelect.innerHTML = '<option value="">未選択</option>';
    bookmarks.forEach(bookmark => {
      const option = document.createElement("option");
      option.value = bookmark.path;
      option.textContent = getBookmarkDisplayName(bookmark);
      option.title = bookmark.path;
      workspaceSelect.appendChild(option);
    });
    workspaceSelect.value = bookmarks.some(bookmark => bookmark.path === currentFolder) ? currentFolder : "";
  }
  renderLibrarySidebar();

  if (bookmarks.length === 0) {
    container.innerHTML = '<p class="empty-message">ブックマークはありません</p>';
    return;
  }

  container.innerHTML = "";
  bookmarks.forEach(bookmark => {
    const item = document.createElement("div");
    item.className = "shortcut-item";

    const displayName = getBookmarkDisplayName(bookmark);
    const pathSpan = document.createElement("span");
    pathSpan.className = "shortcut-path";
    pathSpan.textContent = truncateFolderName(displayName);
    // 別名がある場合はツールチップにフォルダ名も表示
    if (bookmark.alias) {
      pathSpan.title = `${getFolderName(bookmark.path)}\n${bookmark.path}`;
    } else {
      pathSpan.title = bookmark.path;
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "shortcut-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "削除";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeBookmark(bookmark.path);
    });

    item.appendChild(pathSpan);
    item.appendChild(removeBtn);
    item.addEventListener("click", () => {
      openBookmarkedFolder(bookmark);
      closeDrawer();
    });

    // 右クリックで名前変更メニューを表示
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showBookmarkContextMenu(e.clientX, e.clientY, bookmark);
    });

    container.appendChild(item);
  });
}

// フォルダを開く
async function openFolder(path) {
  currentFolder = path;
  document.getElementById("bookmark-current-btn").disabled = false;
  const sidebarFolder = document.querySelector("#sidebar-current-folder span");
  if (sidebarFolder) {
    sidebarFolder.textContent = getFolderName(path);
    sidebarFolder.title = path;
  }
  const workspaceSelect = document.getElementById("workspace-select");
  if (workspaceSelect) {
    workspaceSelect.value = getBookmarks().some(bookmark => bookmark.path === path) ? path : "";
  }
  focusedFilePath = null;
  updateInspector();

  // パンくずリストを更新
  renderBreadcrumb(path);

  addToHistory(path);
  await loadAudioFiles(path);
}

async function openBookmarkedFolder(bookmark) {
  try {
    const audit = await invoke("audit_library_root", { rootPath: bookmark.path });
    if (audit.root_exists) await openFolder(bookmark.path);
    if (!audit.root_exists || audit.missing_items.length > 0) {
      openRepairModal(audit, bookmark);
    }
  } catch (error) {
    console.error("Error auditing saved folder:", error);
    await openFolder(bookmark.path);
  }
}

function openRepairModal(audit, bookmark) {
  repairState = {
    audit,
    bookmark,
    search: null,
    selectedUnresolved: new Set(audit.missing_items.map(item => item.file_path))
  };
  document.getElementById("repair-modal").classList.add("show");
  renderRepairModal();
}

function closeRepairModal() {
  document.getElementById("repair-modal").classList.remove("show");
  repairState = null;
}

function renderRepairModal() {
  if (!repairState) return;
  const { audit, search, selectedUnresolved } = repairState;
  const replacements = search?.replacements || [];
  const unresolved = search?.unresolved || audit.missing_items.map(item => ({
    old_path: item.file_path,
    candidates: []
  }));
  const summary = document.getElementById("repair-summary");
  summary.className = `repair-summary ${audit.root_exists ? "warning" : "error"}`;
  summary.innerHTML = audit.root_exists
    ? `<i class="mdi mdi-alert-outline"></i><div><strong>${unresolved.length + replacements.length}件の参照切れを検出</strong><span>保存フォルダは存在しますが、お気に入りの一部が見つかりません。</span></div>`
    : `<i class="mdi mdi-folder-alert-outline"></i><div><strong>保存フォルダが見つかりません</strong><span>${audit.root_path}</span></div>`;

  const workspace = document.getElementById("repair-workspace");
  workspace.textContent = search?.workspace_path || "未選択";
  workspace.title = search?.workspace_path || "";

  const results = document.getElementById("repair-results");
  results.innerHTML = "";
  replacements.forEach(replacement => {
    const row = document.createElement("div");
    row.className = "repair-result resolved";
    row.innerHTML = '<i class="mdi mdi-check-circle-outline"></i><div><strong></strong><span class="repair-arrow">→</span><span class="repair-new-path"></span></div>';
    row.querySelector("strong").textContent = replacement.old_path;
    row.querySelector(".repair-new-path").textContent = replacement.new_path;
    results.appendChild(row);
  });
  unresolved.forEach(item => {
    const label = document.createElement("label");
    label.className = "repair-result unresolved";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedUnresolved.has(item.old_path);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedUnresolved.add(item.old_path);
      else selectedUnresolved.delete(item.old_path);
      document.getElementById("repair-delete-btn").disabled = selectedUnresolved.size === 0;
    });
    const info = document.createElement("div");
    const name = item.old_path.split(/[\\/]/).pop();
    const candidateText = item.candidates?.length
      ? `同名候補が${item.candidates.length}件あるため自動判定できません`
      : "検索先で見つかりません";
    info.innerHTML = '<strong></strong><span></span><small></small>';
    info.querySelector("strong").textContent = name;
    info.querySelector("span").textContent = item.old_path;
    info.querySelector("small").textContent = search ? candidateText : "検索ワークスペースを選択してください";
    label.append(checkbox, info);
    results.appendChild(label);
  });
  if (replacements.length === 0 && unresolved.length === 0) {
    results.innerHTML = '<div class="repair-complete"><i class="mdi mdi-check-circle"></i>参照切れは解消されました</div>';
  }
  const canReplaceEmptyRoot = !audit.root_exists && audit.missing_items.length === 0 && search?.suggested_root;
  document.getElementById("repair-apply-btn").disabled = replacements.length === 0 && !canReplaceEmptyRoot;
  document.getElementById("repair-delete-btn").disabled = selectedUnresolved.size === 0;
}

async function searchRepairWorkspace() {
  if (!repairState) return;
  const workspace = await open({ directory: true, multiple: false });
  if (!workspace) return;
  const missingPaths = repairState.audit.missing_items.map(item => item.file_path);
  if (missingPaths.length === 0) {
    repairState.search = {
      workspace_path: workspace,
      replacements: [],
      unresolved: [],
      suggested_root: workspace
    };
    repairState.selectedUnresolved.clear();
    renderRepairModal();
    return;
  }
  try {
    repairState.search = await invoke("search_missing_favorites", {
      workspacePath: workspace,
      missingPaths
    });
    repairState.selectedUnresolved = new Set(repairState.search.unresolved.map(item => item.old_path));
    renderRepairModal();
  } catch (error) {
    alert("再帰検索に失敗しました: " + error);
  }
}

async function refreshReferencesAfterRepair(result) {
  favoriteFiles = new Map(result.favorites.map(item => [item.file_path, item]));
  playlistStore = result.playlists;
  allTags = await invoke("get_all_tags");
  updateMainTagFilterOptions();
  updateTagFilterOptions();
  renderAudioFiles();
  renderLibrarySidebar();
  renderPlaylistPanel();
}

function replaceBookmarkRoot(oldPath, newPath) {
  const bookmarks = getBookmarks();
  const bookmark = bookmarks.find(item => item.path.toLowerCase() === oldPath.toLowerCase());
  if (!bookmark) return;
  const existing = bookmarks.find(item => item.path.toLowerCase() === newPath.toLowerCase());
  if (existing && existing !== bookmark) {
    if (!existing.alias && bookmark.alias) existing.alias = bookmark.alias;
    saveBookmarks(bookmarks.filter(item => item !== bookmark));
  } else {
    bookmark.path = newPath;
    saveBookmarks(bookmarks);
  }
  renderBookmarks();
}

async function applyRepairReplacements() {
  if (!repairState?.search) return;
  if (repairState.search.replacements.length === 0 && !repairState.audit.root_exists && repairState.audit.missing_items.length === 0) {
    const newRoot = repairState.search.suggested_root;
    if (!newRoot) return;
    replaceBookmarkRoot(repairState.audit.root_path, newRoot);
    repairState.audit.root_path = newRoot;
    repairState.audit.root_exists = true;
    await openFolder(newRoot);
    renderRepairModal();
    return;
  }
  if (repairState.search.replacements.length === 0) return;
  try {
    const oldRoot = repairState.audit.root_path;
    const rootWasMissing = !repairState.audit.root_exists;
    const result = await invoke("apply_path_replacements", {
      replacements: repairState.search.replacements
    });
    await refreshReferencesAfterRepair(result);
    const unresolvedPaths = new Set(repairState.search.unresolved.map(item => item.old_path));
    repairState.audit.missing_items = repairState.audit.missing_items
      .filter(item => unresolvedPaths.has(item.file_path));
    if (rootWasMissing && repairState.search.suggested_root) {
      const newRoot = repairState.search.suggested_root;
      replaceBookmarkRoot(oldRoot, newRoot);
      repairState.audit.root_path = newRoot;
      repairState.audit.root_exists = true;
      await openFolder(newRoot);
    }
    repairState.search = repairState.audit.missing_items.length > 0
      ? { ...repairState.search, replacements: [], unresolved: repairState.search.unresolved }
      : { ...repairState.search, replacements: [], unresolved: [] };
    repairState.selectedUnresolved = new Set(repairState.search.unresolved.map(item => item.old_path));
    renderRepairModal();
  } catch (error) {
    alert("パスの一括置換に失敗しました: " + error);
  }
}

async function deleteSelectedMissingReferences() {
  if (!repairState?.selectedUnresolved.size) return;
  const filePaths = Array.from(repairState.selectedUnresolved);
  if (!confirm(`${filePaths.length}件をお気に入りとセットリストから削除しますか？`)) return;
  try {
    const result = await invoke("remove_missing_references", { filePaths });
    await refreshReferencesAfterRepair(result);
    const removed = new Set(filePaths);
    repairState.audit.missing_items = repairState.audit.missing_items
      .filter(item => !removed.has(item.file_path));
    if (repairState.search) {
      repairState.search.replacements = repairState.search.replacements
        .filter(item => !removed.has(item.old_path));
      repairState.search.unresolved = repairState.search.unresolved
        .filter(item => !removed.has(item.old_path));
    }
    repairState.selectedUnresolved.clear();
    renderRepairModal();
  } catch (error) {
    alert("参照の削除に失敗しました: " + error);
  }
}

// パンくずリストを描画
function renderBreadcrumb(path) {
  const container = document.getElementById("breadcrumb-container");
  container.innerHTML = "";

  // パスをセグメントに分割
  const normalizedPath = path.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(s => s);

  // Windowsのドライブレター対応（例: "C:"）
  let currentPath = "";

  const ellipsis = document.createElement("button");
  ellipsis.type = "button";
  ellipsis.className = "breadcrumb-ellipsis";
  ellipsis.textContent = "…";
  ellipsis.title = "パスを入力";
  ellipsis.hidden = true;
  ellipsis.addEventListener("click", (event) => {
    event.stopPropagation();
    showAddressInput();
  });
  container.appendChild(ellipsis);

  segments.forEach((segment, index) => {
    // 区切り文字を追加（最初以外）
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "breadcrumb-separator";
      separator.dataset.segmentIndex = String(index);
      separator.innerHTML = '<i class="mdi mdi-chevron-right"></i>';
      container.appendChild(separator);
    }

    // パスを構築
    if (index === 0 && segment.includes(':')) {
      // Windowsドライブレター
      currentPath = segment;
    } else {
      currentPath += '/' + segment;
    }

    const segmentPath = currentPath.replace(/\//g, '\\'); // Windowsパスに戻す

    const segmentEl = document.createElement("span");
    segmentEl.className = "breadcrumb-segment";
    segmentEl.dataset.segmentIndex = String(index);
    segmentEl.textContent = segment;
    segmentEl.dataset.path = segmentPath;
    segmentEl.title = segmentPath;

    // クリックでそのディレクトリに移動
    segmentEl.addEventListener("click", (e) => {
      e.stopPropagation();
      openFolder(segmentPath);
    });

    // 右クリックでコンテキストメニュー
    segmentEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showBreadcrumbContextMenu(e.clientX, e.clientY, segmentPath);
    });

    container.appendChild(segmentEl);
  });

  if (!breadcrumbResizeObserver) {
    breadcrumbResizeObserver = new ResizeObserver(() => collapseBreadcrumb());
    breadcrumbResizeObserver.observe(container);
  }
  requestAnimationFrame(collapseBreadcrumb);
}

function collapseBreadcrumb() {
  const container = document.getElementById("breadcrumb-container");
  if (!container || container.offsetWidth === 0) return;
  const segments = Array.from(container.querySelectorAll(".breadcrumb-segment"));
  const separators = Array.from(container.querySelectorAll(".breadcrumb-separator"));
  const ellipsis = container.querySelector(".breadcrumb-ellipsis");
  if (!ellipsis || segments.length === 0) return;

  segments.forEach(segment => {
    segment.hidden = false;
    segment.classList.remove("current-only");
  });
  separators.forEach(separator => { separator.hidden = false; });
  ellipsis.hidden = true;

  let firstVisibleIndex = 0;
  const lastIndex = segments.length - 1;
  while (container.scrollWidth > container.clientWidth && firstVisibleIndex < lastIndex) {
    segments[firstVisibleIndex].hidden = true;
    firstVisibleIndex += 1;
    separators.forEach(separator => {
      separator.hidden = Number(separator.dataset.segmentIndex) < firstVisibleIndex;
    });
    ellipsis.hidden = false;
  }

  if (container.scrollWidth > container.clientWidth) {
    ellipsis.hidden = true;
    separators.forEach(separator => { separator.hidden = true; });
    segments[lastIndex].classList.add("current-only");
  }
}

// アドレスバーの入力モードを切り替え
function showAddressInput() {
  const container = document.getElementById("breadcrumb-container");
  const input = document.getElementById("address-input");

  container.style.display = "none";
  input.style.display = "block";
  input.value = currentFolder || "";
  input.focus();
  input.select();
}

// アドレスバーの入力モードを終了
function hideAddressInput() {
  const container = document.getElementById("breadcrumb-container");
  const input = document.getElementById("address-input");

  container.style.display = "flex";
  input.style.display = "none";
  requestAnimationFrame(collapseBreadcrumb);
}

// パンくずリスト用コンテキストメニューを表示
function showBreadcrumbContextMenu(x, y, path) {
  const normalizedPath = path.replace(/\//g, "\\").toLowerCase();
  const bookmark = getBookmarks().find(item => item.path.replace(/\//g, "\\").toLowerCase() === normalizedPath);
  if (bookmark) {
    showBookmarkContextMenu(x, y, bookmark);
    return;
  }
  const menu = document.getElementById("breadcrumb-context-menu");
  menu.dataset.path = path;
  positionContextMenu(menu, x, y);
}

// パンくずリスト用コンテキストメニューを非表示
function hideBreadcrumbContextMenu() {
  const menu = document.getElementById("breadcrumb-context-menu");
  menu.classList.remove("show");
}

// フォルダ選択
async function selectFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
    });

    if (selected) {
      await openFolder(selected);
    }
  } catch (error) {
    console.error("Error selecting folder:", error);
    alert("フォルダの選択中にエラーが発生しました: " + error);
  }
}

// 現在のフォルダをブックマーク
function bookmarkCurrent() {
  if (currentFolder) {
    addBookmark(currentFolder);
  }
}

// 音声ファイル一覧を読み込み
async function loadAudioFiles(directory) {
  try {
    const contents = await invoke("get_audio_files", { directory });
    audioFiles = contents.files;
    subDirectories = contents.directories;
    renderAudioFiles();
    renderLibrarySidebar();
  } catch (error) {
    console.error("Error loading audio files:", error);
    alert("ファイルの読み込み中にエラーが発生しました: " + error);
  }
}

// 音声ファイル一覧を表示
function renderAudioFiles() {
  const grid = document.getElementById("audio-grid");
  document.querySelector(".container")?.classList.toggle("grid-mode", !isListView);
  const columnHeader = document.querySelector(".list-column-header");
  if (columnHeader) columnHeader.hidden = !isListView;

  // ビュー切り替え
  if (isListView) {
    grid.classList.add("list-view");
  } else {
    grid.classList.remove("list-view");
  }

  // 検索クエリでフィルタリング（正規表現/ワイルドカード対応）
  const matcher = createSearchMatcher(searchQuery);

  // サブディレクトリをフィルタリング（タグフィルターがある場合はフォルダを非表示）
  let filteredDirs = [];
  if (!favoritesOnlyFilter && selectedTagFilters.size === 0) {
    filteredDirs = subDirectories.filter(dir => matcher(dir.name));
  }

  let filteredFiles = audioFiles.filter(file => matcher(file.name));

  // タグフィルタリング
  if (favoritesOnlyFilter || selectedTagFilters.size > 0) {
    filteredFiles = filteredFiles.filter(file => favoriteFiles.has(file.path));
  }
  if (selectedTagFilters.size > 0) {
    filteredFiles = filteredFiles.filter(file => {
      const favoriteItem = favoriteFiles.get(file.path);
      return favoriteItem && Array.from(selectedTagFilters)
        .every(tag => favoriteItem.tags?.includes(tag));
    });
  }
  visibleAudioFilePaths = filteredFiles.map(file => file.path);

  if (filteredDirs.length === 0 && filteredFiles.length === 0) {
    if (audioFiles.length === 0 && subDirectories.length === 0) {
      grid.innerHTML = '<p class="placeholder">このフォルダには音声ファイルがありません</p>';
    } else {
      grid.innerHTML = '<p class="placeholder">検索条件に一致するファイルがありません</p>';
    }
    return;
  }

  grid.innerHTML = "";

  // フォルダを最上段に表示
  filteredDirs.forEach(dir => {
    const item = document.createElement("div");
    item.className = "audio-item folder-item";
    item.dataset.path = dir.path;

    const header = document.createElement("div");
    header.className = "audio-item-header";

    const folderIcon = document.createElement("span");
    folderIcon.className = "folder-icon";
    folderIcon.innerHTML = '<i class="mdi mdi-folder"></i>';

    const nameSpan = document.createElement("span");
    nameSpan.className = "audio-item-name folder-name";
    nameSpan.textContent = dir.name;
    nameSpan.title = dir.path;

    header.appendChild(folderIcon);
    header.appendChild(nameSpan);

    const openBtn = document.createElement("button");
    openBtn.className = "play-btn folder-open-btn";
    openBtn.innerHTML = '<i class="mdi mdi-folder-open"></i> 開く';
    openBtn.addEventListener("click", () => openFolder(dir.path));

    item.appendChild(header);
    item.appendChild(openBtn);

    // ダブルクリックでフォルダを開く
    item.addEventListener("dblclick", () => openFolder(dir.path));
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showBreadcrumbContextMenu(event.clientX, event.clientY, dir.path);
    });

    grid.appendChild(item);
  });

  filteredFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "audio-item";
    item.dataset.index = index;
    item.dataset.path = file.path;
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      focusAudioFile(file.path);
      showContextMenu(event.clientX, event.clientY, file.path);
    });

    const header = document.createElement("div");
    header.className = "audio-item-header";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.path = file.path;
    checkbox.checked = selectedFiles.has(file.path);
    checkbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        selectedFiles.add(file.path);
        item.classList.add("selected");
      } else {
        selectedFiles.delete(file.path);
        item.classList.remove("selected");
      }
      updateSelectedCount();
    });

    const favoriteBtn = document.createElement("button");
    favoriteBtn.className = "favorite-btn";
    const isFavorite = favoriteFiles.has(file.path);
    favoriteBtn.innerHTML = isFavorite
      ? '<i class="mdi mdi-star"></i>'
      : '<i class="mdi mdi-star-outline"></i>';
    favoriteBtn.title = isFavorite ? "お気に入りから削除" : "お気に入りに追加";
    favoriteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      focusAudioFile(file.path);
      if (favoriteFiles.has(file.path)) {
        removeFavorite(file.path);
      } else {
        addFavorite(file.path);
      }
    });

    const nameSpan = document.createElement("span");
    nameSpan.className = "audio-item-name";
    nameSpan.textContent = file.name;
    nameSpan.title = file.path;

    const copyNameBtn = document.createElement("button");
    copyNameBtn.className = "copy-name-btn";
    copyNameBtn.innerHTML = '<i class="mdi mdi-content-copy"></i>';
    copyNameBtn.title = "ファイル名をコピー";
    copyNameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      focusAudioFile(file.path);
      try {
        await navigator.clipboard.writeText(file.name);
        // コピー成功のフィードバック
        copyNameBtn.innerHTML = '<i class="mdi mdi-check"></i>';
        setTimeout(() => {
          copyNameBtn.innerHTML = '<i class="mdi mdi-content-copy"></i>';
        }, 1000);
      } catch (error) {
        console.error("Failed to copy:", error);
      }
    });

    header.appendChild(checkbox);
    header.appendChild(favoriteBtn);
    header.appendChild(nameSpan);

    // タグを表示（お気に入りの場合のみ）
    const favoriteItem = favoriteFiles.get(file.path);
    const tagsDiv = document.createElement("div");
    tagsDiv.className = "audio-item-tags";
    if (favoriteItem && favoriteItem.tags && favoriteItem.tags.length > 0) {
      favoriteItem.tags.forEach(tag => {
        tagsDiv.appendChild(createTagBadge(tag));
      });
    }


    // 音声の長さを表示
    const durationDiv = document.createElement("div");
    durationDiv.className = "audio-duration";
    durationDiv.textContent = formatDuration(file.duration_seconds);

    const playBtn = document.createElement("button");
    playBtn.className = "play-btn";
    playBtn.innerHTML = '<i class="mdi mdi-play"></i> 再生';
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      focusAudioFile(file.path);
      togglePlayAudio(file.path, file.duration_seconds, item, playBtn);
    });

    const rowActions = document.createElement("div");
    rowActions.className = "row-actions";
    rowActions.appendChild(playBtn);
    rowActions.appendChild(copyNameBtn);

    item.appendChild(header);
    item.appendChild(tagsDiv);
    item.appendChild(durationDiv);
    item.appendChild(rowActions);
    grid.appendChild(item);

    item.addEventListener("click", (e) => {
      if (!e.target.closest("button, input")) {
        focusAudioFile(file.path);
      }
    });

    if (selectedFiles.has(file.path)) {
      item.classList.add("selected");
    }

    if (focusedFilePath === file.path) {
      item.classList.add("focused");
    }

    // 現在再生中のファイルをハイライト
    if (currentPlayingPath === file.path) {
      item.classList.add("playing");
      playBtn.innerHTML = '<i class="mdi mdi-stop"></i> 停止';
      playBtn.classList.add("stopping");
    }
  });

  updateSelectedCount();
}

// 音声の再生/停止を切り替え
async function togglePlayAudio(path, duration, itemElement, buttonElement) {
  // ボタンが既に無効化されている場合は何もしない（連打防止）
  if (buttonElement && buttonElement.disabled) {
    return;
  }

  try {
    // ボタンを一時的に無効化（連打防止）
    if (buttonElement) {
      buttonElement.disabled = true;
    }

    // 既に再生中の同じファイルをクリックした場合は停止
    if (currentPlayingPath === path) {
      await invoke("stop_audio");
      resetPlayingUI();
      stopPlaybackUpdate();
      return;
    }

    // 前回再生中の要素をリセット
    if (currentPlayingPath) {
      const allItems = document.querySelectorAll('.audio-item[data-path]');
      let prevItem = null;
      for (const el of allItems) {
        if (el.dataset.path === currentPlayingPath) {
          prevItem = el;
          break;
        }
      }
      if (prevItem) {
        prevItem.classList.remove("playing");
        const prevButton = prevItem.querySelector(".play-btn");
        if (prevButton) {
          prevButton.innerHTML = '<i class="mdi mdi-play"></i> 再生';
          prevButton.classList.remove("stopping");
          prevButton.disabled = false;
        }
      }
    }

    // 音声を再生
    await invoke("play_audio", { path });

    // 新しい再生中の要素を設定
    currentPlayingPath = path;
    currentPlayingDuration = duration;
    lastPlayedPath = path;
    lastPlayedDuration = duration;
    if (itemElement) {
      itemElement.classList.add("playing");
    }
    if (buttonElement) {
      buttonElement.innerHTML = '<i class="mdi mdi-stop"></i> 停止';
      buttonElement.classList.add("stopping");
    }

    // プレイヤーパネルを更新
    updatePlayerPanel(path, duration);
    startPlaybackUpdate();
  } catch (error) {
    console.error("Error playing audio:", error);
    alert("音声の再生中にエラーが発生しました: " + error);
  } finally {
    // ボタンを再度有効化
    if (buttonElement) {
      buttonElement.disabled = false;
    }
  }
}

// プレイヤーパネルを更新
function updatePlayerPanel(path, duration) {
  const filename = path.split(/[\\/]/).pop();
  document.getElementById("player-filename").textContent = filename;
  document.getElementById("player-filename").title = path;
  document.getElementById("player-duration").textContent = formatDuration(duration);
  document.getElementById("player-current-time").textContent = "0:00";

  const seekbar = document.getElementById("player-seekbar");
  seekbar.max = duration || 100;
  seekbar.value = 0;

  document.getElementById("player-play-pause-btn").disabled = false;
  document.getElementById("player-stop-btn").disabled = false;

  const playPauseBtn = document.getElementById("player-play-pause-btn");
  playPauseBtn.innerHTML = '<i class="mdi mdi-pause"></i>';
  document.getElementById("player-panel").classList.add("has-track");
}

const TAG_HUES = [6, 28, 45, 88, 145, 178, 205, 222, 258, 292, 326, 348];

function getTagHue(tag) {
  let hash = 0;
  for (const char of tag) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return TAG_HUES[Math.abs(hash) % TAG_HUES.length];
}

function createTagBadge(tag, className = "tag-badge") {
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = tag;
  badge.style.setProperty("--tag-hue", getTagHue(tag));
  return badge;
}

// 再生状態を定期的に更新
function startPlaybackUpdate() {
  stopPlaybackUpdate();
  playbackUpdateInterval = setInterval(async () => {
    if (playbackUpdateInFlight) return;
    playbackUpdateInFlight = true;
    try {
      const status = await invoke("get_playback_status");
      if (status.is_playing || status.is_paused) {
        document.getElementById("player-current-time").textContent = formatDuration(status.position);
        const seekbar = document.getElementById("player-seekbar");
        if (status.duration) {
          seekbar.max = status.duration;
        }
        if (!seekbar.dataset.dragging) {
          seekbar.value = status.position;
        }

        const playPauseBtn = document.getElementById("player-play-pause-btn");
        if (status.is_paused) {
          playPauseBtn.innerHTML = '<i class="mdi mdi-play"></i>';
        } else {
          playPauseBtn.innerHTML = '<i class="mdi mdi-pause"></i>';
        }
      }
    } catch (error) {
      console.error("Error getting playback status:", error);
    } finally {
      playbackUpdateInFlight = false;
    }
  }, 200);
}

// 再生状態の更新を停止
function stopPlaybackUpdate() {
  if (playbackUpdateInterval) {
    clearInterval(playbackUpdateInterval);
    playbackUpdateInterval = null;
  }
  playbackUpdateInFlight = false;
}

// 再生UIをリセット
function resetPlayingUI() {
  if (currentPlayingPath) {
    const allItems = document.querySelectorAll('.audio-item[data-path]');
    for (const el of allItems) {
      if (el.dataset.path === currentPlayingPath) {
        el.classList.remove("playing");
        const button = el.querySelector(".play-btn");
        if (button) {
          button.innerHTML = '<i class="mdi mdi-play"></i> 再生';
          button.classList.remove("stopping");
        }
        break;
      }
    }
  }
  currentPlayingPath = null;
  currentPlayingDuration = null;
  document.getElementById("player-panel").classList.remove("has-track");

  // lastPlayedPathがある場合は、ファイル名を表示したまま再生ボタンを有効に保つ
  if (lastPlayedPath) {
    const filename = lastPlayedPath.split(/[\\/]/).pop();
    document.getElementById("player-filename").textContent = filename;
    document.getElementById("player-filename").title = lastPlayedPath;
    document.getElementById("player-current-time").textContent = "0:00";
    document.getElementById("player-duration").textContent = formatDuration(lastPlayedDuration);
    document.getElementById("player-seekbar").value = 0;
    document.getElementById("player-seekbar").max = lastPlayedDuration || 100;
    document.getElementById("player-play-pause-btn").disabled = false;
    document.getElementById("player-stop-btn").disabled = true;
    document.getElementById("player-play-pause-btn").innerHTML = '<i class="mdi mdi-play"></i>';
  } else {
    document.getElementById("player-filename").textContent = "再生中のファイルはありません";
    document.getElementById("player-current-time").textContent = "0:00";
    document.getElementById("player-duration").textContent = "0:00";
    document.getElementById("player-seekbar").value = 0;
    document.getElementById("player-play-pause-btn").disabled = true;
    document.getElementById("player-stop-btn").disabled = true;
    document.getElementById("player-play-pause-btn").innerHTML = '<i class="mdi mdi-play"></i>';
  }
}

// ファイル名を変更
async function renameFile(oldPath, newName, index) {
  try {
    const newPath = await invoke("rename_file", { oldPath, newName });

    // 更新されたファイル情報を保存
    audioFiles[index].name = newName;
    audioFiles[index].path = newPath;

    // 選択状態を更新
    if (selectedFiles.has(oldPath)) {
      selectedFiles.delete(oldPath);
      selectedFiles.add(newPath);
    }

    // 再生中のファイルを更新
    if (currentPlayingPath === oldPath) {
      currentPlayingPath = newPath;
    }

    renderAudioFiles();
  } catch (error) {
    console.error("Error renaming file:", error);
    alert("ファイル名の変更中にエラーが発生しました: " + error);
  }
}

// 選択数を更新
function updateSelectedCount() {
  const count = selectedFiles.size;
  document.getElementById("selected-count").textContent = `選択: ${count}個`;

  const copyBtn = document.getElementById("copy-selected-btn");
  copyBtn.disabled = count === 0;
  updateMainSelectAllCheckbox();
}

function updateMainSelectAllCheckbox() {
  const checkbox = document.getElementById("main-select-all-checkbox");
  if (!checkbox) return;
  const selectedVisibleCount = visibleAudioFilePaths
    .filter(path => selectedFiles.has(path)).length;
  checkbox.disabled = visibleAudioFilePaths.length === 0;
  checkbox.checked = visibleAudioFilePaths.length > 0 && selectedVisibleCount === visibleAudioFilePaths.length;
  checkbox.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleAudioFilePaths.length;
  checkbox.title = checkbox.checked
    ? "表示中の音声をすべて解除"
    : "表示中の音声をすべて選択";
}

function toggleSelectAllVisible(checked) {
  visibleAudioFilePaths.forEach(path => {
    if (checked) selectedFiles.add(path);
    else selectedFiles.delete(path);
  });
  renderAudioFiles();
}

// 選択したファイルをコピー
async function copySelected() {
  if (selectedFiles.size === 0) return;

  try {
    const destination = await open({
      directory: true,
      multiple: false,
    });

    if (destination) {
      const filesToCopy = Array.from(selectedFiles);
      await invoke("copy_files", { files: filesToCopy, destination });

      lastCopiedDestination = destination;
      showCopyModal(filesToCopy.length);
    }
  } catch (error) {
    console.error("Error copying files:", error);
    alert("ファイルのコピー中にエラーが発生しました: " + error);
  }
}

// コピー完了モーダルを表示
function showCopyModal(count) {
  const modal = document.getElementById("copy-modal");
  const message = document.getElementById("copy-message");

  message.textContent = `${count}個のファイルを正常にコピーしました。`;
  modal.classList.add("show");
}

// モーダルを閉じる
function closeModal() {
  const modal = document.getElementById("copy-modal");
  modal.classList.remove("show");
}

// コピー先を開く
async function openCopiedFolder() {
  if (lastCopiedDestination) {
    closeModal();
    await openFolder(lastCopiedDestination);
  }
}

// ドロワーを開く
function openDrawer() {
  const drawer = document.getElementById("drawer");
  drawer.classList.add("show");
}

// ドロワーを閉じる
function closeDrawer() {
  const drawer = document.getElementById("drawer");
  drawer.classList.remove("show");
}

// お気に入り画面を開く
async function openFavoritesModal() {
  await getFavoriteFiles();
  selectedFavorites.clear(); // 選択状態をリセット
  updateTagFilterOptions();
  updateFolderFilterOptions();
  renderFavoritesList();
  const modal = document.getElementById("favorites-modal");
  modal.classList.add("show");
}

// お気に入り画面を閉じる
function closeFavoritesModal() {
  const modal = document.getElementById("favorites-modal");
  modal.classList.remove("show");
}

// タグフィルターのオプションを更新（お気に入り画面用）
function updateTagFilterOptions() {
  const select = document.getElementById("favorites-tag-filter");
  const currentValue = select.value;
  select.innerHTML = '<option value="">すべてのタグ</option>';
  allTags.forEach(tag => {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = tag;
    select.appendChild(option);
  });
  select.value = currentValue;
}

// メイン画面のタグフィルターのオプションを更新
function updateMainTagFilterOptions() {
  const options = document.getElementById("tag-filter-options");
  if (!options) return;
  selectedTagFilters = new Set(Array.from(selectedTagFilters).filter(tag => allTags.includes(tag)));
  options.innerHTML = "";
  allTags.forEach(tag => {
    const label = document.createElement("label");
    label.className = "multi-tag-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tag;
    checkbox.checked = selectedTagFilters.has(tag);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedTagFilters.add(tag);
      else selectedTagFilters.delete(tag);
      updateMainTagFilterLabel();
      renderAudioFiles();
      renderLibrarySidebar();
    });
    const dot = document.createElement("span");
    dot.className = "sidebar-tag-dot";
    dot.style.setProperty("--tag-hue", getTagHue(tag));
    const text = document.createElement("span");
    text.textContent = tag;
    label.append(checkbox, dot, text);
    options.appendChild(label);
  });
  const favoritesCheckbox = document.getElementById("tag-filter-favorites");
  if (favoritesCheckbox) favoritesCheckbox.checked = favoritesOnlyFilter;
  updateMainTagFilterLabel();
}

function updateMainTagFilterLabel() {
  const label = document.getElementById("tag-filter-label");
  if (!label) return;
  const conditions = selectedTagFilters.size + (favoritesOnlyFilter ? 1 : 0);
  if (conditions === 0) label.textContent = "すべてのタグ";
  else if (selectedTagFilters.size === 1 && !favoritesOnlyFilter) label.textContent = Array.from(selectedTagFilters)[0];
  else label.textContent = `${conditions}条件（すべて一致）`;
}

// フォルダフィルターのオプションを更新
function updateFolderFilterOptions() {
  const select = document.getElementById("favorites-folder-filter");
  const currentValue = select.value;
  select.innerHTML = '<option value="">すべてのフォルダ</option>';

  const bookmarks = getBookmarks();
  // お気に入りファイルの親フォルダを取得
  const favoriteFolders = new Set();
  favoriteFiles.forEach(item => {
    const folder = getParentFolder(item.file_path);
    if (folder) {
      favoriteFolders.add(folder);
    }
  });

  // ブックマークされているフォルダのみを表示
  bookmarks.forEach(bookmark => {
    const bookmarkPath = bookmark.path;
    // ブックマークフォルダに該当するお気に入りファイルがあるかチェック
    let hasFiles = false;
    for (const folder of favoriteFolders) {
      if (folder === bookmarkPath || folder.startsWith(bookmarkPath + "\\") || folder.startsWith(bookmarkPath + "/")) {
        hasFiles = true;
        break;
      }
    }
    if (hasFiles) {
      const option = document.createElement("option");
      option.value = bookmarkPath;
      // 別名があれば別名を表示、なければフォルダ名を表示
      option.textContent = getBookmarkDisplayName(bookmark);
      option.title = bookmarkPath;
      select.appendChild(option);
    }
  });

  select.value = currentValue;
}

// ファイルパスから親フォルダを取得
function getParentFolder(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const lastSlash = normalizedPath.lastIndexOf('/');
  if (lastSlash > 0) {
    return filePath.substring(0, lastSlash);
  }
  return null;
}

function updateInspector(filePath = focusedFilePath) {
  const empty = document.getElementById("inspector-empty");
  const content = document.getElementById("inspector-content");
  if (!empty || !content) return;

  if (!filePath) {
    empty.hidden = false;
    content.hidden = true;
    document.getElementById("playlist-add-focused-btn").disabled = true;
    updateSelectedCount();
    return;
  }

  focusedFilePath = filePath;
  const fileName = filePath.split(/[\\/]/).pop();
  const favoriteItem = favoriteFiles.get(filePath);
  document.getElementById("inspector-filename").textContent = fileName;
  document.getElementById("inspector-path").textContent = filePath;
  const knownFile = audioFiles.find(file => file.path === filePath);
  const parentFolder = getParentFolder(filePath);
  document.getElementById("inspector-folder").textContent = parentFolder ? getFolderName(parentFolder) : "—";
  document.getElementById("inspector-duration").textContent = knownFile ? formatDuration(knownFile.duration_seconds) : "—";

  const tags = document.getElementById("inspector-tags");
  tags.innerHTML = "";
  if (favoriteItem?.tags?.length) {
    favoriteItem.tags.forEach(tag => {
      tags.appendChild(createTagBadge(tag));
    });
  } else {
    const noTags = document.createElement("span");
    noTags.className = "no-tags";
    noTags.textContent = "タグなし";
    tags.appendChild(noTags);
  }

  document.getElementById("inspector-edit-tags-btn").disabled = false;
  document.getElementById("inspector-copy-name-btn").disabled = false;
  document.getElementById("playlist-add-focused-btn").disabled = false;
  empty.hidden = true;
  content.hidden = false;
}

function getActivePlaylist() {
  return playlistStore?.playlists?.find(playlist => playlist.id === playlistStore.active_playlist_id) || null;
}

async function loadPlaylists() {
  try {
    playlistStore = await invoke("get_playlists");
    renderPlaylistPanel();
  } catch (error) {
    console.error("Error loading playlists:", error);
  }
}

function renderPlaylistPanel() {
  const select = document.getElementById("playlist-select");
  const itemsContainer = document.getElementById("playlist-items");
  if (!select || !itemsContainer || !playlistStore) return;

  select.innerHTML = "";
  playlistStore.playlists.forEach(playlist => {
    const option = document.createElement("option");
    option.value = playlist.id;
    option.textContent = playlist.name;
    select.appendChild(option);
  });
  select.value = playlistStore.active_playlist_id;

  const playlist = getActivePlaylist();
  const items = playlist?.items || [];
  const totalDuration = items.reduce((total, item) => total + (item.duration_seconds || 0), 0);
  document.getElementById("playlist-count").textContent = `${items.length}曲`;
  document.getElementById("playlist-duration").textContent = `合計 ${formatDuration(totalDuration).replace("--:--", "0:00")}`;
  document.getElementById("playlist-delete-btn").disabled = playlistStore.playlists.length <= 1;
  document.getElementById("playlist-add-focused-btn").disabled = !focusedFilePath;

  itemsContainer.innerHTML = "";
  if (items.length === 0) {
    itemsContainer.innerHTML = '<div class="playlist-empty"><i class="mdi mdi-playlist-music-outline"></i><span>BGMを選択して追加してください</span></div>';
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "playlist-item";
    row.title = item.file_path;

    const order = document.createElement("span");
    order.className = "playlist-order";
    order.textContent = String(index + 1).padStart(2, "0");

    const info = document.createElement("button");
    info.className = "playlist-item-info";
    const fileName = item.file_path.split(/[\\/]/).pop();
    info.innerHTML = `<strong></strong><span>${formatDuration(item.duration_seconds)}</span>`;
    info.querySelector("strong").textContent = fileName;
    info.addEventListener("click", () => {
      focusAudioFile(item.file_path);
      togglePlayAudio(item.file_path, item.duration_seconds, null, null);
    });

    const actions = document.createElement("div");
    actions.className = "playlist-item-actions";
    const actionButton = (icon, title, handler, disabled = false) => {
      const button = document.createElement("button");
      button.innerHTML = `<i class="mdi ${icon}"></i>`;
      button.title = title;
      button.disabled = disabled;
      button.addEventListener("click", handler);
      return button;
    };
    actions.append(
      actionButton("mdi-play", "再生 / 停止", () => togglePlayAudio(item.file_path, item.duration_seconds, null, null)),
      actionButton("mdi-content-copy", "ファイル名をコピー", () => navigator.clipboard.writeText(fileName)),
      actionButton("mdi-chevron-up", "上へ", () => movePlaylistItem(item.file_path, -1), index === 0),
      actionButton("mdi-chevron-down", "下へ", () => movePlaylistItem(item.file_path, 1), index === items.length - 1),
      actionButton("mdi-close", "プレイリストから外す", () => removePlaylistItem(item.file_path))
    );
    row.append(order, info, actions);
    itemsContainer.appendChild(row);
  });
}

async function addFocusedToPlaylist() {
  const playlist = getActivePlaylist();
  if (!playlist || !focusedFilePath) return;
  const knownFile = audioFiles.find(file => file.path === focusedFilePath);
  try {
    playlistStore = await invoke("add_playlist_item", {
      playlistId: playlist.id,
      filePath: focusedFilePath,
      durationSeconds: knownFile?.duration_seconds ?? null
    });
    renderPlaylistPanel();
  } catch (error) {
    alert(String(error));
  }
}

async function removePlaylistItem(filePath) {
  const playlist = getActivePlaylist();
  if (!playlist) return;
  playlistStore = await invoke("remove_playlist_item", { playlistId: playlist.id, filePath });
  renderPlaylistPanel();
}

async function movePlaylistItem(filePath, direction) {
  const playlist = getActivePlaylist();
  if (!playlist) return;
  playlistStore = await invoke("move_playlist_item", { playlistId: playlist.id, filePath, direction });
  renderPlaylistPanel();
}

function showInspectorTab(tab) {
  const playlistActive = tab === "playlist";
  document.getElementById("playlist-panel").hidden = !playlistActive;
  document.getElementById("details-panel").hidden = playlistActive;
  document.getElementById("playlist-tab-btn").classList.toggle("active", playlistActive);
  document.getElementById("details-tab-btn").classList.toggle("active", !playlistActive);
}

function safeExportName(name) {
  return name.replace(/[<>:"/\\|?*]+/g, "_").trim() || "sound-pad-export";
}

async function writeJsonExport(defaultName, payload) {
  const target = await save({
    defaultPath: `${defaultName}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }]
  });
  if (!target) return false;
  await invoke("write_json_export", {
    path: target,
    contents: JSON.stringify(payload, null, 2)
  });
  return true;
}

async function exportFilteredFavorites() {
  const tags = Array.from(selectedTagFilters).sort((left, right) => left.localeCompare(right, "ja"));
  const projectFolder = getCurrentProjectFolder();
  if (!projectFolder) {
    alert("JSONを書き出す案件フォルダを開いてください。");
    return;
  }

  const selectedProjectPaths = new Set(
    Array.from(selectedFiles)
      .filter(filePath => isPathWithinFolder(filePath, projectFolder))
      .map(normalizeFilePath)
  );
  const useCheckedItems = selectedProjectPaths.size > 0;
  const effectiveTags = useCheckedItems ? [] : tags;
  const items = Array.from(favoriteFiles.values())
    .filter(item => isPathWithinFolder(item.file_path, projectFolder))
    .filter(item => !useCheckedItems || selectedProjectPaths.has(normalizeFilePath(item.file_path)))
    .filter(item => effectiveTags.every(tag => item.tags?.includes(tag)))
    .sort((left, right) => left.file_path.localeCompare(right.file_path, "ja"))
    .map(item => ({
      file_path: item.file_path,
      file_name: item.file_path.split(/[\\/]/).pop(),
      tags: item.tags || [],
      added_at: item.added_at
    }));
  const projectName = getFolderName(projectFolder);
  const suffix = useCheckedItems ? "selected" : effectiveTags.length ? effectiveTags.join("_") : "all";
  try {
    await writeJsonExport(safeExportName(`sound-pad-favorites-${projectName}-${suffix}`), {
      format: "sound-pad-favorites",
      schema_version: 1,
      exported_at: new Date().toISOString(),
      filters: {
        tags: effectiveTags,
        match: "all",
        project_folder: projectFolder,
        selection: useCheckedItems ? "checked" : "project"
      },
      item_count: items.length,
      items
    });
  } catch (error) {
    alert("お気に入りJSONの書き出しに失敗しました: " + error);
  }
}

async function exportActivePlaylist() {
  const playlist = getActivePlaylist();
  if (!playlist) return;
  try {
    await writeJsonExport(safeExportName(`sound-pad-setlist-${playlist.name}`), {
      format: "sound-pad-setlist",
      schema_version: 1,
      exported_at: new Date().toISOString(),
      setlist: {
        id: playlist.id,
        name: playlist.name,
        item_count: playlist.items.length,
        items: playlist.items.map((item, index) => ({
          order: index + 1,
          file_path: item.file_path,
          file_name: item.file_path.split(/[\\/]/).pop(),
          duration_seconds: item.duration_seconds,
          added_at: item.added_at
        }))
      }
    });
  } catch (error) {
    alert("セットリストJSONの書き出しに失敗しました: " + error);
  }
}

function focusAudioFile(filePath) {
  focusedFilePath = filePath;
  document.querySelectorAll(".audio-item.focused").forEach(el => el.classList.remove("focused"));
  const item = Array.from(document.querySelectorAll('.audio-item[data-path]'))
    .find(el => el.dataset.path === filePath);
  item?.classList.add("focused");
  updateInspector(filePath);
}

function renderLibrarySidebar() {
  const favoritesCount = document.getElementById("sidebar-favorites-count");
  const historyCount = document.getElementById("sidebar-history-count");
  if (favoritesCount) favoritesCount.textContent = favoriteFiles.size;
  if (historyCount) historyCount.textContent = getHistory().length;

  const currentFolderElement = document.getElementById("sidebar-current-folder");
  if (currentFolderElement) {
    currentFolderElement.querySelector(".sidebar-count")?.remove();
    if (currentFolder) {
      const currentBookmark = getBookmarks().find(bookmark => bookmark.path.toLowerCase() === currentFolder.toLowerCase());
      const currentLabel = currentFolderElement.querySelector("span:not(.sidebar-count)");
      if (currentLabel) {
        currentLabel.textContent = currentBookmark ? getBookmarkDisplayName(currentBookmark) : getFolderName(currentFolder);
        currentLabel.title = currentFolder;
      }
      const count = document.createElement("span");
      count.className = "sidebar-count";
      count.textContent = audioFiles.length;
      currentFolderElement.appendChild(count);
    }
  }

  const folderList = document.getElementById("sidebar-folder-list");
  if (folderList) {
    folderList.innerHTML = "";
    const bookmarks = getBookmarks().slice(0, 8);
    const normalizePath = path => path?.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() || "";
    const currentNormalized = normalizePath(currentFolder);
    const activeBookmark = bookmarks
      .filter(bookmark => {
        const bookmarkPath = normalizePath(bookmark.path);
        return currentNormalized === bookmarkPath || currentNormalized.startsWith(bookmarkPath + "\\");
      })
      .sort((a, b) => b.path.length - a.path.length)[0];

    const appendDirectoryButton = (directory, depth) => {
      const button = document.createElement("button");
      button.className = "sidebar-tree-item nested-folder";
      button.classList.toggle("active", normalizePath(directory.path) === currentNormalized);
      button.style.setProperty("--tree-depth", String(Math.min(depth, 4)));
      button.title = directory.path;
      button.innerHTML = '<i class="mdi mdi-folder-outline"></i>';
      const label = document.createElement("span");
      label.textContent = directory.name;
      button.appendChild(label);
      button.addEventListener("click", () => openFolder(directory.path));
      button.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        showBreadcrumbContextMenu(event.clientX, event.clientY, directory.path);
      });
      folderList.appendChild(button);
    };

    bookmarks.forEach(bookmark => {
      const button = document.createElement("button");
      button.className = "sidebar-tree-item saved-folder";
      button.classList.toggle("active", bookmark.path === currentFolder);
      button.classList.toggle("branch-active", bookmark.path === activeBookmark?.path);
      button.title = bookmark.path;
      button.innerHTML = '<i class="mdi mdi-folder-star-outline"></i>';
      const label = document.createElement("span");
      label.textContent = getBookmarkDisplayName(bookmark);
      button.appendChild(label);
      button.addEventListener("click", () => openBookmarkedFolder(bookmark));
      button.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        showBookmarkContextMenu(event.clientX, event.clientY, bookmark);
      });
      folderList.appendChild(button);

      if (bookmark.path !== activeBookmark?.path) return;
      const bookmarkNormalized = normalizePath(bookmark.path);
      const relativePath = currentNormalized.slice(bookmarkNormalized.length).replace(/^\\+/, "");
      const relativeSegments = relativePath ? relativePath.split("\\").filter(Boolean) : [];
      let accumulatedPath = bookmark.path.replace(/[\\/]+$/, "");
      relativeSegments.forEach((segment, index) => {
        accumulatedPath += `\\${segment}`;
        appendDirectoryButton({ name: segment, path: accumulatedPath }, index + 1);
      });
      subDirectories.slice(0, 12).forEach(directory => {
        appendDirectoryButton(directory, relativeSegments.length + 1);
      });
    });

    if (!activeBookmark) {
      subDirectories.slice(0, 12).forEach(directory => appendDirectoryButton(directory, 1));
    }
  }

  const tagCounts = new Map();
  favoriteFiles.forEach(item => {
    item.tags?.forEach(tag => tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1));
  });
  const tagList = document.getElementById("sidebar-tag-list");
  if (!tagList) return;
  tagList.innerHTML = "";
  if (allTags.length === 0) {
    tagList.innerHTML = '<span class="sidebar-empty">タグはありません</span>';
    return;
  }

  allTags.slice(0, 14).forEach(tag => {
    const button = document.createElement("button");
    button.className = "sidebar-tag-item";
    button.classList.toggle("active", selectedTagFilters.has(tag));
    const dot = document.createElement("span");
    dot.className = "sidebar-tag-dot";
    dot.style.setProperty("--tag-hue", getTagHue(tag));
    const label = document.createElement("span");
    label.className = "sidebar-tag-name";
    label.textContent = tag;
    const count = document.createElement("span");
    count.className = "sidebar-count";
    count.textContent = tagCounts.get(tag) || 0;
    button.append(dot, label, count);
    button.addEventListener("click", () => {
      if (selectedTagFilters.has(tag)) selectedTagFilters.delete(tag);
      else selectedTagFilters.add(tag);
      updateMainTagFilterOptions();
      renderAudioFiles();
      renderLibrarySidebar();
    });
    tagList.appendChild(button);
  });
}

function filterFavoriteItems(items, { searchQuery, tagFilter, folderFilter }) {
  return items.filter(item => {
    const fileName = item.file_path.split(/[\\/]/).pop().toLowerCase();
    const matchesSearch = !searchQuery || fileName.includes(searchQuery);
    const matchesTag = !tagFilter || (item.tags || []).includes(tagFilter);

    // フォルダフィルタ：ブックマークフォルダまたはそのサブフォルダに含まれるか
    let matchesFolder = true;
    if (folderFilter) {
      const parentFolder = getParentFolder(item.file_path);
      matchesFolder = parentFolder === folderFilter ||
        parentFolder.startsWith(folderFilter + "\\") ||
        parentFolder.startsWith(folderFilter + "/");
    }

    return matchesSearch && matchesTag && matchesFolder;
  });
}

function getFilteredFavorites() {
  return filterFavoriteItems(Array.from(favoriteFiles.values()), {
    searchQuery: document.getElementById("favorites-search-input").value.toLowerCase(),
    tagFilter: document.getElementById("favorites-tag-filter").value,
    folderFilter: document.getElementById("favorites-folder-filter").value
  });
}

function updateVisibleFavoritesSelection(checked) {
  getFilteredFavorites().forEach(item => {
    if (checked) selectedFavorites.add(item.file_path);
    else selectedFavorites.delete(item.file_path);
  });
}

// お気に入りリストを表示
function renderFavoritesList() {
  const container = document.getElementById("favorites-list-container");
  const filteredFavorites = getFilteredFavorites();

  if (filteredFavorites.length === 0) {
    container.innerHTML = '<p class="empty-message">お気に入りはありません</p>';
    updateFavoritesSelectionUI();
    return;
  }

  container.innerHTML = "";
  filteredFavorites.forEach(item => {
    const itemDiv = document.createElement("div");
    itemDiv.className = "favorites-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "favorites-item-checkbox";
    checkbox.checked = selectedFavorites.has(item.file_path);
    checkbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        selectedFavorites.add(item.file_path);
      } else {
        selectedFavorites.delete(item.file_path);
      }
      updateFavoritesSelectionUI();
    });

    const fileName = item.file_path.split(/[\\/]/).pop();

    const infoDiv = document.createElement("div");
    infoDiv.className = "favorites-item-info";

    const nameSpan = document.createElement("span");
    nameSpan.className = "favorites-item-name";
    nameSpan.textContent = fileName;
    nameSpan.title = item.file_path;

    const tagsDiv = document.createElement("div");
    tagsDiv.className = "favorites-item-tags";
    if (item.tags && item.tags.length > 0) {
      item.tags.forEach(tag => {
        tagsDiv.appendChild(createTagBadge(tag));
      });
    }

    infoDiv.appendChild(nameSpan);
    infoDiv.appendChild(tagsDiv);

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "favorites-item-actions";

    const playBtn = document.createElement("button");
    playBtn.className = "favorites-action-btn play";
    playBtn.innerHTML = '<i class="mdi mdi-play"></i>';
    playBtn.title = "再生";
    playBtn.addEventListener("click", async () => {
      try {
        await invoke("play_audio", { path: item.file_path });
        const knownFile = audioFiles.find(file => file.path === item.file_path);
        const duration = knownFile?.duration_seconds ?? null;
        currentPlayingPath = item.file_path;
        currentPlayingDuration = duration;
        lastPlayedPath = item.file_path;
        lastPlayedDuration = duration;
        focusAudioFile(item.file_path);
        updatePlayerPanel(item.file_path, duration);
        startPlaybackUpdate();
      } catch (error) {
        console.error("Error playing favorite:", error);
        alert("ファイルが見つかりません: " + item.file_path);
      }
    });

    const tagBtn = document.createElement("button");
    tagBtn.className = "favorites-action-btn tag";
    tagBtn.innerHTML = '<i class="mdi mdi-tag-multiple"></i>';
    tagBtn.title = "タグを編集";
    tagBtn.addEventListener("click", () => {
      openTagEditModal(item.file_path, item.tags || []);
    });

    const removeBtn = document.createElement("button");
    removeBtn.className = "favorites-action-btn remove";
    removeBtn.innerHTML = '<i class="mdi mdi-delete"></i>';
    removeBtn.title = "削除";
    removeBtn.addEventListener("click", () => {
      removeFavorite(item.file_path);
    });

    actionsDiv.appendChild(playBtn);
    actionsDiv.appendChild(tagBtn);
    actionsDiv.appendChild(removeBtn);

    itemDiv.appendChild(checkbox);
    itemDiv.appendChild(infoDiv);
    itemDiv.appendChild(actionsDiv);
    container.appendChild(itemDiv);
  });

  updateFavoritesSelectionUI();
}

// お気に入り選択状態のUIを更新
function updateFavoritesSelectionUI() {
  const count = selectedFavorites.size;
  document.getElementById("favorites-selected-count").textContent = `選択: ${count}個`;
  document.getElementById("favorites-bulk-tag-btn").disabled = count === 0;

  // 「すべて選択」は、現在のフィルターで表示されている項目だけを基準にする
  const allCheckbox = document.getElementById("favorites-select-all-checkbox");
  const visibleFavorites = getFilteredFavorites();
  const selectedVisibleCount = visibleFavorites
    .filter(item => selectedFavorites.has(item.file_path))
    .length;
  allCheckbox.disabled = visibleFavorites.length === 0;
  if (selectedVisibleCount === 0) {
    allCheckbox.checked = false;
    allCheckbox.indeterminate = false;
  } else if (selectedVisibleCount === visibleFavorites.length) {
    allCheckbox.checked = true;
    allCheckbox.indeterminate = false;
  } else {
    allCheckbox.checked = false;
    allCheckbox.indeterminate = true;
  }
}

// 一括タグ編集モーダルを開く
function openBulkTagModal() {
  bulkTags = [];
  bulkExistingTags = getSelectedFavoriteTags();
  bulkTagsToRemove = [];
  document.getElementById("bulk-tag-target-count").textContent =
    `${selectedFavorites.size}個のファイルのタグを編集します`;
  document.getElementById("bulk-tag-input").value = "";

  renderBulkTags();
  renderBulkTagSuggestions();
  renderBulkTagRemovals();

  const modal = document.getElementById("bulk-tag-modal");
  modal.classList.add("show");
}

// 一括タグ編集モーダルを閉じる
function closeBulkTagModal() {
  const modal = document.getElementById("bulk-tag-modal");
  modal.classList.remove("show");
  bulkTags = [];
  bulkExistingTags = [];
  bulkTagsToRemove = [];
}

function getSelectedFavoriteTags() {
  const selectedItems = Array.from(selectedFavorites)
    .map(filePath => favoriteFiles.get(filePath))
    .filter(Boolean);
  if (selectedItems.length === 0) return [];

  const presentOnAny = [];
  const seen = new Set();
  selectedItems.forEach(item => {
    (item.tags || []).forEach(tag => {
      if (!seen.has(tag)) {
        seen.add(tag);
        presentOnAny.push(tag);
      }
    });
  });
  return presentOnAny;
}

function applyBulkTagChanges(currentTags, tagsToAdd, tagsToRemove) {
  const removeSet = new Set(tagsToRemove);
  return [...new Set([
    ...(currentTags || []).filter(tag => !removeSet.has(tag)),
    ...tagsToAdd
  ])];
}

// 一括付与するタグを表示
function renderBulkTags() {
  const container = document.getElementById("bulk-tag-list");
  container.innerHTML = "";

  if (bulkTags.length === 0) {
    container.innerHTML = '<span class="no-tags">タグなし</span>';
    return;
  }

  bulkTags.forEach(tag => {
    const tagSpan = document.createElement("span");
    tagSpan.className = "tag-chip";
    tagSpan.style.setProperty("--tag-hue", getTagHue(tag));
    tagSpan.innerHTML = `${tag} <button class="tag-remove-btn"><i class="mdi mdi-close"></i></button>`;
    tagSpan.querySelector(".tag-remove-btn").addEventListener("click", () => {
      bulkTags = bulkTags.filter(t => t !== tag);
      renderBulkTags();
      renderBulkTagSuggestions();
    });
    container.appendChild(tagSpan);
  });
}

// 一括タグ候補を表示
function renderBulkTagSuggestions() {
  const container = document.getElementById("bulk-tag-suggestions-list");
  container.innerHTML = "";

  const availableTags = allTags.filter(tag =>
    !bulkTags.includes(tag) && !bulkExistingTags.includes(tag)
  );

  if (availableTags.length === 0) {
    container.innerHTML = '<span class="no-tags">候補なし</span>';
    return;
  }

  availableTags.forEach(tag => {
    const tagSpan = document.createElement("span");
    tagSpan.className = "tag-suggestion";
    tagSpan.style.setProperty("--tag-hue", getTagHue(tag));
    tagSpan.textContent = tag;
    tagSpan.addEventListener("click", () => {
      if (!bulkTags.includes(tag)) {
        bulkTagsToRemove = bulkTagsToRemove.filter(item => item !== tag);
        bulkTags.push(tag);
        renderBulkTags();
        renderBulkTagSuggestions();
        renderBulkTagRemovals();
      }
    });
    container.appendChild(tagSpan);
  });
}

// 一括タグを入力から追加
function addBulkTagFromInput() {
  const input = document.getElementById("bulk-tag-input");
  const tag = input.value.trim();
  if (tag && bulkExistingTags.includes(tag)) {
    bulkTagsToRemove = bulkTagsToRemove.filter(item => item !== tag);
    input.value = "";
    renderBulkTagRemovals();
  } else if (tag && !bulkTags.includes(tag)) {
    bulkTagsToRemove = bulkTagsToRemove.filter(item => item !== tag);
    bulkTags.push(tag);
    input.value = "";
    renderBulkTags();
    renderBulkTagSuggestions();
    renderBulkTagRemovals();
  }
}

function renderBulkTagRemovals() {
  const container = document.getElementById("bulk-tag-remove-list");
  container.innerHTML = "";
  if (bulkExistingTags.length === 0) {
    container.innerHTML = '<span class="no-tags">選択項目にタグはありません</span>';
    return;
  }

  const remainingTags = bulkExistingTags.filter(tag => !bulkTagsToRemove.includes(tag));
  if (remainingTags.length === 0) {
    container.innerHTML = '<span class="no-tags">表示中のタグはすべて削除されます</span>';
    return;
  }

  remainingTags.forEach(tag => {
    const tagSpan = document.createElement("span");
    tagSpan.className = "tag-chip bulk-existing-tag-chip";
    tagSpan.style.setProperty("--tag-hue", getTagHue(tag));
    tagSpan.innerHTML = `<span></span><button type="button" class="tag-remove-btn" title="このタグを一括削除"><i class="mdi mdi-close"></i></button>`;
    tagSpan.querySelector("span").textContent = tag;
    tagSpan.querySelector(".tag-remove-btn").addEventListener("click", () => {
      bulkTagsToRemove.push(tag);
      renderBulkTagRemovals();
    });
    container.appendChild(tagSpan);
  });
}

// 一括タグ付与を実行
async function saveBulkTags() {
  if (bulkTags.length === 0 && bulkTagsToRemove.length === 0) {
    alert("付与または削除するタグを選択してください");
    return;
  }

  const selectedPaths = Array.from(selectedFavorites);
  for (const filePath of selectedPaths) {
    const item = favoriteFiles.get(filePath);
    if (item) {
      const newTags = applyBulkTagChanges(item.tags, bulkTags, bulkTagsToRemove);
      await updateFavoriteTags(filePath, newTags);
    }
  }

  closeBulkTagModal();
  selectedFavorites.clear();
  renderFavoritesList();
}

// タグ編集モーダルを開く
function openTagEditModal(filePath, currentTags) {
  editingTagsFilePath = filePath;
  editingTags = [...currentTags];

  const fileName = filePath.split(/[\\/]/).pop();
  document.getElementById("tag-edit-filename").textContent = fileName;
  document.getElementById("tag-input").value = "";

  renderCurrentTags();
  renderTagSuggestions();

  const modal = document.getElementById("tag-edit-modal");
  modal.classList.add("show");
}

// タグ編集モーダルを閉じる
function closeTagEditModal() {
  const modal = document.getElementById("tag-edit-modal");
  modal.classList.remove("show");
  editingTagsFilePath = null;
  editingTags = [];
}

// 現在のタグを表示
function renderCurrentTags() {
  const container = document.getElementById("current-tags-list");
  container.innerHTML = "";

  if (editingTags.length === 0) {
    container.innerHTML = '<span class="no-tags">タグなし</span>';
    return;
  }

  editingTags.forEach(tag => {
    const tagSpan = document.createElement("span");
    tagSpan.className = "tag-chip";
    tagSpan.style.setProperty("--tag-hue", getTagHue(tag));
    tagSpan.innerHTML = `${tag} <button class="tag-remove-btn"><i class="mdi mdi-close"></i></button>`;
    tagSpan.querySelector(".tag-remove-btn").addEventListener("click", () => {
      editingTags = editingTags.filter(t => t !== tag);
      renderCurrentTags();
    });
    container.appendChild(tagSpan);
  });
}

// タグ候補を表示
function renderTagSuggestions() {
  const container = document.getElementById("tag-suggestions-list");
  container.innerHTML = "";

  const availableTags = allTags.filter(tag => !editingTags.includes(tag));

  if (availableTags.length === 0) {
    container.innerHTML = '<span class="no-tags">候補なし</span>';
    return;
  }

  availableTags.forEach(tag => {
    const tagSpan = document.createElement("span");
    tagSpan.className = "tag-suggestion";
    tagSpan.style.setProperty("--tag-hue", getTagHue(tag));
    tagSpan.textContent = tag;
    tagSpan.addEventListener("click", () => {
      if (!editingTags.includes(tag)) {
        editingTags.push(tag);
        renderCurrentTags();
        renderTagSuggestions();
      }
    });
    container.appendChild(tagSpan);
  });
}

// タグを追加
function addTagFromInput() {
  const input = document.getElementById("tag-input");
  const tag = input.value.trim();
  if (tag && !editingTags.includes(tag)) {
    editingTags.push(tag);
    input.value = "";
    renderCurrentTags();
    renderTagSuggestions();
  }
}

// タグを保存
async function saveTagEdits() {
  if (editingTagsFilePath) {
    await updateFavoriteTags(editingTagsFilePath, editingTags);
  }
  closeTagEditModal();
}

// コンテキストメニューを表示
function showContextMenu(x, y, path) {
  const menu = document.getElementById("context-menu");
  menu.dataset.path = path;
  const favoriteButton = document.getElementById("context-toggle-favorite");
  const isFavorite = favoriteFiles.has(path);
  favoriteButton.innerHTML = isFavorite
    ? '<i class="mdi mdi-star-off-outline"></i>お気に入りから削除'
    : '<i class="mdi mdi-star-outline"></i>お気に入りに追加';
  positionContextMenu(menu, x, y);
}

// コンテキストメニューを非表示
function hideContextMenu() {
  const menu = document.getElementById("context-menu");
  menu.classList.remove("show");
}

// ブックマーク用コンテキストメニューを表示
function showBookmarkContextMenu(x, y, bookmark) {
  const menu = document.getElementById("bookmark-context-menu");
  menu.dataset.path = bookmark.path;
  menu.dataset.alias = bookmark.alias || "";
  positionContextMenu(menu, x, y);
}

// ブックマーク用コンテキストメニューを非表示
function hideBookmarkContextMenu() {
  const menu = document.getElementById("bookmark-context-menu");
  menu.classList.remove("show");
}

// ブックマーク名前変更モーダルを表示
function openBookmarkRenameModal(path, currentAlias) {
  const modal = document.getElementById("bookmark-rename-modal");
  const input = document.getElementById("bookmark-rename-input");
  const folderNameLabel = document.getElementById("bookmark-rename-folder-name");

  modal.dataset.path = path;
  folderNameLabel.textContent = getFolderName(path);
  input.value = currentAlias || "";
  input.placeholder = getFolderName(path);

  modal.classList.add("show");
  input.focus();
  input.select();
}

// ブックマーク名前変更モーダルを閉じる
function closeBookmarkRenameModal() {
  const modal = document.getElementById("bookmark-rename-modal");
  modal.classList.remove("show");
}

// ブックマーク名前変更を保存
function saveBookmarkRename() {
  const modal = document.getElementById("bookmark-rename-modal");
  const input = document.getElementById("bookmark-rename-input");
  const path = modal.dataset.path;
  const newAlias = input.value.trim();

  updateBookmarkAlias(path, newAlias);
  closeBookmarkRenameModal();
}

// エクスプローラで開く
async function openInExplorer(path) {
  try {
    await invoke("open_in_explorer", { path });
  } catch (error) {
    console.error("Error opening in explorer:", error);
    alert("エクスプローラを開けませんでした: " + error);
  }
}

function hideAllContextMenus() {
  document.querySelectorAll(".context-menu.show").forEach(menu => menu.classList.remove("show"));
}

function positionContextMenu(menu, x, y) {
  hideAllContextMenus();
  menu.classList.add("show");
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
}

function applyTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = resolved;
  localStorage.setItem(THEME_KEY, resolved);
  const button = document.getElementById("theme-toggle-btn");
  if (button) {
    button.innerHTML = resolved === "dark"
      ? '<i class="mdi mdi-weather-sunny"></i>'
      : '<i class="mdi mdi-weather-night"></i>';
    button.title = resolved === "dark" ? "Lightテーマに切り替え" : "Darkテーマに切り替え";
  }
}

function updateVolumeUI(volume) {
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  const slider = document.getElementById("player-volume");
  const value = document.getElementById("player-volume-value");
  const muteButton = document.getElementById("player-mute-btn");
  if (slider) slider.value = clamped;
  if (value) value.textContent = `${clamped}%`;
  if (muteButton) {
    const icon = clamped === 0 ? "mdi-volume-off" : clamped < 50 ? "mdi-volume-medium" : "mdi-volume-high";
    muteButton.innerHTML = `<i class="mdi ${icon}"></i>`;
    muteButton.classList.toggle("muted", clamped === 0);
  }
}

async function setMasterVolume(volume) {
  masterVolume = Math.max(0, Math.min(100, Math.round(volume)));
  if (masterVolume > 0) lastAudibleVolume = masterVolume;
  localStorage.setItem("sound-pad-volume", String(masterVolume));
  updateVolumeUI(masterVolume);
  try {
    await invoke("set_master_volume", { volume: masterVolume / 100 });
  } catch (error) {
    console.error("Error setting master volume:", error);
  }
}

// イベントリスナーの設定
window.addEventListener("DOMContentLoaded", () => {
  const savedTheme = localStorage.getItem(THEME_KEY) || "light";
  applyTheme(savedTheme);
  setMasterVolume(Number.isFinite(masterVolume) ? masterVolume : 35);

  document.getElementById("select-folder-btn").addEventListener("click", selectFolder);
  document.getElementById("bookmark-current-btn").addEventListener("click", bookmarkCurrent);
  document.getElementById("copy-selected-btn").addEventListener("click", copySelected);
  document.getElementById("main-select-all-checkbox").addEventListener("change", event => {
    toggleSelectAllVisible(event.target.checked);
  });
  document.getElementById("modal-ok-btn").addEventListener("click", closeModal);
  document.getElementById("modal-open-folder-btn").addEventListener("click", openCopiedFolder);

  document.getElementById("theme-toggle-btn").addEventListener("click", () => {
    applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
  });

  document.getElementById("workspace-select").addEventListener("change", (event) => {
    if (!event.target.value) return;
    const bookmark = getBookmarks().find(item => item.path === event.target.value);
    if (bookmark) openBookmarkedFolder(bookmark);
  });

  document.getElementById("playlist-tab-btn").addEventListener("click", () => showInspectorTab("playlist"));
  document.getElementById("details-tab-btn").addEventListener("click", () => showInspectorTab("details"));
  document.getElementById("playlist-add-focused-btn").addEventListener("click", addFocusedToPlaylist);
  document.getElementById("playlist-export-btn").addEventListener("click", exportActivePlaylist);
  document.getElementById("playlist-select").addEventListener("change", async event => {
    try {
      playlistStore = await invoke("set_active_playlist", { playlistId: event.target.value });
      renderPlaylistPanel();
    } catch (error) {
      alert(String(error));
    }
  });
  document.getElementById("playlist-new-btn").addEventListener("click", async () => {
    const name = prompt("新しいプレイリスト名", "今回のセットリスト");
    if (!name?.trim()) return;
    try {
      playlistStore = await invoke("create_playlist", { name: name.trim() });
      renderPlaylistPanel();
    } catch (error) {
      alert(String(error));
    }
  });
  document.getElementById("playlist-rename-btn").addEventListener("click", async () => {
    const playlist = getActivePlaylist();
    if (!playlist) return;
    const name = prompt("セットリスト名を変更", playlist.name);
    if (!name?.trim() || name.trim() === playlist.name) return;
    try {
      playlistStore = await invoke("rename_playlist", {
        playlistId: playlist.id,
        name: name.trim()
      });
      renderPlaylistPanel();
    } catch (error) {
      alert(String(error));
    }
  });
  document.getElementById("playlist-delete-btn").addEventListener("click", async () => {
    const playlist = getActivePlaylist();
    if (!playlist || !confirm(`「${playlist.name}」を削除しますか？`)) return;
    try {
      playlistStore = await invoke("delete_playlist", { playlistId: playlist.id });
      renderPlaylistPanel();
    } catch (error) {
      alert(String(error));
    }
  });

  document.getElementById("player-volume").addEventListener("input", (e) => {
    setMasterVolume(Number.parseInt(e.target.value, 10));
  });

  document.getElementById("player-mute-btn").addEventListener("click", () => {
    setMasterVolume(masterVolume === 0 ? lastAudibleVolume : 0);
  });

  document.getElementById("inspector-copy-name-btn").addEventListener("click", async () => {
    if (!focusedFilePath) return;
    const fileName = focusedFilePath.split(/[\\/]/).pop();
    await navigator.clipboard.writeText(fileName);
  });

  document.getElementById("inspector-edit-tags-btn").addEventListener("click", async () => {
    if (!focusedFilePath) return;
    if (!favoriteFiles.has(focusedFilePath)) {
      await addFavorite(focusedFilePath);
    }
    const item = favoriteFiles.get(focusedFilePath);
    openTagEditModal(focusedFilePath, item?.tags || []);
  });

  // コンテキストメニュー
  const contextMenu = document.getElementById("context-menu");

  document.getElementById("context-play").addEventListener("click", () => {
    const path = contextMenu.dataset.path;
    const file = audioFiles.find(item => item.path === path);
    if (path) togglePlayAudio(path, file?.duration_seconds ?? null, null, null);
    hideContextMenu();
  });

  document.getElementById("context-copy-name").addEventListener("click", async () => {
    const path = contextMenu.dataset.path;
    if (path) await navigator.clipboard.writeText(path.split(/[\\/]/).pop());
    hideContextMenu();
  });

  document.getElementById("context-toggle-favorite").addEventListener("click", async () => {
    const path = contextMenu.dataset.path;
    if (!path) return;
    if (favoriteFiles.has(path)) {
      await removeFavorite(path);
    } else {
      await addFavorite(path);
    }
    hideContextMenu();
  });

  document.getElementById("context-edit-tags").addEventListener("click", async () => {
    const path = contextMenu.dataset.path;
    if (!path) return;
    if (!favoriteFiles.has(path)) await addFavorite(path);
    openTagEditModal(path, favoriteFiles.get(path)?.tags || []);
    hideContextMenu();
  });

  document.getElementById("context-open-explorer").addEventListener("click", () => {
    const path = contextMenu.dataset.path;
    if (path) {
      openInExplorer(path);
    }
    hideContextMenu();
  });

  document.getElementById("sidebar-current-folder").addEventListener("contextmenu", event => {
    if (!currentFolder) return;
    event.preventDefault();
    event.stopPropagation();
    showBreadcrumbContextMenu(event.clientX, event.clientY, currentFolder);
  });

  // アドレスバーのイベントリスナー
  const addressBar = document.querySelector(".address-bar");
  const breadcrumbContainer = document.getElementById("breadcrumb-container");
  const addressInput = document.getElementById("address-input");

  // アドレスバーの空白部分をクリックで入力モードに
  addressBar.addEventListener("click", (e) => {
    if (e.target === addressBar || e.target === breadcrumbContainer) {
      showAddressInput();
    }
  });

  // 入力欄でEnterを押したらそのパスに移動
  addressInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const path = addressInput.value.trim();
      if (path) {
        try {
          await openFolder(path);
          hideAddressInput();
        } catch (error) {
          alert("指定されたパスを開けませんでした: " + error);
        }
      }
    } else if (e.key === "Escape") {
      hideAddressInput();
    }
  });

  // 入力欄からフォーカスが外れたら入力モードを終了
  addressInput.addEventListener("blur", () => {
    hideAddressInput();
  });

  // パンくずリスト用コンテキストメニューのイベントリスナー
  document.getElementById("breadcrumb-context-bookmark").addEventListener("click", () => {
    const menu = document.getElementById("breadcrumb-context-menu");
    const path = menu.dataset.path;
    if (path) {
      addBookmark(path);
    }
    hideBreadcrumbContextMenu();
  });

  document.getElementById("breadcrumb-context-open-explorer").addEventListener("click", () => {
    const menu = document.getElementById("breadcrumb-context-menu");
    const path = menu.dataset.path;
    if (path) {
      openInExplorer(path);
    }
    hideBreadcrumbContextMenu();
  });

  // どこかをクリックしたらコンテキストメニューを閉じる
  document.addEventListener("click", (e) => {
    if (!contextMenu.contains(e.target)) {
      hideContextMenu();
    }
    // ブックマーク用コンテキストメニューも閉じる
    const bookmarkContextMenu = document.getElementById("bookmark-context-menu");
    if (!bookmarkContextMenu.contains(e.target)) {
      hideBookmarkContextMenu();
    }
    // パンくずリスト用コンテキストメニューも閉じる
    const breadcrumbContextMenu = document.getElementById("breadcrumb-context-menu");
    if (!breadcrumbContextMenu.contains(e.target)) {
      hideBreadcrumbContextMenu();
    }
  });

  document.addEventListener("contextmenu", event => {
    if (event.defaultPrevented || event.target.closest("input, textarea")) return;
    event.preventDefault();
    hideAllContextMenus();
  });

  // ブックマーク用コンテキストメニューのイベントリスナー
  document.getElementById("bookmark-context-rename").addEventListener("click", () => {
    const menu = document.getElementById("bookmark-context-menu");
    const path = menu.dataset.path;
    const alias = menu.dataset.alias;
    openBookmarkRenameModal(path, alias);
    hideBookmarkContextMenu();
  });

  document.getElementById("bookmark-context-open-explorer").addEventListener("click", () => {
    const menu = document.getElementById("bookmark-context-menu");
    const path = menu.dataset.path;
    if (path) {
      openInExplorer(path);
    }
    hideBookmarkContextMenu();
  });

  document.getElementById("bookmark-context-remove").addEventListener("click", () => {
    const menu = document.getElementById("bookmark-context-menu");
    if (menu.dataset.path) removeBookmark(menu.dataset.path);
    hideBookmarkContextMenu();
  });

  // ブックマーク名前変更モーダルのイベントリスナー
  document.getElementById("bookmark-rename-modal").addEventListener("click", (e) => {
    if (e.target.id === "bookmark-rename-modal") {
      closeBookmarkRenameModal();
    }
  });

  document.getElementById("bookmark-rename-cancel-btn").addEventListener("click", closeBookmarkRenameModal);
  document.getElementById("bookmark-rename-save-btn").addEventListener("click", saveBookmarkRename);

  document.getElementById("bookmark-rename-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      saveBookmarkRename();
    }
  });

  // 検索フィルタのイベントリスナー
  const searchInput = document.getElementById("search-input");
  const clearSearchBtn = document.getElementById("clear-search-btn");

  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim();
    renderAudioFiles();

    // クリアボタンの表示切り替え
    if (searchQuery) {
      clearSearchBtn.classList.add("show");
    } else {
      clearSearchBtn.classList.remove("show");
    }
  });

  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    clearSearchBtn.classList.remove("show");
    renderAudioFiles();
  });

  // 複数タグフィルター
  const tagFilterRoot = document.getElementById("main-tag-filter");
  const tagFilterPanel = document.getElementById("tag-filter-panel");
  const tagFilterToggle = document.getElementById("tag-filter-toggle");
  tagFilterToggle.addEventListener("click", event => {
    event.stopPropagation();
    tagFilterPanel.hidden = !tagFilterPanel.hidden;
    tagFilterToggle.setAttribute("aria-expanded", String(!tagFilterPanel.hidden));
  });
  tagFilterPanel.addEventListener("click", event => event.stopPropagation());
  document.getElementById("tag-filter-favorites").addEventListener("change", event => {
    favoritesOnlyFilter = event.target.checked;
    updateMainTagFilterLabel();
    renderAudioFiles();
    renderLibrarySidebar();
  });
  document.getElementById("tag-filter-clear").addEventListener("click", () => {
    selectedTagFilters.clear();
    favoritesOnlyFilter = false;
    updateMainTagFilterOptions();
    renderAudioFiles();
    renderLibrarySidebar();
  });
  document.getElementById("export-favorites-btn").addEventListener("click", exportFilteredFavorites);
  document.addEventListener("click", event => {
    if (!tagFilterRoot.contains(event.target)) {
      tagFilterPanel.hidden = true;
      tagFilterToggle.setAttribute("aria-expanded", "false");
    }
  });

  document.getElementById("repair-search-btn").addEventListener("click", searchRepairWorkspace);
  document.getElementById("repair-apply-btn").addEventListener("click", applyRepairReplacements);
  document.getElementById("repair-delete-btn").addEventListener("click", deleteSelectedMissingReferences);
  document.getElementById("repair-close-btn").addEventListener("click", closeRepairModal);
  document.getElementById("repair-cancel-btn").addEventListener("click", closeRepairModal);

  // ビュー切り替え
  const gridViewBtn = document.getElementById("grid-view-btn");
  const listViewBtn = document.getElementById("list-view-btn");

  gridViewBtn.classList.toggle("active", !isListView);
  listViewBtn.classList.toggle("active", isListView);

  gridViewBtn.addEventListener("click", () => {
    isListView = false;
    localStorage.setItem("sound-pad-view", "grid");
    gridViewBtn.classList.add("active");
    listViewBtn.classList.remove("active");
    renderAudioFiles();
  });

  listViewBtn.addEventListener("click", () => {
    isListView = true;
    localStorage.setItem("sound-pad-view", "list");
    listViewBtn.classList.add("active");
    gridViewBtn.classList.remove("active");
    renderAudioFiles();
  });

  // Ctrl+Fで検索ボックスにフォーカス
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "f") {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ドロワーの開閉
  document.getElementById("drawer-toggle-btn").addEventListener("click", openDrawer);
  document.getElementById("drawer-close-btn").addEventListener("click", closeDrawer);

  // モーダル背景をクリックで閉じる
  document.getElementById("copy-modal").addEventListener("click", (e) => {
    if (e.target.id === "copy-modal") {
      closeModal();
    }
  });

  // ドロワー背景をクリックで閉じる
  document.getElementById("drawer").addEventListener("click", (e) => {
    if (e.target.id === "drawer") {
      closeDrawer();
    }
  });

  // お気に入り画面
  document.getElementById("favorites-screen-btn").addEventListener("click", openFavoritesModal);
  document.getElementById("favorites-modal-close-btn").addEventListener("click", closeFavoritesModal);
  document.getElementById("favorites-modal").addEventListener("click", (e) => {
    if (e.target.id === "favorites-modal") {
      closeFavoritesModal();
    }
  });

  document.getElementById("favorites-search-input").addEventListener("input", renderFavoritesList);
  document.getElementById("favorites-tag-filter").addEventListener("change", renderFavoritesList);
  document.getElementById("favorites-folder-filter").addEventListener("change", renderFavoritesList);

  // お気に入り選択・一括タグ付与
  document.getElementById("favorites-select-all-checkbox").addEventListener("change", (e) => {
    updateVisibleFavoritesSelection(e.target.checked);
    renderFavoritesList();
  });

  document.getElementById("favorites-bulk-tag-btn").addEventListener("click", openBulkTagModal);

  // 一括タグ編集モーダル
  document.getElementById("bulk-tag-modal-close-btn").addEventListener("click", closeBulkTagModal);
  document.getElementById("bulk-tag-cancel-btn").addEventListener("click", closeBulkTagModal);
  document.getElementById("bulk-tag-save-btn").addEventListener("click", saveBulkTags);
  document.getElementById("bulk-tag-add-btn").addEventListener("click", addBulkTagFromInput);
  document.getElementById("bulk-tag-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      addBulkTagFromInput();
    }
  });
  document.getElementById("bulk-tag-modal").addEventListener("click", (e) => {
    if (e.target.id === "bulk-tag-modal") {
      closeBulkTagModal();
    }
  });

  // タグ編集モーダル
  document.getElementById("tag-edit-modal-close-btn").addEventListener("click", closeTagEditModal);
  document.getElementById("tag-cancel-btn").addEventListener("click", closeTagEditModal);
  document.getElementById("tag-save-btn").addEventListener("click", saveTagEdits);
  document.getElementById("tag-add-btn").addEventListener("click", addTagFromInput);
  document.getElementById("tag-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      addTagFromInput();
    }
  });
  document.getElementById("tag-edit-modal").addEventListener("click", (e) => {
    if (e.target.id === "tag-edit-modal") {
      closeTagEditModal();
    }
  });

  // プレイヤーパネルのコントロール
  const playPauseBtn = document.getElementById("player-play-pause-btn");
  const stopBtn = document.getElementById("player-stop-btn");
  const seekbar = document.getElementById("player-seekbar");

  playPauseBtn.addEventListener("click", async () => {
    try {
      const status = await invoke("get_playback_status");
      if (status.is_paused) {
        await invoke("resume_audio");
        playPauseBtn.innerHTML = '<i class="mdi mdi-pause"></i>';
      } else if (status.is_playing) {
        await invoke("pause_audio");
        playPauseBtn.innerHTML = '<i class="mdi mdi-play"></i>';
      } else if (lastPlayedPath) {
        // 停止状態だが、前回再生したファイルがある場合は再生を開始
        await invoke("play_audio", { path: lastPlayedPath });
        currentPlayingPath = lastPlayedPath;
        currentPlayingDuration = lastPlayedDuration;
        playPauseBtn.innerHTML = '<i class="mdi mdi-pause"></i>';
        playPauseBtn.disabled = false;
        stopBtn.disabled = false;
        updatePlayerPanel(lastPlayedPath, lastPlayedDuration);
        startPlaybackUpdate();
        // UIも更新
        const allItems = document.querySelectorAll('.audio-item[data-path]');
        for (const el of allItems) {
          if (el.dataset.path === lastPlayedPath) {
            el.classList.add("playing");
            const button = el.querySelector(".play-btn");
            if (button) {
              button.innerHTML = '<i class="mdi mdi-stop"></i> 停止';
              button.classList.add("stopping");
            }
            break;
          }
        }
      }
    } catch (error) {
      console.error("Error toggling play/pause:", error);
    }
  });

  stopBtn.addEventListener("click", async () => {
    try {
      await invoke("stop_audio");
      resetPlayingUI();
      stopPlaybackUpdate();
    } catch (error) {
      console.error("Error stopping audio:", error);
    }
  });

  const commitSeek = async () => {
    if (!currentPlayingPath) return;
    try {
      const status = await invoke("get_playback_status");
      if (!status.is_playing && !status.is_paused) return;
      const position = Number.parseFloat(seekbar.value);
      const path = currentPlayingPath;
      await invoke("seek_audio", { path, position });
      if (status.is_paused) {
        await invoke("pause_audio");
      }
    } catch (error) {
      console.error("Error seeking:", error);
    }
  };

  seekbar.addEventListener("pointerdown", (e) => {
    seekbar.dataset.dragging = "true";
    seekbar.setPointerCapture?.(e.pointerId);
  });

  seekbar.addEventListener("input", () => {
    if (seekbar.dataset.dragging) {
      document.getElementById("player-current-time").textContent = formatDuration(Number.parseFloat(seekbar.value));
    }
  });

  seekbar.addEventListener("pointerup", async () => {
    if (!seekbar.dataset.dragging) return;
    delete seekbar.dataset.dragging;
    seekbar.dataset.committedByPointer = "true";
    setTimeout(() => delete seekbar.dataset.committedByPointer, 0);
    await commitSeek();
  });

  seekbar.addEventListener("pointercancel", () => {
    delete seekbar.dataset.dragging;
  });

  seekbar.addEventListener("change", async () => {
    if (seekbar.dataset.committedByPointer) {
      delete seekbar.dataset.committedByPointer;
      return;
    }
    if (!seekbar.dataset.dragging) {
      await commitSeek();
    }
  });

  // 初期表示
  renderHistory();
  renderBookmarks();
  getFavoriteFiles();
  loadPlaylists();

  // 音声再生終了イベントをリッスン
  listen("audio-finished", (event) => {
    const finishedPath = event.payload;

    // 再生が終了したファイルのUIを更新
    if (currentPlayingPath === finishedPath) {
      resetPlayingUI();
      stopPlaybackUpdate();
    }
  });
});
