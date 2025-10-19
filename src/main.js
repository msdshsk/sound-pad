const { invoke } = window.__TAURI__.core;
const { open } = window.__TAURI__.dialog;
const { listen } = window.__TAURI__.event;

let audioFiles = [];
let selectedFiles = new Set();
let currentPlayingPath = null;
let currentFolder = null;
let lastCopiedDestination = null;

// LocalStorage キー
const HISTORY_KEY = "sound-pad-history";
const BOOKMARKS_KEY = "sound-pad-bookmarks";

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

// ブックマークを取得
function getBookmarks() {
  const stored = localStorage.getItem(BOOKMARKS_KEY);
  return stored ? JSON.parse(stored) : [];
}

// ブックマークを保存
function saveBookmarks(bookmarks) {
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

// ブックマークに追加
function addBookmark(path) {
  let bookmarks = getBookmarks();
  if (!bookmarks.includes(path)) {
    bookmarks.push(path);
    saveBookmarks(bookmarks);
    renderBookmarks();
  }
}

// ブックマークから削除
function removeBookmark(path) {
  let bookmarks = getBookmarks();
  bookmarks = bookmarks.filter(p => p !== path);
  saveBookmarks(bookmarks);
  renderBookmarks();
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

  if (bookmarks.length === 0) {
    container.innerHTML = '<p class="empty-message">ブックマークはありません</p>';
    return;
  }

  container.innerHTML = "";
  bookmarks.forEach(path => {
    const item = document.createElement("div");
    item.className = "shortcut-item";

    const folderName = getFolderName(path);
    const pathSpan = document.createElement("span");
    pathSpan.className = "shortcut-path";
    pathSpan.textContent = truncateFolderName(folderName);
    pathSpan.title = path;

    const removeBtn = document.createElement("button");
    removeBtn.className = "shortcut-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "削除";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeBookmark(path);
    });

    item.appendChild(pathSpan);
    item.appendChild(removeBtn);
    item.addEventListener("click", () => {
      openFolder(path);
      closeDrawer();
    });

    container.appendChild(item);
  });
}

// フォルダを開く
async function openFolder(path) {
  currentFolder = path;
  document.getElementById("current-folder").textContent = path;
  document.getElementById("bookmark-current-btn").disabled = false;

  addToHistory(path);
  await loadAudioFiles(path);
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
    audioFiles = await invoke("get_audio_files", { directory });
    renderAudioFiles();
  } catch (error) {
    console.error("Error loading audio files:", error);
    alert("ファイルの読み込み中にエラーが発生しました: " + error);
  }
}

// 音声ファイル一覧を表示
function renderAudioFiles() {
  const grid = document.getElementById("audio-grid");

  if (audioFiles.length === 0) {
    grid.innerHTML = '<p class="placeholder">このフォルダには音声ファイルがありません</p>';
    return;
  }

  grid.innerHTML = "";

  audioFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "audio-item";
    item.dataset.index = index;
    item.dataset.path = file.path;

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

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "audio-item-name";
    nameInput.value = file.name;
    nameInput.dataset.originalPath = file.path;
    nameInput.addEventListener("blur", async (e) => {
      const newName = e.target.value.trim();
      const originalPath = e.target.dataset.originalPath;

      if (newName && newName !== file.name) {
        await renameFile(originalPath, newName, index);
      } else {
        e.target.value = file.name;
      }
    });
    nameInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        e.target.blur();
      }
    });

    header.appendChild(checkbox);
    header.appendChild(nameInput);

    const playBtn = document.createElement("button");
    playBtn.className = "play-btn";
    playBtn.innerHTML = '<i class="mdi mdi-play"></i> 再生';
    playBtn.addEventListener("click", () => togglePlayAudio(file.path, item, playBtn));

    item.appendChild(header);
    item.appendChild(playBtn);
    grid.appendChild(item);

    if (selectedFiles.has(file.path)) {
      item.classList.add("selected");
    }
  });

  updateSelectedCount();
}

// 音声の再生/停止を切り替え
async function togglePlayAudio(path, itemElement, buttonElement) {
  try {
    // 既に再生中の同じファイルをクリックした場合は停止
    if (currentPlayingPath === path) {
      await invoke("stop_audio");
      itemElement.classList.remove("playing");
      buttonElement.innerHTML = '<i class="mdi mdi-play"></i> 再生';
      buttonElement.classList.remove("stopping");
      currentPlayingPath = null;
      return;
    }

    // 前回再生中の要素をリセット
    if (currentPlayingPath) {
      const prevItem = document.querySelector(`[data-path="${currentPlayingPath}"]`);
      if (prevItem) {
        prevItem.classList.remove("playing");
        const prevButton = prevItem.querySelector(".play-btn");
        if (prevButton) {
          prevButton.innerHTML = '<i class="mdi mdi-play"></i> 再生';
          prevButton.classList.remove("stopping");
        }
      }
    }

    // 音声を再生
    await invoke("play_audio", { path });

    // 新しい再生中の要素を設定
    currentPlayingPath = path;
    itemElement.classList.add("playing");
    buttonElement.innerHTML = '<i class="mdi mdi-stop"></i> 停止';
    buttonElement.classList.add("stopping");
  } catch (error) {
    console.error("Error playing audio:", error);
    alert("音声の再生中にエラーが発生しました: " + error);
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

  const renameBtn = document.getElementById("rename-selected-btn");
  const copyBtn = document.getElementById("copy-selected-btn");

  renameBtn.disabled = count === 0;
  copyBtn.disabled = count === 0;
}

// 選択したファイルの名前を一括編集
async function renameSelected() {
  if (selectedFiles.size === 0) return;

  const prefix = prompt("ファイル名の接頭辞を入力してください（空欄の場合は変更なし）:");
  if (prefix === null) return;

  const suffix = prompt("ファイル名の接尾辞を入力してください（空欄の場合は変更なし）:");
  if (suffix === null) return;

  if (!prefix && !suffix) {
    alert("接頭辞または接尾辞を入力してください");
    return;
  }

  const selectedArray = Array.from(selectedFiles);
  for (const filePath of selectedArray) {
    const fileIndex = audioFiles.findIndex(f => f.path === filePath);
    if (fileIndex === -1) continue;

    const file = audioFiles[fileIndex];
    const nameParts = file.name.split(".");
    const extension = nameParts.pop();
    const baseName = nameParts.join(".");
    const newName = `${prefix}${baseName}${suffix}.${extension}`;

    try {
      await renameFile(filePath, newName, fileIndex);
    } catch (error) {
      console.error(`Error renaming ${file.name}:`, error);
    }
  }
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

// イベントリスナーの設定
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("select-folder-btn").addEventListener("click", selectFolder);
  document.getElementById("bookmark-current-btn").addEventListener("click", bookmarkCurrent);
  document.getElementById("rename-selected-btn").addEventListener("click", renameSelected);
  document.getElementById("copy-selected-btn").addEventListener("click", copySelected);
  document.getElementById("modal-ok-btn").addEventListener("click", closeModal);
  document.getElementById("modal-open-folder-btn").addEventListener("click", openCopiedFolder);

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

  // 初期表示
  renderHistory();
  renderBookmarks();

  // 音声再生終了イベントをリッスン
  listen("audio-finished", (event) => {
    const finishedPath = event.payload;

    // 再生が終了したファイルのUIを更新
    if (currentPlayingPath === finishedPath) {
      // data-path属性を持つすべての要素を確認し、直接比較
      const allItems = document.querySelectorAll('.audio-item[data-path]');

      let item = null;
      for (const el of allItems) {
        if (el.dataset.path === finishedPath) {
          item = el;
          break;
        }
      }

      if (item) {
        item.classList.remove("playing");
        const button = item.querySelector(".play-btn");
        if (button) {
          button.innerHTML = '<i class="mdi mdi-play"></i> 再生';
          button.classList.remove("stopping");
        }
      }
      currentPlayingPath = null;
    }
  });
});
