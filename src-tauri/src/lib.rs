use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Emitter;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AudioFile {
    name: String,
    path: String,
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
        self.stop();

        let file = File::open(path).map_err(|e| e.to_string())?;
        let source = Decoder::new(BufReader::new(file)).map_err(|e| e.to_string())?;

        let (stream, stream_handle) = OutputStream::try_default().map_err(|e| e.to_string())?;
        let sink = Sink::try_new(&stream_handle).map_err(|e| e.to_string())?;

        sink.append(source);
        sink.play();

        *self.sink.lock().unwrap() = Some(sink);
        *self._stream.lock().unwrap() = Some((stream, stream_handle));

        Ok(())
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

#[tauri::command]
fn get_audio_files(directory: String) -> Result<Vec<AudioFile>, String> {
    let path = Path::new(&directory);
    if !path.exists() || !path.is_dir() {
        return Err("Invalid directory".to_string());
    }

    let mut audio_files = Vec::new();
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
                    audio_files.push(AudioFile {
                        name: path
                            .file_name()
                            .unwrap()
                            .to_string_lossy()
                            .to_string(),
                        path: path.to_string_lossy().to_string(),
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
            copy_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
