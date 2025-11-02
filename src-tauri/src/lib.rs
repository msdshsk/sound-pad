use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioFile {
    name: String,
    path: String,
    duration_seconds: Option<f64>,
}

#[derive(Clone)]
pub struct AudioPlayer {
    sink: Arc<Mutex<Option<Sink>>>,
    _stream: Arc<Mutex<Option<(OutputStream, OutputStreamHandle)>>>,
    current_path: Arc<Mutex<Option<String>>>,
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
        }
    }

    pub fn play(&self, path: &str) -> Result<(), String> {
        // 前の再生を停止
        self.stop();

        // リソースが完全に解放されるまで少し待つ
        std::thread::sleep(std::time::Duration::from_millis(50));

        // ファイルを開く（リトライ機能付き）
        let file = self.open_file_with_retry(path, 3)?;

        // BufReaderを使わず、直接Fileを渡す（FileはRead + Seekを実装している）
        let source = Decoder::new(file).map_err(|e| {
            eprintln!("デコーダーエラー ({}): {}", path, e);
            format!("デコーダーエラー: {}", e)
        })?;

        let (stream, stream_handle) = OutputStream::try_default().map_err(|e| e.to_string())?;
        let sink = Sink::try_new(&stream_handle).map_err(|e| e.to_string())?;

        sink.append(source);
        sink.play();

        *self.sink.lock().unwrap() = Some(sink);
        *self._stream.lock().unwrap() = Some((stream, stream_handle));

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
        Err(format!("Failed to open file after {} retries: {}", max_retries, last_error))
    }

    pub fn stop(&self) {
        if let Some(sink) = self.sink.lock().unwrap().take() {
            sink.stop();
        }
        *self._stream.lock().unwrap() = None;
        *self.current_path.lock().unwrap() = None;
    }

    pub fn get_current_path(&self) -> Option<String> {
        self.current_path.lock().unwrap().clone()
    }

    pub fn is_playing(&self) -> bool {
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            !sink.empty()
        } else {
            false
        }
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
fn get_audio_files(directory: String) -> Result<Vec<AudioFile>, String> {
    let path = Path::new(&directory);
    if !path.exists() || !path.is_dir() {
        return Err("Invalid directory".to_string());
    }

    let mut audio_files = Vec::new();
    // 注意: m4aファイルは一部のファイルで再生エラーが発生する可能性があります
    let audio_extensions = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];

    for entry in WalkDir::new(path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if audio_extensions.contains(&ext.to_str().unwrap_or("").to_lowercase().as_str()) {
                    // 音声ファイルの長さを取得
                    let duration_seconds = get_audio_duration(path);

                    audio_files.push(AudioFile {
                        name: path
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                            .to_string(),
                        path: path.to_string_lossy().to_string(),
                        duration_seconds,
                    });
                }
            }
        }
    }

    audio_files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(audio_files)
}

#[tauri::command]
fn play_audio(path: String, state: tauri::State<AudioPlayer>, app: tauri::AppHandle) -> Result<(), String> {
    state.inner().play(&path)?;

    // 現在のパスを保存
    *state.inner().current_path.lock().unwrap() = Some(path.clone());

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
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    // ディレクトリが存在しない場合は作成
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }

    Ok(app_data_dir.join("favorites.json"))
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Favorites {
    files: Vec<String>,
}

impl Favorites {
    fn new() -> Self {
        Self { files: Vec::new() }
    }

    fn load(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Ok(Self::new());
        }

        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    }

    fn save(&self, path: &Path) -> Result<(), String> {
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let mut file = File::create(path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn get_favorites(app: AppHandle) -> Result<Vec<String>, String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let favorites = Favorites::load(&favorites_path)?;
    Ok(favorites.files)
}

#[tauri::command]
fn add_favorite(file_path: String, app: AppHandle) -> Result<(), String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let mut favorites = Favorites::load(&favorites_path)?;

    if !favorites.files.contains(&file_path) {
        favorites.files.push(file_path);
        favorites.save(&favorites_path)?;
    }

    Ok(())
}

#[tauri::command]
fn remove_favorite(file_path: String, app: AppHandle) -> Result<(), String> {
    let favorites_path = get_favorites_file_path(&app)?;
    let mut favorites = Favorites::load(&favorites_path)?;

    favorites.files.retain(|f| f != &file_path);
    favorites.save(&favorites_path)?;

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
            rename_file,
            copy_files,
            get_favorites,
            add_favorite,
            remove_favorite
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
