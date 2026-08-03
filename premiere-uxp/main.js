const ppro = require("premierepro");
const { localFileSystem } = require("uxp").storage;

const STORAGE_KEYS = {
  fileToken: "sound-pad:last-json-token",
  trackIndex: "sound-pad:audio-track-index",
};

const state = {
  source: null,
  items: [],
  project: null,
  sequence: null,
  tracks: [],
  expandedPaths: new Set(),
  busy: false,
  previewPath: null,
  previewBusy: false,
  projectItemsByPath: new Map(),
  projectItemIndexGuid: "",
};

const elements = {};

function bindElements() {
  elements.sequenceName = document.getElementById("sequence-name");
  elements.openJsonButton = document.getElementById("open-json-button");
  elements.sourceKind = document.getElementById("source-kind");
  elements.sourceName = document.getElementById("source-name");
  elements.sourceFile = document.getElementById("source-file");
  elements.itemSummary = document.getElementById("item-summary");
  elements.trackSelect = document.getElementById("track-select");
  elements.refreshButton = document.getElementById("refresh-button");
  elements.notice = document.getElementById("notice");
  elements.emptyState = document.getElementById("empty-state");
  elements.itemList = document.getElementById("item-list");
}

function setBusy(busy, message) {
  state.busy = busy;
  elements.openJsonButton.disabled = busy;
  elements.refreshButton.disabled = busy;
  elements.trackSelect.disabled = busy || state.tracks.length === 0;
  if (elements.itemList) {
    for (const button of elements.itemList.querySelectorAll(".place-button")) {
      button.disabled = busy || button.dataset.canPlace !== "true";
    }
    for (const button of elements.itemList.querySelectorAll(".preview-button")) {
      button.disabled = busy || state.previewBusy || button.dataset.canPreview !== "true";
    }
  }
  if (message) {
    showNotice(message);
  }
}

function showNotice(message, isError = false) {
  elements.notice.textContent = message || "";
  elements.notice.classList.toggle("visible", Boolean(message));
  elements.notice.classList.toggle("error", Boolean(message) && isError);
}

function normalizePath(filePath) {
  return String(filePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "")
    .toLocaleLowerCase();
}

function guidToString(guid) {
  if (!guid) {
    return "";
  }
  return typeof guid.toString === "function" ? guid.toString() : String(guid);
}

function basename(filePath) {
  const parts = String(filePath || "").split(/[\\/]/);
  return parts[parts.length - 1] || String(filePath || "");
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "";
  }
  const wholeSeconds = Math.floor(seconds);
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTimelineTime(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.floor((safeSeconds % 1) * 1000);
  return [hours, minutes, wholeSeconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":") + `.${String(milliseconds).padStart(3, "0")}`;
}

function parseSoundPadJson(data, fileName) {
  if (!data || typeof data !== "object") {
    throw new Error("JSONのルートがオブジェクトではありません。");
  }
  if (data.schema_version !== 1) {
    throw new Error(`未対応のschema_versionです: ${data.schema_version}`);
  }

  let kind;
  let name;
  let rawItems;

  if (data.format === "sound-pad-setlist") {
    if (!data.setlist || !Array.isArray(data.setlist.items)) {
      throw new Error("セットリストのitemsが見つかりません。");
    }
    kind = "セットリスト";
    name = data.setlist.name || fileName;
    rawItems = data.setlist.items;
  } else if (data.format === "sound-pad-favorites") {
    if (!Array.isArray(data.items)) {
      throw new Error("お気に入りのitemsが見つかりません。");
    }
    kind = "お気に入り";
    name = Array.isArray(data.filters && data.filters.tags) && data.filters.tags.length
      ? data.filters.tags.join(" + ")
      : fileName;
    rawItems = data.items;
  } else {
    throw new Error(`未対応のformatです: ${data.format || "なし"}`);
  }

  const items = rawItems.map((item, index) => {
    if (!item || typeof item.file_path !== "string" || !item.file_path.trim()) {
      throw new Error(`${index + 1}件目のfile_pathが不正です。`);
    }
    return {
      id: `${index}:${normalizePath(item.file_path)}`,
      order: Number.isFinite(item.order) ? item.order : index + 1,
      filePath: item.file_path,
      normalizedPath: normalizePath(item.file_path),
      fileName: item.file_name || basename(item.file_path),
      durationSeconds: Number(item.duration_seconds),
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      projectItem: null,
      placements: [],
    };
  });

  return {
    source: { kind, name, fileName, format: data.format },
    items,
  };
}

async function getPremiereContext() {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new Error("Premiere Proでプロジェクトを開いてください。");
  }
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    throw new Error("アクティブなシーケンスがありません。");
  }
  return { project, sequence };
}

async function refreshTracks(sequence) {
  const previousValue = elements.trackSelect.value;
  const savedValue = localStorage.getItem(STORAGE_KEYS.trackIndex);
  const trackCount = await sequence.getAudioTrackCount();
  const tracks = [];

  elements.trackSelect.innerHTML = "";
  for (let index = 0; index < trackCount; index += 1) {
    const track = await sequence.getAudioTrack(index);
    tracks.push({ index, name: track.name || `Audio ${index + 1}`, track });

    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `A${index + 1}: ${track.name || `Audio ${index + 1}`}`;
    elements.trackSelect.appendChild(option);
  }

  state.tracks = tracks;
  const preferredValue = previousValue || savedValue || "0";
  const valueExists = tracks.some((entry) => String(entry.index) === preferredValue);
  if (tracks.length) {
    elements.trackSelect.value = valueExists ? preferredValue : "0";
  } else {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "オーディオトラックなし";
    elements.trackSelect.appendChild(option);
  }
  elements.trackSelect.disabled = state.busy || tracks.length === 0;
}

async function buildProjectItemIndex(project) {
  const itemsByPath = new Map();
  const rootItem = await project.getRootItem();
  const folders = [rootItem];

  while (folders.length) {
    const folder = folders.shift();
    const children = await folder.getItems();
    for (const child of children || []) {
      let mediaPath = "";
      try {
        const clipItem = ppro.ClipProjectItem.cast(child);
        mediaPath = await clipItem.getMediaFilePath();
      } catch (error) {
        // Bin、シーケンスなど、ファイルメディアではない項目はここを通る。
      }

      if (mediaPath) {
        const normalizedPath = normalizePath(mediaPath);
        if (normalizedPath && !itemsByPath.has(normalizedPath)) {
          itemsByPath.set(normalizedPath, child);
        }
        continue;
      }

      try {
        const childFolder = ppro.FolderItem.cast(child);
        await childFolder.getItems();
        folders.push(childFolder);
      } catch (error) {
        // 子項目を持たないProjectItemは走査対象外。
      }
    }
  }

  state.projectItemsByPath = itemsByPath;
  state.projectItemIndexGuid = guidToString(project.guid);
  return itemsByPath;
}

async function findExactProjectItem(filePath, project = state.project) {
  if (!project) {
    return null;
  }

  const expectedPath = normalizePath(filePath);
  const projectGuid = guidToString(project.guid);
  if (state.projectItemIndexGuid !== projectGuid) {
    await buildProjectItemIndex(project);
  }

  let candidate = state.projectItemsByPath.get(expectedPath) || null;
  if (candidate) {
    try {
      const clipItem = ppro.ClipProjectItem.cast(candidate);
      const actualPath = await clipItem.getMediaFilePath();
      if (normalizePath(actualPath) === expectedPath) {
        return candidate;
      }
    } catch (error) {
      candidate = null;
    }
  }

  const refreshedItems = await buildProjectItemIndex(project);
  return refreshedItems.get(expectedPath) || null;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function resolveProjectItems() {
  const projectItemsByPath = await buildProjectItemIndex(state.project);
  for (const item of state.items) {
    item.projectItem = projectItemsByPath.get(item.normalizedPath) || null;
  }
}

async function getPlacementData(trackEntry, trackItem) {
  try {
    const [projectItem, startTime] = await Promise.all([
      trackItem.getProjectItem(),
      trackItem.getStartTime(),
    ]);
    const clipItem = ppro.ClipProjectItem.cast(projectItem);
    const mediaPath = await clipItem.getMediaFilePath();
    return {
      normalizedPath: normalizePath(mediaPath),
      placement: {
        trackIndex: trackEntry.index,
        trackName: trackEntry.name,
        seconds: startTime.seconds,
      },
    };
  } catch (error) {
    return null;
  }
}

async function scanTimelinePlacements() {
  const jobs = [];
  for (const trackEntry of state.tracks) {
    const trackItems = trackEntry.track.getTrackItems(
      ppro.Constants.TrackItemType.CLIP,
      false
    );
    for (const trackItem of trackItems || []) {
      jobs.push({ trackEntry, trackItem });
    }
  }

  const placementData = await mapWithConcurrency(jobs, 8, (job) =>
    getPlacementData(job.trackEntry, job.trackItem)
  );
  const placementsByPath = new Map();
  for (const entry of placementData) {
    if (!entry || !seenByJson(entry.normalizedPath)) {
      continue;
    }
    const placements = placementsByPath.get(entry.normalizedPath) || [];
    placements.push(entry.placement);
    placementsByPath.set(entry.normalizedPath, placements);
  }

  for (const item of state.items) {
    item.placements = (placementsByPath.get(item.normalizedPath) || [])
      .slice()
      .sort((a, b) => a.seconds - b.seconds || a.trackIndex - b.trackIndex);
  }
}

function seenByJson(normalizedPath) {
  return state.items.some((item) => item.normalizedPath === normalizedPath);
}

async function refreshAll(options = {}) {
  const { announce = true } = options;
  setBusy(true, announce ? "Premiere Proのプロジェクトと照合しています…" : "");
  try {
    const context = await getPremiereContext();
    state.project = context.project;
    state.sequence = context.sequence;
    elements.sequenceName.textContent = context.sequence.name;
    elements.sequenceName.title = context.sequence.name;
    await refreshTracks(context.sequence);

    if (state.items.length) {
      await resolveProjectItems();
      await scanTimelinePlacements();
    }
    render();

    if (announce) {
      const available = state.items.filter((item) => item.projectItem).length;
      const missing = state.items.length - available;
      showNotice(
        missing
          ? `${available}件が配置可能、${missing}件はプロジェクト内にありません。`
          : state.items.length
            ? `${available}件すべて配置できます。`
            : "Premiere Proと接続しました。"
      );
    } else {
      showNotice("");
    }
  } catch (error) {
    state.project = null;
    state.sequence = null;
    state.tracks = [];
    state.projectItemsByPath = new Map();
    state.projectItemIndexGuid = "";
    elements.sequenceName.textContent = "シーケンス未取得";
    render();
    showNotice(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

function createTag(tagName) {
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = tagName;
  tag.title = tagName;
  return tag;
}

function createPlacementRow(item, placement) {
  const row = document.createElement("div");
  row.className = "placement-row";

  const label = document.createElement("span");
  const time = document.createElement("span");
  time.className = "placement-time";
  time.textContent = formatTimelineTime(placement.seconds);
  label.append(`A${placement.trackIndex + 1} `, time);
  if (placement.trackName) {
    label.append(`  ${placement.trackName}`);
  }

  const jumpButton = document.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "placement-button";
  jumpButton.textContent = "移動";
  jumpButton.addEventListener("click", (event) => {
    event.stopPropagation();
    jumpToPlacement(placement.seconds);
  });

  row.append(label, jumpButton);
  return row;
}

function createItemRow(item, index) {
  const article = document.createElement("article");
  article.className = "sound-item";
  article.classList.toggle("unavailable", !item.projectItem);
  article.classList.toggle("expanded", state.expandedPaths.has(item.id));

  const main = document.createElement("div");
  main.className = "item-main";

  const order = document.createElement("span");
  order.className = "order";
  order.textContent = String(item.order || index + 1);

  const content = document.createElement("div");
  content.className = "item-content";
  const primary = document.createElement("div");
  primary.className = "item-primary";

  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "name-button";
  nameButton.classList.toggle("has-placements", item.placements.length > 0);
  nameButton.textContent = item.fileName;
  nameButton.title = item.filePath;
  nameButton.addEventListener("click", () => {
    if (item.placements.length) {
      togglePlacements(item.id);
    }
  });
  primary.appendChild(nameButton);

  if (item.placements.length) {
    const usedBadge = document.createElement("span");
    usedBadge.className = "used-badge";
    usedBadge.textContent = `使用済み ×${item.placements.length}`;
    primary.appendChild(usedBadge);
  }

  const meta = document.createElement("div");
  meta.className = "item-meta";
  const duration = formatDuration(item.durationSeconds);
  if (duration) {
    const durationText = document.createElement("span");
    durationText.textContent = duration;
    meta.appendChild(durationText);
  }
  if (!item.projectItem) {
    const missing = document.createElement("span");
    missing.className = "missing-label";
    missing.textContent = "プロジェクトに未登録";
    meta.appendChild(missing);
  }
  if (item.tags.length) {
    const tags = document.createElement("span");
    tags.className = "tags";
    for (const tagName of item.tags) {
      tags.appendChild(createTag(tagName));
    }
    meta.appendChild(tags);
  }

  content.append(primary, meta);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  const previewButton = document.createElement("button");
  const isPreviewing = state.previewPath === item.normalizedPath;
  previewButton.type = "button";
  previewButton.className = "preview-button";
  previewButton.classList.toggle("playing", isPreviewing);
  previewButton.textContent = isPreviewing ? "停止" : "試聴";
  previewButton.title = item.projectItem
    ? isPreviewing
      ? "Source Monitorの試聴を停止"
      : "Source Monitorで先頭から試聴"
    : "Premiere Proのプロジェクトに素材がありません";
  previewButton.dataset.canPreview = String(Boolean(item.projectItem));
  previewButton.disabled = state.busy || state.previewBusy || !item.projectItem;
  previewButton.addEventListener("click", () => togglePreview(item.id));

  const placeButton = document.createElement("button");
  placeButton.type = "button";
  placeButton.className = "place-button";
  placeButton.textContent = "配置";
  placeButton.title = item.projectItem
    ? "現在の再生ヘッド位置へ上書き配置"
    : "Premiere Proのプロジェクトに素材がありません";
  placeButton.dataset.canPlace = String(
    Boolean(item.projectItem && state.sequence && state.tracks.length)
  );
  placeButton.disabled = state.busy || !item.projectItem || !state.sequence || !state.tracks.length;
  placeButton.addEventListener("click", () => placeItem(item.id));
  actions.append(previewButton, placeButton);

  main.append(order, content, actions);

  const placements = document.createElement("div");
  placements.className = "placements";
  for (const placement of item.placements) {
    placements.appendChild(createPlacementRow(item, placement));
  }

  article.append(main, placements);
  return article;
}

function render() {
  const hasItems = state.items.length > 0;
  elements.emptyState.style.display = hasItems ? "none" : "flex";
  elements.itemList.innerHTML = "";

  if (state.source) {
    elements.sourceKind.textContent = state.source.kind;
    elements.sourceName.textContent = state.source.name;
    elements.sourceName.title = state.source.name;
    elements.sourceFile.textContent = state.source.fileName;
    elements.sourceFile.title = state.source.fileName;
  } else {
    elements.sourceKind.textContent = "未読み込み";
    elements.sourceName.textContent = "JSONを選択してください";
    elements.sourceFile.textContent = "";
  }

  if (hasItems) {
    const available = state.items.filter((item) => item.projectItem).length;
    elements.itemSummary.textContent = `${available}/${state.items.length}件`;
    for (let index = 0; index < state.items.length; index += 1) {
      elements.itemList.appendChild(createItemRow(state.items[index], index));
    }
  } else {
    elements.itemSummary.textContent = "0件";
  }
}

function togglePlacements(itemId) {
  if (state.expandedPaths.has(itemId)) {
    state.expandedPaths.delete(itemId);
  } else {
    state.expandedPaths.add(itemId);
  }
  render();
}

async function jumpToPlacement(seconds) {
  try {
    const context = await getPremiereContext();
    const tickTime = ppro.TickTime.createWithSeconds(seconds);
    await context.sequence.setPlayerPosition(tickTime);
    showNotice(`再生ヘッドを ${formatTimelineTime(seconds)} へ移動しました。`);
  } catch (error) {
    showNotice(error.message || String(error), true);
  }
}

async function stopSourceMonitorPlayback() {
  try {
    const stopped = await ppro.SourceMonitor.play(0);
    if (stopped === false) {
      await ppro.SourceMonitor.closeClip();
    }
  } catch (error) {
    await ppro.SourceMonitor.closeClip();
  }
}

async function togglePreview(itemId) {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || !item.projectItem || state.busy || state.previewBusy) {
    return;
  }

  state.previewBusy = true;
  render();
  try {
    if (state.previewPath === item.normalizedPath) {
      await stopSourceMonitorPlayback();
      state.previewPath = null;
      showNotice(`${item.fileName} の試聴を停止しました。`);
      return;
    }

    if (state.previewPath) {
      await stopSourceMonitorPlayback();
      state.previewPath = null;
    }

    const context = await getPremiereContext();
    const projectItem = await findExactProjectItem(item.filePath, context.project);
    if (!projectItem) {
      item.projectItem = null;
      throw new Error("素材がプロジェクト内からなくなりました。再照合してください。");
    }

    await ppro.SourceMonitor.openProjectItem(projectItem);
    if (typeof ppro.SourceMonitor.setPosition === "function") {
      await ppro.SourceMonitor.setPosition(ppro.TickTime.createWithSeconds(0));
    }
    const played = await ppro.SourceMonitor.play(1);
    if (played === false) {
      throw new Error("Source Monitorで再生を開始できませんでした。");
    }
    state.previewPath = item.normalizedPath;
    showNotice(`${item.fileName} をSource Monitorで試聴しています。`);
  } catch (error) {
    state.previewPath = null;
    showNotice(error.message || String(error), true);
  } finally {
    state.previewBusy = false;
    render();
  }
}

async function placeItem(itemId) {
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item || !item.projectItem || state.busy) {
    return;
  }

  setBusy(true, `${item.fileName} を配置しています…`);
  try {
    if (state.previewPath) {
      await stopSourceMonitorPlayback();
      state.previewPath = null;
    }
    const context = await getPremiereContext();
    const trackIndex = Number(elements.trackSelect.value);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) {
      throw new Error("配置先のオーディオトラックを選択してください。");
    }

    const currentItem = await findExactProjectItem(item.filePath, context.project);
    if (!currentItem) {
      item.projectItem = null;
      throw new Error("素材がプロジェクト内からなくなりました。再照合してください。");
    }

    const playhead = await context.sequence.getPlayerPosition();
    const editor = ppro.SequenceEditor.getEditor(context.sequence);
    let transactionSucceeded = false;
    context.project.lockedAccess(() => {
      const overwriteAction = editor.createOverwriteItemAction(
        currentItem,
        playhead,
        -1,
        trackIndex
      );
      transactionSucceeded = context.project.executeTransaction(
        (compoundAction) => compoundAction.addAction(overwriteAction),
        `Sound Pad: ${item.fileName}を配置`
      );
    });

    if (!transactionSucceeded) {
      throw new Error("Premiere Proが配置処理を完了できませんでした。");
    }

    state.project = context.project;
    state.sequence = context.sequence;
    await refreshTracks(context.sequence);
    await scanTimelinePlacements();
    render();
    showNotice(`${item.fileName} をA${trackIndex + 1}へ上書き配置しました。`);
  } catch (error) {
    render();
    showNotice(error.message || String(error), true);
  } finally {
    setBusy(false);
  }
}

async function loadJsonFile(file, rememberFile) {
  setBusy(true, `${file.name} を読み込んでいます…`);
  try {
    if (state.previewPath) {
      await stopSourceMonitorPlayback();
      state.previewPath = null;
    }
    const content = await file.read();
    const parsed = parseSoundPadJson(JSON.parse(content), file.name);
    state.source = parsed.source;
    state.items = parsed.items;
    state.expandedPaths.clear();

    if (rememberFile) {
      const token = await localFileSystem.createPersistentToken(file);
      localStorage.setItem(STORAGE_KEYS.fileToken, token);
    }
    render();
    await refreshAll();
  } catch (error) {
    showNotice(`JSONを読み込めませんでした: ${error.message || error}`, true);
  } finally {
    setBusy(false);
  }
}

async function chooseJsonFile() {
  try {
    const file = await localFileSystem.getFileForOpening({
      types: ["json"],
    });
    if (file) {
      await loadJsonFile(file, true);
    }
  } catch (error) {
    showNotice(`ファイル選択に失敗しました: ${error.message || error}`, true);
  }
}

async function restoreLastJson() {
  const token = localStorage.getItem(STORAGE_KEYS.fileToken);
  if (!token) {
    return false;
  }
  try {
    const file = await localFileSystem.getEntryForPersistentToken(token);
    await loadJsonFile(file, false);
    return true;
  } catch (error) {
    localStorage.removeItem(STORAGE_KEYS.fileToken);
    showNotice("前回のJSONを開けませんでした。もう一度選択してください。", true);
    return false;
  }
}

function bindEvents() {
  elements.openJsonButton.addEventListener("click", chooseJsonFile);
  elements.refreshButton.addEventListener("click", () => refreshAll());
  elements.trackSelect.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEYS.trackIndex, elements.trackSelect.value);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  render();
  const restored = await restoreLastJson();
  if (!restored) {
    await refreshAll({ announce: false });
  }
});
