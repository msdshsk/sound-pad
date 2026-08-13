use rodio::{Decoder, OutputStream, OutputStreamBuilder, Sink, Source};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Write as IoWrite};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

mod music_analysis;
use music_analysis::{
    analyze_music_files, get_music_analysis, get_music_analysis_status, get_similar_tracks,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioFile {
    name: String,
    path: String,
    duration_seconds: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirectoryItem {
    name: String,
    path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DirectoryContents {
    directories: Vec<DirectoryItem>,
    files: Vec<AudioFile>,
}

#[derive(Clone)]
pub struct AudioPlayer {
    sink: Arc<Mutex<Option<Sink>>>,
    _stream: Arc<Mutex<Option<OutputStream>>>,
    current_path: Arc<Mutex<Option<String>>>,
    current_duration: Arc<Mutex<Option<f64>>>,
    start_time: Arc<Mutex<Option<Instant>>>,
    start_position: Arc<Mutex<f64>>,
    is_paused: Arc<Mutex<bool>>,
    paused_position: Arc<Mutex<f64>>,
    volume: Arc<Mutex<f32>>,
}

// Safe because all fields are protected by Mutex
unsafe impl Send for AudioPlayer {}
unsafe impl Sync for AudioPlayer {}

impl AudioPlayer {
    pub fn new() -> Self {
        Self {
            sink: Arc::new(Mutex::new(None)),
            _stream: Arc::new(Mutex::new(None)),
            current_path: Arc::new(Mutex::new(None)),
            current_duration: Arc::new(Mutex::new(None)),
            start_time: Arc::new(Mutex::new(None)),
            start_position: Arc::new(Mutex::new(0.0)),
            is_paused: Arc::new(Mutex::new(false)),
            paused_position: Arc::new(Mutex::new(0.0)),
            volume: Arc::new(Mutex::new(0.35)),
        }
    }

    pub fn play(&self, path: &str, skip_seconds: Option<f64>) -> Result<(), String> {
        // 前の再生を停止
        self.stop();

        // リソースが完全に解放されるまで少し待つ
        std::thread::sleep(std::time::Duration::from_millis(50));

        // ファイルを開く（リトライ機能付き）
        let file = self.open_file_with_retry(path, 3)?;

        // BufReaderを使用
        let reader = BufReader::new(file);
        let source = Decoder::new(reader).map_err(|e| {
            eprintln!("デコーダーエラー ({}): {}", path, e);
            format!("デコーダーエラー: {}", e)
        })?;

        let stream = OutputStreamBuilder::open_default_stream().map_err(|e| e.to_string())?;
        let sink = Sink::connect_new(stream.mixer());
        sink.set_volume(*self.volume.lock().unwrap());

        // スキップが指定されている場合
        let skip_duration = skip_seconds.unwrap_or(0.0);
        if skip_duration > 0.0 {
            let skipped_source = source.skip_duration(Duration::from_secs_f64(skip_duration));
            sink.append(skipped_source);
        } else {
            sink.append(source);
        }

        sink.play();

        *self.sink.lock().unwrap() = Some(sink);
        *self._stream.lock().unwrap() = Some(stream);
        *self.start_time.lock().unwrap() = Some(Instant::now());
        *self.start_position.lock().unwrap() = skip_duration;
        *self.is_paused.lock().unwrap() = false;
        *self.paused_position.lock().unwrap() = 0.0;

        Ok(())
    }

    fn open_file_with_retry(&self, path: &str, max_retries: u32) -> Result<File, String> {
        let mut last_error = String::new();
        for i in 0..max_retries {
            match File::open(path) {
                Ok(file) => return Ok(file),
                Err(e) => {
                    last_error = e.to_string();
                    if i < max_retries - 1 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
        }
        Err(format!(
            "Failed to open file after {} retries: {}",
            max_retries, last_error
        ))
    }

    pub fn stop(&self) {
        if let Some(sink) = self.sink.lock().unwrap().take() {
            sink.stop();
        }
        *self._stream.lock().unwrap() = None;
        *self.current_path.lock().unwrap() = None;
        *self.current_duration.lock().unwrap() = None;
        *self.start_time.lock().unwrap() = None;
        *self.start_position.lock().unwrap() = 0.0;
        *self.is_paused.lock().unwrap() = false;
        *self.paused_position.lock().unwrap() = 0.0;
    }

    pub fn pause(&self) {
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink.pause();
            // 現在の位置を保存
            let current_pos = self.get_current_position();
            *self.paused_position.lock().unwrap() = current_pos;
            *self.is_paused.lock().unwrap() = true;
        }
    }

    pub fn resume(&self) {
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink.play();
            // 開始時刻を更新（一時停止からの再開）
            *self.start_time.lock().unwrap() = Some(Instant::now());
            *self.start_position.lock().unwrap() = *self.paused_position.lock().unwrap();
            *self.is_paused.lock().unwrap() = false;
        }
    }

    pub fn get_current_position(&self) -> f64 {
        let is_paused = *self.is_paused.lock().unwrap();
        if is_paused {
            return *self.paused_position.lock().unwrap();
        }

        if let Some(start) = *self.start_time.lock().unwrap() {
            let elapsed = start.elapsed().as_secs_f64();
            let start_pos = *self.start_position.lock().unwrap();
            return start_pos + elapsed;
        }
        0.0
    }

    pub fn get_current_path(&self) -> Option<String> {
        self.current_path.lock().unwrap().clone()
    }

    pub fn is_playing(&self) -> bool {
        let is_paused = *self.is_paused.lock().unwrap();
        if is_paused {
            return false;
        }
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            !sink.empty()
        } else {
            false
        }
    }

    pub fn is_paused(&self) -> bool {
        *self.is_paused.lock().unwrap()
    }

    pub fn set_volume(&self, volume: f32) {
        let clamped = volume.clamp(0.0, 1.0);
        *self.volume.lock().unwrap() = clamped;
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink.set_volume(clamped);
        }
    }

    pub fn get_volume(&self) -> f32 {
        *self.volume.lock().unwrap()
    }
}

fn get_audio_duration(path: &Path) -> Option<f64> {
    // symphoniaを使用して音声ファイルの長さを取得
    let file = File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // 拡張子からヒントを作成
    let mut hint = Hint::new();
    if let Some(extension) = path.extension() {
        if let Some(ext_str) = extension.to_str() {
            hint.with_extension(ext_str);
        }
    }

    // フォーマットをプローブ
    let format_opts = FormatOptions::default();
    let metadata_opts = MetadataOptions::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &format_opts, &metadata_opts)
        .ok()?;

    let format_reader = probed.format;

    // デフォルトトラックを取得
    let track = format_reader.default_track()?;

    // time_baseを使用してdurationを計算
    if let Some(n_frames) = track.codec_params.n_frames {
        if let Some(sample_rate) = track.codec_params.sample_rate {
            let duration_secs = n_frames as f64 / sample_rate as f64;
            return Some(duration_secs);
        }
    }

    None
}

#[tauri::command]
fn get_audio_files(directory: String) -> Result<DirectoryContents, String> {
    let path = Path::new(&directory);
    if !path.exists() || !path.is_dir() {
        return Err("Invalid directory".to_string());
    }

    let mut audio_files = Vec::new();
    let mut directories = Vec::new();
    // 注意: m4aファイルは一部のファイルで再生エラーが発生する可能性があります
    let audio_extensions = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];

    for entry in WalkDir::new(path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let entry_path = entry.path();

        // ルートディレクトリ自体はスキップ
        if entry_path == path {
            continue;
        }

        if entry_path.is_dir() {
            // サブディレクトリを追加
            directories.push(DirectoryItem {
                name: entry_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
                path: entry_path.to_string_lossy().to_string(),
            });
        } else if entry_path.is_file() {
            if let Some(ext) = entry_path.extension() {
                if audio_extensions.contains(&ext.to_str().unwrap_or("").to_lowercase().as_str()) {
                    // 音声ファイルの長さを取得
                    let duration_seconds = get_audio_duration(entry_path);

                    audio_files.push(AudioFile {
                        name: entry_path
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                            .to_string(),
                        path: entry_path.to_string_lossy().to_string(),
                        duration_seconds,
                    });
                }
            }
        }
    }

    // ディレクトリとファイルをそれぞれアルファベット順にソート
    directories.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    audio_files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(DirectoryContents {
        directories,
        files: audio_files,
    })
}

#[tauri::command]
fn play_audio(
    path: String,
    state: tauri::State<AudioPlayer>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 音声の長さを取得
    let duration = get_audio_duration(Path::new(&path));

    state.inner().play(&path, None)?;

    // 現在のパスと長さを保存
    *state.inner().current_path.lock().unwrap() = Some(path.clone());
    *state.inner().current_duration.lock().unwrap() = duration;

    // バックグラウンドスレッドで再生終了を監視
    let player = state.inner().clone();
    let app_handle = app.clone();
    let file_path = path.clone();

    thread::spawn(move || {
        // Sinkが存在し、再生が完了するまで待つ
        loop {
            thread::sleep(Duration::from_millis(100));

            let is_empty = {
                if let Some(sink) = player.sink.lock().unwrap().as_ref() {
                    sink.empty()
                } else {
                    true
                }
            };

            // Sinkが空になったら再生終了
            if is_empty {
                // current_pathと一致する場合のみイベントを送信
                let current = player.current_path.lock().unwrap().clone();

                if current.as_deref() == Some(&file_path) {
                    let _ = app_handle.emit("audio-finished", file_path.clone());
                    *player.current_path.lock().unwrap() = None;
                    *player.current_duration.lock().unwrap() = None;
                }
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn stop_audio(state: tauri::State<AudioPlayer>) -> Result<(), String> {
    state.inner().stop();
    Ok(())
}

#[tauri::command]
fn pause_audio(state: tauri::State<AudioPlayer>) -> Result<(), String> {
    state.inner().pause();
    Ok(())
}

#[tauri::command]
fn resume_audio(state: tauri::State<AudioPlayer>) -> Result<(), String> {
    state.inner().resume();
    Ok(())
}

#[tauri::command]
fn seek_audio(
    path: String,
    position: f64,
    state: tauri::State<AudioPlayer>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 音声の長さを取得
    let duration = get_audio_duration(Path::new(&path));

    // 指定位置から再生開始
    state.inner().play(&path, Some(position))?;

    // 現在のパスと長さを保存
    *state.inner().current_path.lock().unwrap() = Some(path.clone());
    *state.inner().current_duration.lock().unwrap() = duration;

    // バックグラウンドスレッドで再生終了を監視
    let player = state.inner().clone();
    let app_handle = app.clone();
    let file_path = path.clone();

    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(100));

        let is_empty = {
            if let Some(sink) = player.sink.lock().unwrap().as_ref() {
                sink.empty()
            } else {
                true
            }
        };

        if is_empty {
            let current = player.current_path.lock().unwrap().clone();

            if current.as_deref() == Some(&file_path) {
                let _ = app_handle.emit("audio-finished", file_path.clone());
                *player.current_path.lock().unwrap() = None;
                *player.current_duration.lock().unwrap() = None;
            }
            break;
        }
    });

    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct PlaybackStatus {
    position: f64,
    duration: Option<f64>,
    is_playing: bool,
    is_paused: bool,
    volume: f32,
}

#[tauri::command]
fn get_playback_status(state: tauri::State<AudioPlayer>) -> Result<PlaybackStatus, String> {
    let position = state.inner().get_current_position();
    let duration = state.inner().current_duration.lock().unwrap().clone();
    let is_playing = state.inner().is_playing();
    let is_paused = state.inner().is_paused();
    let volume = state.inner().get_volume();

    Ok(PlaybackStatus {
        position,
        duration,
        is_playing,
        is_paused,
        volume,
    })
}

#[tauri::command]
fn set_master_volume(volume: f32, state: tauri::State<AudioPlayer>) -> Result<(), String> {
    state.inner().set_volume(volume);
    Ok(())
}

#[tauri::command]
fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
    let old = PathBuf::from(&old_path);
    let parent = old.parent().ok_or("Invalid path")?;
    let new_path = parent.join(&new_name);

    std::fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
fn copy_files(files: Vec<String>, destination: String) -> Result<Vec<String>, String> {
    let dest_path = Path::new(&destination);
    if !dest_path.exists() {
        std::fs::create_dir_all(dest_path).map_err(|e| e.to_string())?;
    }

    let mut copied_files = Vec::new();
    for file_path in files {
        let src = Path::new(&file_path);
        let file_name = src.file_name().ok_or("Invalid file name")?;
        let dest = dest_path.join(file_name);

        std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
        copied_files.push(dest.to_string_lossy().to_string());
    }

    Ok(copied_files)
}

// お気に入りファイルのパスを取得
fn get_favorites_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // ディレクトリが存在しない場合は作成
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    Ok(app_data_dir.join("favorites.json"))
}

// 新しいお気に入りアイテムの構造体（タグ対応）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FavoriteItem {
    pub file_path: String,
    pub tags: Vec<String>,
    pub added_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MissingFavoriteAudit {
    pub root_path: String,
    pub root_exists: bool,
    pub missing_items: Vec<FavoriteItem>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PathReplacement {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UnresolvedPath {
    pub old_path: String,
    pub candidates: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MissingSearchResult {
    pub workspace_path: String,
    pub replacements: Vec<PathReplacement>,
    pub unresolved: Vec<UnresolvedPath>,
    pub suggested_root: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepairApplyResult {
    pub updated_count: usize,
    pub favorites: Vec<FavoriteItem>,
    pub playlists: PlaylistStore,
}

// 新しいお気に入り構造体
#[derive(Debug, Serialize, Deserialize, Clone)]
struct FavoritesV2 {
    version: u32,
    items: Vec<FavoriteItem>,
}

// 旧形式のお気に入り構造体（後方互換性用）
#[derive(Debug, Serialize, Deserialize, Clone)]
struct FavoritesV1 {
    files: Vec<String>,
}

impl FavoritesV2 {
    fn new() -> Self {
        Self {
            version: 2,
            items: Vec::new(),
        }
    }

    fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::new());
        }

        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;

        // まずV2形式として読み込みを試みる
        if let Ok(v2) = serde_json::from_str::<FavoritesV2>(&content) {
            if v2.version >= 2 {
                return Ok(v2);
            }
        }

        // V1形式として読み込み、V2に変換
        if let Ok(v1) = serde_json::from_str::<FavoritesV1>(&content) {
            let now = chrono_now();
            let items: Vec<FavoriteItem> = v1
                .files
                .into_iter()
                .map(|file_path| FavoriteItem {
                    file_path,
                    tags: Vec::new(),
                    added_at: now.clone(),
                })
                .collect();
            return Ok(FavoritesV2 { version: 2, items });
        }

        // どちらの形式でも読み込めない場合は新規作成
        Ok(Self::new())
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let mut file = File::create(path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// 現在時刻を取得（ISO 8601形式）
fn chrono_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // 簡易的なタイムスタンプ（Unix時間）
    format!("{}", now)
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistItem {
    pub file_path: String,
    pub duration_seconds: Option<f64>,
    pub added_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub items: Vec<PlaylistItem>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlaylistStore {
    pub version: u32,
    pub active_playlist_id: String,
    pub playlists: Vec<Playlist>,
}

impl PlaylistStore {
    fn new() -> Self {
        let id = format!("playlist-{}", timestamp_millis());
        Self {
            version: 1,
            active_playlist_id: id.clone(),
            playlists: vec![Playlist {
                id,
                name: "今回のセットリスト".to_string(),
                items: Vec::new(),
                created_at: chrono_now(),
            }],
        }
    }

    fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::new());
        }
        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let store: Self = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        if store.playlists.is_empty() {
            Ok(Self::new())
        } else {
            Ok(store)
        }
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())
    }
}

fn timestamp_millis() -> u128 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn get_playlists_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    Ok(app_data_dir.join("playlists.json"))
}

#[tauri::command]
fn get_playlists(app: AppHandle) -> Result<PlaylistStore, String> {
    let path = get_playlists_file_path(&app)?;
    let store = PlaylistStore::load(&path)?;
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn create_playlist(name: String, app: AppHandle) -> Result<PlaylistStore, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("プレイリスト名を入力してください".to_string());
    }
    let path = get_playlists_file_path(&app)?;
    let mut store = PlaylistStore::load(&path)?;
    let id = format!("playlist-{}", timestamp_millis());
    store.playlists.push(Playlist {
        id: id.clone(),
        name: trimmed.to_string(),
        items: Vec::new(),
        created_at: chrono_now(),
    });
    store.active_playlist_id = id;
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn rename_playlist(
    playlist_id: String,
    name: String,
    app: AppHandle,
) -> Result<PlaylistStore, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("セットリスト名を入力してください".to_string());
    }
    let path = get_playlists_file_path(&app)?;
    let mut store = PlaylistStore::load(&path)?;
    let playlist = store
        .playlists
        .iter_mut()
        .find(|playlist| playlist.id == playlist_id)
        .ok_or_else(|| "セットリストが見つかりません".to_string())?;
    playlist.name = trimmed.to_string();
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn delete_playlist(playlist_id: String, app: AppHandle) -> Result<PlaylistStore, String> {
    let path = get_playlists_file_path(&app)?;
    let mut store = PlaylistStore::load(&path)?;
    store
        .playlists
        .retain(|playlist| playlist.id != playlist_id);
    if store.playlists.is_empty() {
        store = PlaylistStore::new();
    } else if store.active_playlist_id == playlist_id {
        store.active_playlist_id = store.playlists[0].id.clone();
    }
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn set_active_playlist(playlist_id: String, app: AppHandle) -> Result<PlaylistStore, String> {
    let path = get_playlists_file_path(&app)?;
    let mut store = PlaylistStore::load(&path)?;
    if !store
        .playlists
        .iter()
        .any(|playlist| playlist.id == playlist_id)
    {
        return Err("プレイリストが見つかりません".to_string());
    }
    store.active_playlist_id = playlist_id;
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn add_playlist_item(
    playlist_id: String,
    file_path: String,
    duration_seconds: Option<f64>,
    app: AppHandle,
) -> Result<PlaylistStore, String> {
    let path = get_playlists_file_path(&app)?;
    let mut store = PlaylistStore::load(&path)?;
    let playlist = store
        .playlists
        .iter_mut()
        .find(|playlist| playlist.id == playlist_id)
        .ok_or_else(|| "プレイリストが見つかりません".to_string())?;
    if playlist
        .items
        .iter()
        .any(|item| item.file_path == file_path)
    {
        return Err("この曲はすでにプレイリストに入っています".to_string());
    }
    playlist.items.push(PlaylistItem {
        file_path,
        duration_seconds,
        added_at: chrono_now(),
    });
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn remove_playlist_item(
    playlist_id: String,
    file_path: String,
    app: AppHandle,
) -> Result<PlaylistStore, String> {
    let path = get_playlists_file_path(&app)?;
    let mut store = PlaylistStore::load(&path)?;
    let playlist = store
        .playlists
        .iter_mut()
        .find(|playlist| playlist.id == playlist_id)
        .ok_or_else(|| "プレイリストが見つかりません".to_string())?;
    playlist.items.retain(|item| item.file_path != file_path);
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn move_playlist_item(
    playlist_id: String,
    file_path: String,
    direction: i32,
    app: AppHandle,
) -> Result<PlaylistStore, String> {
    let path = get_playlists_file_path(&app)?;
    let mut store = PlaylistStore::load(&path)?;
    let playlist = store
        .playlists
        .iter_mut()
        .find(|playlist| playlist.id == playlist_id)
        .ok_or_else(|| "プレイリストが見つかりません".to_string())?;
    let index = playlist
        .items
        .iter()
        .position(|item| item.file_path == file_path)
        .ok_or_else(|| "曲が見つかりません".to_string())?;
    let target = if direction < 0 {
        index.saturating_sub(1)
    } else {
        (index + 1).min(playlist.items.len().saturating_sub(1))
    };
    if index != target {
        playlist.items.swap(index, target);
    }
    store.save(&path)?;
    Ok(store)
}

#[tauri::command]
fn get_favorites(app: AppHandle) -> Result<Vec<FavoriteItem>, String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let favorites = FavoritesV2::load(&favorites_path)?;
    Ok(favorites.items)
}

fn normalize_path_key(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn path_is_within(path: &str, root: &str) -> bool {
    let path = normalize_path_key(path);
    let root = normalize_path_key(root);
    path == root || path.starts_with(&(root + "\\"))
}

#[tauri::command]
fn audit_library_root(root_path: String, app: AppHandle) -> Result<MissingFavoriteAudit, String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let favorites = FavoritesV2::load(&favorites_path)?;
    let missing_items = favorites
        .items
        .into_iter()
        .filter(|item| path_is_within(&item.file_path, &root_path))
        .filter(|item| !Path::new(&item.file_path).is_file())
        .collect();

    Ok(MissingFavoriteAudit {
        root_exists: Path::new(&root_path).is_dir(),
        root_path,
        missing_items,
    })
}

fn matching_suffix_score(left: &Path, right: &Path) -> usize {
    let left_parts: Vec<String> = left
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    let right_parts: Vec<String> = right
        .components()
        .map(|part| part.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    left_parts
        .iter()
        .rev()
        .zip(right_parts.iter().rev())
        .take_while(|(left, right)| left == right)
        .count()
}

fn common_parent(paths: &[String]) -> Option<String> {
    let first = Path::new(paths.first()?).parent()?.to_path_buf();
    let mut common: Vec<_> = first
        .components()
        .map(|part| part.as_os_str().to_os_string())
        .collect();
    for path in paths.iter().skip(1) {
        let parent: Vec<_> = Path::new(path)
            .parent()?
            .components()
            .map(|part| part.as_os_str().to_os_string())
            .collect();
        let shared = common
            .iter()
            .zip(parent.iter())
            .take_while(|(left, right)| left.eq_ignore_ascii_case(right))
            .count();
        common.truncate(shared);
    }
    if common.is_empty() {
        return None;
    }
    let mut result = PathBuf::new();
    for part in common {
        result.push(part);
    }
    Some(result.to_string_lossy().to_string())
}

#[tauri::command]
fn search_missing_favorites(
    workspace_path: String,
    missing_paths: Vec<String>,
) -> Result<MissingSearchResult, String> {
    let workspace = Path::new(&workspace_path);
    if !workspace.is_dir() {
        return Err("検索先フォルダが存在しません".to_string());
    }

    let wanted_names: HashSet<String> = missing_paths
        .iter()
        .filter_map(|path| Path::new(path).file_name())
        .map(|name| name.to_string_lossy().to_lowercase())
        .collect();
    let mut candidates_by_name: HashMap<String, Vec<String>> = HashMap::new();
    for entry in WalkDir::new(workspace)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if wanted_names.contains(&name) {
            candidates_by_name
                .entry(name)
                .or_default()
                .push(entry.path().to_string_lossy().to_string());
        }
    }

    let mut replacements = Vec::new();
    let mut unresolved = Vec::new();
    for old_path in missing_paths {
        let name = Path::new(&old_path)
            .file_name()
            .map(|name| name.to_string_lossy().to_lowercase());
        let candidates = name
            .as_ref()
            .and_then(|name| candidates_by_name.get(name))
            .cloned()
            .unwrap_or_default();
        let selected = if candidates.len() == 1 {
            candidates.first().cloned()
        } else if candidates.len() > 1 {
            let mut scored: Vec<(usize, &String)> = candidates
                .iter()
                .map(|candidate| {
                    (
                        matching_suffix_score(Path::new(&old_path), Path::new(candidate)),
                        candidate,
                    )
                })
                .collect();
            scored.sort_by(|left, right| right.0.cmp(&left.0));
            if scored[0].0 > 1 && scored.get(1).map(|item| item.0) != Some(scored[0].0) {
                Some(scored[0].1.clone())
            } else {
                None
            }
        } else {
            None
        };

        if let Some(new_path) = selected {
            replacements.push(PathReplacement { old_path, new_path });
        } else {
            unresolved.push(UnresolvedPath {
                old_path,
                candidates,
            });
        }
    }

    let resolved_paths: Vec<String> = replacements
        .iter()
        .map(|replacement| replacement.new_path.clone())
        .collect();
    Ok(MissingSearchResult {
        workspace_path,
        suggested_root: common_parent(&resolved_paths),
        replacements,
        unresolved,
    })
}

#[tauri::command]
fn apply_path_replacements(
    replacements: Vec<PathReplacement>,
    app: AppHandle,
) -> Result<RepairApplyResult, String> {
    let replacement_map: HashMap<String, String> = replacements
        .into_iter()
        .map(|replacement| {
            (
                normalize_path_key(&replacement.old_path),
                replacement.new_path,
            )
        })
        .collect();
    if replacement_map
        .values()
        .any(|new_path| !Path::new(new_path).is_file())
    {
        return Err("置換先に存在しないファイルが含まれています".to_string());
    }

    let favorites_path = get_favorites_file_path(&app)?;
    let mut favorites = FavoritesV2::load(&favorites_path)?;
    let mut updated_count = 0;
    let mut merged_items: Vec<FavoriteItem> = Vec::new();
    let mut merged_indices: HashMap<String, usize> = HashMap::new();
    for mut item in favorites.items {
        if let Some(new_path) = replacement_map.get(&normalize_path_key(&item.file_path)) {
            item.file_path = new_path.clone();
            updated_count += 1;
        }
        let key = normalize_path_key(&item.file_path);
        if let Some(index) = merged_indices.get(&key).copied() {
            for tag in item.tags {
                if !merged_items[index].tags.contains(&tag) {
                    merged_items[index].tags.push(tag);
                }
            }
        } else {
            merged_indices.insert(key, merged_items.len());
            merged_items.push(item);
        }
    }
    favorites.items = merged_items;
    favorites.save(&favorites_path)?;

    let playlists_path = get_playlists_file_path(&app)?;
    let mut playlists = PlaylistStore::load(&playlists_path)?;
    for playlist in &mut playlists.playlists {
        for item in &mut playlist.items {
            if let Some(new_path) = replacement_map.get(&normalize_path_key(&item.file_path)) {
                item.file_path = new_path.clone();
            }
        }
        let mut seen = HashSet::new();
        playlist
            .items
            .retain(|item| seen.insert(normalize_path_key(&item.file_path)));
    }
    playlists.save(&playlists_path)?;

    Ok(RepairApplyResult {
        updated_count,
        favorites: favorites.items,
        playlists,
    })
}

#[tauri::command]
fn remove_missing_references(
    file_paths: Vec<String>,
    app: AppHandle,
) -> Result<RepairApplyResult, String> {
    let remove_keys: HashSet<String> = file_paths
        .iter()
        .map(|path| normalize_path_key(path))
        .collect();
    let favorites_path = get_favorites_file_path(&app)?;
    let mut favorites = FavoritesV2::load(&favorites_path)?;
    let before = favorites.items.len();
    favorites
        .items
        .retain(|item| !remove_keys.contains(&normalize_path_key(&item.file_path)));
    let updated_count = before - favorites.items.len();
    favorites.save(&favorites_path)?;

    let playlists_path = get_playlists_file_path(&app)?;
    let mut playlists = PlaylistStore::load(&playlists_path)?;
    for playlist in &mut playlists.playlists {
        playlist
            .items
            .retain(|item| !remove_keys.contains(&normalize_path_key(&item.file_path)));
    }
    playlists.save(&playlists_path)?;

    Ok(RepairApplyResult {
        updated_count,
        favorites: favorites.items,
        playlists,
    })
}

#[tauri::command]
fn write_json_export(path: String, contents: String) -> Result<(), String> {
    let export_path = Path::new(&path);
    if let Some(parent) = export_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(export_path, contents).map_err(|error| error.to_string())
}

#[tauri::command]
fn add_favorite(
    file_path: String,
    tags: Option<Vec<String>>,
    app: AppHandle,
) -> Result<(), String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let mut favorites = FavoritesV2::load(&favorites_path)?;

    // 既に存在するか確認
    if !favorites
        .items
        .iter()
        .any(|item| item.file_path == file_path)
    {
        favorites.items.push(FavoriteItem {
            file_path,
            tags: tags.unwrap_or_default(),
            added_at: chrono_now(),
        });
        favorites.save(&favorites_path)?;
    }

    Ok(())
}

#[tauri::command]
fn remove_favorite(file_path: String, app: AppHandle) -> Result<(), String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let mut favorites = FavoritesV2::load(&favorites_path)?;

    favorites.items.retain(|item| item.file_path != file_path);
    favorites.save(&favorites_path)?;

    Ok(())
}

#[tauri::command]
fn update_favorite_tags(
    file_path: String,
    tags: Vec<String>,
    app: AppHandle,
) -> Result<(), String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let mut favorites = FavoritesV2::load(&favorites_path)?;

    if let Some(item) = favorites
        .items
        .iter_mut()
        .find(|item| item.file_path == file_path)
    {
        item.tags = tags;
        favorites.save(&favorites_path)?;
    } else {
        return Err("Favorite not found".to_string());
    }

    Ok(())
}

#[tauri::command]
fn get_all_tags(app: AppHandle) -> Result<Vec<String>, String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let favorites = FavoritesV2::load(&favorites_path)?;

    let mut all_tags: Vec<String> = favorites
        .items
        .iter()
        .flat_map(|item| item.tags.clone())
        .collect();

    all_tags.sort();
    all_tags.dedup();

    Ok(all_tags)
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    let path_obj = Path::new(&path);

    // パスがファイルの場合は親ディレクトリを開いてファイルを選択
    // パスがディレクトリの場合はそのディレクトリを開く
    #[cfg(target_os = "windows")]
    {
        if path_obj.is_file() {
            // ファイルを選択状態で開く
            std::process::Command::new("explorer")
                .args(["/select,", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            // ディレクトリを開く
            std::process::Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let dir = if path_obj.is_file() {
            path_obj
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(path.clone())
        } else {
            path.clone()
        };
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AudioPlayer::new())
        .invoke_handler(tauri::generate_handler![
            get_audio_files,
            play_audio,
            stop_audio,
            pause_audio,
            resume_audio,
            seek_audio,
            get_playback_status,
            set_master_volume,
            rename_file,
            copy_files,
            get_favorites,
            audit_library_root,
            search_missing_favorites,
            apply_path_replacements,
            remove_missing_references,
            write_json_export,
            add_favorite,
            remove_favorite,
            update_favorite_tags,
            get_all_tags,
            get_playlists,
            create_playlist,
            rename_playlist,
            delete_playlist,
            set_active_playlist,
            add_playlist_item,
            remove_playlist_item,
            move_playlist_item,
            get_music_analysis_status,
            get_music_analysis,
            analyze_music_files,
            get_similar_tracks,
            open_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_workspace(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "sound-pad-{}-{}-{}",
            name,
            std::process::id(),
            timestamp_millis()
        ))
    }

    #[test]
    fn path_scope_requires_a_directory_boundary() {
        assert!(path_is_within(
            r"C:\project\BGM\song.mp3",
            r"C:\project\BGM"
        ));
        assert!(!path_is_within(
            r"C:\project\BGM-old\song.mp3",
            r"C:\project\BGM"
        ));
    }

    #[test]
    fn recursive_search_resolves_unique_names_and_keeps_ambiguous_names() {
        let workspace = test_workspace("search");
        let bgm = workspace.join("project").join("material").join("BGM");
        let other = workspace.join("archive");
        fs::create_dir_all(&bgm).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(bgm.join("unique.mp3"), b"sound").unwrap();
        fs::write(bgm.join("duplicate.mp3"), b"sound").unwrap();
        fs::write(other.join("duplicate.mp3"), b"sound").unwrap();

        let result = search_missing_favorites(
            workspace.to_string_lossy().to_string(),
            vec![
                r"C:\old\BGM\unique.mp3".to_string(),
                r"C:\old\duplicate.mp3".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(result.replacements.len(), 1);
        assert!(result.replacements[0].new_path.ends_with("unique.mp3"));
        assert_eq!(result.unresolved.len(), 1);
        assert_eq!(result.unresolved[0].candidates.len(), 2);

        fs::remove_dir_all(workspace).unwrap();
    }
}
