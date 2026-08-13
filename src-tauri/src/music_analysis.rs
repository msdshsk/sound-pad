use ort::{session::Session, value::Tensor};
use realfft::RealFftPlanner;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::f32::consts::PI;
use std::fs::{self, File};
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};

const CACHE_VERSION: u32 = 1;
const SAMPLE_RATE: u32 = 16_000;
const FRAME_SIZE: usize = 512;
const HOP_SIZE: usize = 256;
const MEL_BANDS: usize = 96;
const PATCH_FRAMES: usize = 128;
const PATCH_HOP: usize = 62;
const MIN_MUSIC_SECONDS: f64 = 30.0;
const EMBEDDING_MODEL: &str = "discogs-effnet-bsdynamic-1.onnx";
const MOOD_MODEL: &str = "mtg_jamendo_moodtheme-discogs-effnet-1.onnx";
const MODEL_BASE: &str = "https://essentia.upf.edu/models";

static ANALYSIS_RUNNING: AtomicBool = AtomicBool::new(false);

struct AnalysisRunGuard;

impl AnalysisRunGuard {
    fn acquire() -> Result<Self, String> {
        ANALYSIS_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "楽曲解析はすでに実行中です".to_string())
    }
}

impl Drop for AnalysisRunGuard {
    fn drop(&mut self) {
        ANALYSIS_RUNNING.store(false, Ordering::Release);
    }
}

const MOOD_LABELS: [&str; 56] = [
    "action",
    "adventure",
    "advertising",
    "background",
    "ballad",
    "calm",
    "children",
    "christmas",
    "commercial",
    "cool",
    "corporate",
    "dark",
    "deep",
    "documentary",
    "drama",
    "dramatic",
    "dream",
    "emotional",
    "energetic",
    "epic",
    "fast",
    "film",
    "fun",
    "funny",
    "game",
    "groovy",
    "happy",
    "heavy",
    "holiday",
    "hopeful",
    "inspiring",
    "love",
    "meditative",
    "melancholic",
    "melodic",
    "motivational",
    "movie",
    "nature",
    "party",
    "positive",
    "powerful",
    "relaxing",
    "retro",
    "romantic",
    "sad",
    "sexy",
    "slow",
    "soft",
    "soundscape",
    "space",
    "sport",
    "summer",
    "trailer",
    "travel",
    "upbeat",
    "uplifting",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MoodScore {
    pub label: String,
    pub score: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MusicAnalysis {
    pub file_path: String,
    pub file_size: u64,
    pub modified_ms: u64,
    pub duration_seconds: f64,
    pub bpm: Option<f32>,
    pub bpm_confidence: f32,
    pub embedding: Vec<f32>,
    pub moods: Vec<f32>,
    pub top_moods: Vec<MoodScore>,
    pub analyzed_at: String,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct AnalysisStore {
    version: u32,
    items: HashMap<String, MusicAnalysis>,
    #[serde(default)]
    skipped: HashMap<String, SkippedFile>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SkippedFile {
    file_size: u64,
    modified_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct AnalysisStatus {
    pub total: usize,
    pub analyzed: usize,
    pub pending: usize,
    pub skipped: usize,
    pub models_ready: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct AnalysisBatchResult {
    pub total: usize,
    pub analyzed: usize,
    pub skipped: usize,
    pub failed: Vec<AnalysisFailure>,
}

#[derive(Debug, Serialize, Clone)]
pub struct AnalysisFailure {
    pub file_path: String,
    pub error: String,
}

#[derive(Debug, Serialize, Clone)]
struct AnalysisProgress {
    current: usize,
    total: usize,
    file_path: String,
    phase: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimilarTrackRequest {
    pub seed_path: String,
    pub candidate_paths: Vec<String>,
    pub bpm_tolerance: Option<f32>,
    pub allow_half_double: bool,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
pub struct SimilarTrack {
    pub file_path: String,
    pub duration_seconds: f64,
    pub score: f32,
    pub embedding_score: f32,
    pub mood_score: f32,
    pub bpm: Option<f32>,
    pub bpm_delta: Option<f32>,
    pub bpm_compatible: bool,
    pub top_moods: Vec<MoodScore>,
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn analysis_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("music-analysis");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(analysis_dir(app)?.join("analysis.json"))
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = analysis_dir(app)?.join("models");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

impl AnalysisStore {
    fn load(app: &AppHandle) -> Result<Self, String> {
        let path = store_path(app)?;
        if !path.exists() {
            return Ok(Self {
                version: CACHE_VERSION,
                items: HashMap::new(),
                skipped: HashMap::new(),
            });
        }
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        let mut store: Self = serde_json::from_str(&content).map_err(|error| error.to_string())?;
        if store.version != CACHE_VERSION {
            store = Self {
                version: CACHE_VERSION,
                items: HashMap::new(),
                skipped: HashMap::new(),
            };
        }
        Ok(store)
    }

    fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = store_path(app)?;
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        fs::write(path, bytes).map_err(|error| error.to_string())
    }
}

fn file_signature(path: &Path) -> Result<(u64, u64), String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    let modified_ms = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok((metadata.len(), modified_ms))
}

fn is_current(item: &MusicAnalysis, path: &Path) -> bool {
    file_signature(path)
        .map(|(size, modified)| item.file_size == size && item.modified_ms == modified)
        .unwrap_or(false)
}

fn is_current_skip(item: &SkippedFile, path: &Path) -> bool {
    file_signature(path)
        .map(|(size, modified)| item.file_size == size && item.modified_ms == modified)
        .unwrap_or(false)
}

fn model_urls() -> [(&'static str, String); 2] {
    [
        (
            EMBEDDING_MODEL,
            format!("{MODEL_BASE}/feature-extractors/discogs-effnet/{EMBEDDING_MODEL}"),
        ),
        (
            MOOD_MODEL,
            format!("{MODEL_BASE}/classification-heads/mtg_jamendo_moodtheme/{MOOD_MODEL}"),
        ),
    ]
}

fn models_ready(app: &AppHandle) -> bool {
    models_dir(app)
        .map(|dir| model_urls().iter().all(|(name, _)| dir.join(name).exists()))
        .unwrap_or(false)
}

fn ensure_models(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = models_dir(app)?;
    for (name, url) in model_urls() {
        let target = dir.join(name);
        if target.exists() {
            continue;
        }
        let _ = app.emit(
            "music-analysis-progress",
            AnalysisProgress {
                current: 0,
                total: 0,
                file_path: String::new(),
                phase: format!("モデルを取得中: {name}"),
            },
        );
        let temporary = target.with_extension("download");
        let mut response = ureq::get(&url)
            .call()
            .map_err(|error| format!("モデルの取得に失敗しました: {error}"))?;
        let mut reader = response.body_mut().as_reader();
        let mut output = File::create(&temporary).map_err(|error| error.to_string())?;
        std::io::copy(&mut reader, &mut output).map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        fs::rename(&temporary, &target).map_err(|error| error.to_string())?;
    }
    Ok((dir.join(EMBEDDING_MODEL), dir.join(MOOD_MODEL)))
}

fn decode_audio(path: &Path) -> Result<(Vec<f32>, u32), String> {
    use rodio::Source;

    let file = File::open(path).map_err(|error| error.to_string())?;
    let decoder = rodio::Decoder::new(BufReader::new(file)).map_err(|error| error.to_string())?;
    let channels = decoder.channels() as usize;
    let sample_rate = decoder.sample_rate();
    let interleaved: Vec<f32> = decoder.collect();
    if channels <= 1 {
        return Ok((interleaved, sample_rate));
    }
    let mono = interleaved
        .chunks(channels)
        .map(|frame| frame.iter().copied().sum::<f32>() / frame.len() as f32)
        .collect();
    Ok((mono, sample_rate))
}

fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if source_rate == target_rate || input.is_empty() {
        return input.to_vec();
    }
    let output_len = ((input.len() as u64 * target_rate as u64) / source_rate as u64) as usize;
    let ratio = source_rate as f64 / target_rate as f64;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * ratio;
            let left = position.floor() as usize;
            let fraction = (position - left as f64) as f32;
            let right = (left + 1).min(input.len() - 1);
            input[left] * (1.0 - fraction) + input[right] * fraction
        })
        .collect()
}

fn hz_to_mel(hz: f32) -> f32 {
    const F_SP: f32 = 200.0 / 3.0;
    const MIN_LOG_HZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = MIN_LOG_HZ / F_SP;
    const LOG_STEP: f32 = 0.068_751_78;
    if hz >= MIN_LOG_HZ {
        MIN_LOG_MEL + (hz / MIN_LOG_HZ).ln() / LOG_STEP
    } else {
        hz / F_SP
    }
}

fn mel_to_hz(mel: f32) -> f32 {
    const F_SP: f32 = 200.0 / 3.0;
    const MIN_LOG_HZ: f32 = 1000.0;
    const MIN_LOG_MEL: f32 = MIN_LOG_HZ / F_SP;
    const LOG_STEP: f32 = 0.068_751_78;
    if mel >= MIN_LOG_MEL {
        MIN_LOG_HZ * (LOG_STEP * (mel - MIN_LOG_MEL)).exp()
    } else {
        mel * F_SP
    }
}

fn mel_filter_bank() -> Vec<Vec<f32>> {
    let min_mel = hz_to_mel(0.0);
    let max_mel = hz_to_mel(SAMPLE_RATE as f32 / 2.0);
    let edges: Vec<f32> = (0..MEL_BANDS + 2)
        .map(|index| {
            let mel = min_mel + (max_mel - min_mel) * index as f32 / (MEL_BANDS + 1) as f32;
            mel_to_hz(mel)
        })
        .collect();
    let frequencies: Vec<f32> = (0..=FRAME_SIZE / 2)
        .map(|bin| bin as f32 * SAMPLE_RATE as f32 / FRAME_SIZE as f32)
        .collect();
    (0..MEL_BANDS)
        .map(|band| {
            let lower = edges[band];
            let center = edges[band + 1];
            let upper = edges[band + 2];
            let normalization = 2.0 / (upper - lower).max(f32::EPSILON);
            frequencies
                .iter()
                .map(|frequency| {
                    let rising = (*frequency - lower) / (center - lower).max(f32::EPSILON);
                    let falling = (upper - *frequency) / (upper - center).max(f32::EPSILON);
                    rising.min(falling).max(0.0) * normalization
                })
                .collect()
        })
        .collect()
}

fn mel_spectrogram(audio: &[f32]) -> Result<Vec<[f32; MEL_BANDS]>, String> {
    if audio.len() < FRAME_SIZE {
        return Err("音声が短すぎます".to_string());
    }
    let filters = mel_filter_bank();
    let mut planner = RealFftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME_SIZE);
    let mut input = fft.make_input_vec();
    let mut spectrum = fft.make_output_vec();
    let mut result = Vec::with_capacity((audio.len() - FRAME_SIZE) / HOP_SIZE + 1);
    for start in (0..=audio.len() - FRAME_SIZE).step_by(HOP_SIZE) {
        for index in 0..FRAME_SIZE {
            let window = 0.5 - 0.5 * (2.0 * PI * index as f32 / FRAME_SIZE as f32).cos();
            input[index] = audio[start + index] * window;
        }
        fft.process(&mut input, &mut spectrum)
            .map_err(|error| error.to_string())?;
        let magnitudes: Vec<f32> = spectrum.iter().map(|value| value.norm()).collect();
        let mut frame = [0.0; MEL_BANDS];
        for band in 0..MEL_BANDS {
            let energy = filters[band]
                .iter()
                .zip(magnitudes.iter())
                .map(|(weight, magnitude)| weight * magnitude)
                .sum::<f32>();
            frame[band] = (1.0 + 10_000.0 * energy).log10();
        }
        result.push(frame);
    }
    Ok(result)
}

fn make_patches(frames: &[[f32; MEL_BANDS]]) -> Result<(Vec<f32>, usize), String> {
    if frames.len() < PATCH_FRAMES {
        return Err("ムード解析には約2秒以上の音声が必要です".to_string());
    }
    let starts: Vec<usize> = (0..=frames.len() - PATCH_FRAMES)
        .step_by(PATCH_HOP)
        .collect();
    let mut values = Vec::with_capacity(starts.len() * PATCH_FRAMES * MEL_BANDS);
    for start in &starts {
        for frame in &frames[*start..*start + PATCH_FRAMES] {
            values.extend_from_slice(frame);
        }
    }
    Ok((values, starts.len()))
}

fn estimate_bpm(frames: &[[f32; MEL_BANDS]]) -> (Option<f32>, f32) {
    if frames.len() < 64 {
        return (None, 0.0);
    }
    let mut onset = Vec::with_capacity(frames.len());
    onset.push(0.0);
    for index in 1..frames.len() {
        let flux = frames[index]
            .iter()
            .zip(frames[index - 1].iter())
            .map(|(current, previous)| (current - previous).max(0.0))
            .sum::<f32>();
        onset.push(flux);
    }
    let mean = onset.iter().sum::<f32>() / onset.len() as f32;
    onset
        .iter_mut()
        .for_each(|value| *value = (*value - mean).max(0.0));
    let frames_per_second = SAMPLE_RATE as f32 / HOP_SIZE as f32;
    let min_lag = (frames_per_second * 60.0 / 200.0).floor() as usize;
    let max_lag = (frames_per_second * 60.0 / 60.0).ceil() as usize;
    let mut best_lag = 0;
    let mut best_score = 0.0;
    let mut total_score = 0.0;
    for lag in min_lag..=max_lag.min(onset.len() / 2) {
        let score = onset
            .iter()
            .skip(lag)
            .zip(onset.iter())
            .map(|(right, left)| right * left)
            .sum::<f32>();
        total_score += score;
        if score > best_score {
            best_score = score;
            best_lag = lag;
        }
    }
    if best_lag == 0 || best_score <= 0.0 {
        return (None, 0.0);
    }
    let mut bpm = 60.0 * frames_per_second / best_lag as f32;
    while bpm < 80.0 {
        bpm *= 2.0;
    }
    while bpm > 180.0 {
        bpm *= 0.5;
    }
    let confidence = (best_score / (total_score + f32::EPSILON) * 12.0).clamp(0.0, 1.0);
    (Some(bpm), confidence)
}

fn average_rows(values: &[f32], rows: usize, columns: usize) -> Vec<f32> {
    let mut result = vec![0.0; columns];
    for row in values.chunks(columns).take(rows) {
        for (index, value) in row.iter().enumerate() {
            result[index] += *value;
        }
    }
    if rows > 0 {
        result.iter_mut().for_each(|value| *value /= rows as f32);
    }
    result
}

fn top_moods(moods: &[f32]) -> Vec<MoodScore> {
    let mut scores: Vec<MoodScore> = MOOD_LABELS
        .iter()
        .zip(moods.iter())
        .map(|(label, score)| MoodScore {
            label: (*label).to_string(),
            score: *score,
        })
        .collect();
    scores.sort_by(|left, right| right.score.total_cmp(&left.score));
    scores.truncate(3);
    scores
}

fn analyze_one(
    path: &Path,
    embedding_session: &mut Session,
    mood_session: &mut Session,
) -> Result<MusicAnalysis, String> {
    let (decoded, source_rate) = decode_audio(path)?;
    let duration_seconds = decoded.len() as f64 / source_rate as f64;
    if duration_seconds < MIN_MUSIC_SECONDS {
        return Err("30秒未満の音声はBGM候補解析の対象外です".to_string());
    }
    let audio = resample_linear(&decoded, source_rate, SAMPLE_RATE);
    let frames = mel_spectrogram(&audio)?;
    let (bpm, bpm_confidence) = estimate_bpm(&frames);
    let (patch_values, patch_count) = make_patches(&frames)?;
    let tensor = Tensor::<f32>::from_array(([patch_count, PATCH_FRAMES, MEL_BANDS], patch_values))
        .map_err(|error| error.to_string())?;
    let outputs = embedding_session
        .run(ort::inputs![tensor])
        .map_err(|error| error.to_string())?;
    let embedding_array = outputs["embeddings"]
        .try_extract_array::<f32>()
        .map_err(|error| error.to_string())?;
    let embedding_frames: Vec<f32> = embedding_array.iter().copied().collect();
    let embedding = average_rows(&embedding_frames, patch_count, 1280);

    let mood_tensor = Tensor::<f32>::from_array(([patch_count, 1280], embedding_frames))
        .map_err(|error| error.to_string())?;
    let mood_outputs = mood_session
        .run(ort::inputs![mood_tensor])
        .map_err(|error| error.to_string())?;
    let mood_array = mood_outputs["activations"]
        .try_extract_array::<f32>()
        .map_err(|error| error.to_string())?;
    let mood_frames: Vec<f32> = mood_array.iter().copied().collect();
    let moods = average_rows(&mood_frames, patch_count, MOOD_LABELS.len());
    let (file_size, modified_ms) = file_signature(path)?;
    Ok(MusicAnalysis {
        file_path: path.to_string_lossy().to_string(),
        file_size,
        modified_ms,
        duration_seconds,
        bpm,
        bpm_confidence,
        embedding,
        top_moods: top_moods(&moods),
        moods,
        analyzed_at: format!("{}", modified_ms),
    })
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let dot = left.iter().zip(right).map(|(a, b)| a * b).sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    if left_norm <= f32::EPSILON || right_norm <= f32::EPSILON {
        0.0
    } else {
        (dot / (left_norm * right_norm)).clamp(-1.0, 1.0)
    }
}

fn compatible_bpm(seed: f32, candidate: f32, allow_half_double: bool) -> (f32, f32) {
    let multipliers: &[f32] = if allow_half_double {
        &[0.5, 1.0, 2.0]
    } else {
        &[1.0]
    };
    multipliers
        .iter()
        .map(|multiplier| {
            let adjusted = candidate * multiplier;
            let relative = (adjusted - seed).abs() / seed.max(1.0);
            (relative, adjusted - seed)
        })
        .min_by(|left, right| left.0.total_cmp(&right.0))
        .unwrap_or((1.0, candidate - seed))
}

#[tauri::command]
pub fn get_music_analysis_status(
    paths: Vec<String>,
    app: AppHandle,
) -> Result<AnalysisStatus, String> {
    let store = AnalysisStore::load(&app)?;
    let analyzed = paths
        .iter()
        .filter(|path| {
            store
                .items
                .get(&normalize_path(path))
                .map(|item| is_current(item, Path::new(path)))
                .unwrap_or(false)
        })
        .count();
    let skipped = paths
        .iter()
        .filter(|path| {
            store
                .skipped
                .get(&normalize_path(path))
                .map(|item| is_current_skip(item, Path::new(path)))
                .unwrap_or(false)
        })
        .count();
    Ok(AnalysisStatus {
        total: paths.len(),
        analyzed,
        pending: paths.len().saturating_sub(analyzed + skipped),
        skipped,
        models_ready: models_ready(&app),
    })
}

#[tauri::command]
pub fn get_music_analysis(path: String, app: AppHandle) -> Result<Option<MusicAnalysis>, String> {
    let store = AnalysisStore::load(&app)?;
    Ok(store
        .items
        .get(&normalize_path(&path))
        .filter(|item| is_current(item, Path::new(&path)))
        .cloned())
}

#[tauri::command]
pub async fn analyze_music_files(
    paths: Vec<String>,
    app: AppHandle,
) -> Result<AnalysisBatchResult, String> {
    let _run_guard = AnalysisRunGuard::acquire()?;
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut store = AnalysisStore::load(&worker_app)?;
        let pending: Vec<String> = paths
            .into_iter()
            .filter(|path| {
                let analyzed_current = store
                    .items
                    .get(&normalize_path(path))
                    .map(|item| is_current(item, Path::new(path)))
                    .unwrap_or(false);
                let skipped_current = store
                    .skipped
                    .get(&normalize_path(path))
                    .map(|item| is_current_skip(item, Path::new(path)))
                    .unwrap_or(false);
                !analyzed_current && !skipped_current
            })
            .collect();
        if pending.is_empty() {
            return Ok(AnalysisBatchResult {
                total: 0,
                analyzed: 0,
                skipped: 0,
                failed: Vec::new(),
            });
        }
        let (embedding_model, mood_model) = ensure_models(&worker_app)?;
        let mut embedding_session = Session::builder()
            .map_err(|error| error.to_string())?
            .commit_from_file(embedding_model)
            .map_err(|error| error.to_string())?;
        let mut mood_session = Session::builder()
            .map_err(|error| error.to_string())?
            .commit_from_file(mood_model)
            .map_err(|error| error.to_string())?;
        let total = pending.len();
        let mut analyzed = 0;
        let mut skipped = 0;
        let mut failed = Vec::new();
        for (index, file_path) in pending.into_iter().enumerate() {
            let _ = worker_app.emit(
                "music-analysis-progress",
                AnalysisProgress {
                    current: index + 1,
                    total,
                    file_path: file_path.clone(),
                    phase: "楽曲を解析中".to_string(),
                },
            );
            match analyze_one(
                Path::new(&file_path),
                &mut embedding_session,
                &mut mood_session,
            ) {
                Ok(item) => {
                    store.items.insert(normalize_path(&file_path), item);
                    analyzed += 1;
                    store.save(&worker_app)?;
                }
                Err(error) if error.contains("30秒未満") => {
                    if let Ok((file_size, modified_ms)) = file_signature(Path::new(&file_path)) {
                        store.skipped.insert(
                            normalize_path(&file_path),
                            SkippedFile {
                                file_size,
                                modified_ms,
                            },
                        );
                    }
                    skipped += 1;
                    store.save(&worker_app)?;
                }
                Err(error) => failed.push(AnalysisFailure { file_path, error }),
            }
        }
        Ok(AnalysisBatchResult {
            total,
            analyzed,
            skipped,
            failed,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn get_similar_tracks(
    request: SimilarTrackRequest,
    app: AppHandle,
) -> Result<Vec<SimilarTrack>, String> {
    let store = AnalysisStore::load(&app)?;
    let seed = match store.items.get(&normalize_path(&request.seed_path)) {
        Some(seed) if is_current(seed, Path::new(&request.seed_path)) => seed,
        _ => return Ok(Vec::new()),
    };
    let mut results = Vec::new();
    for candidate_path in request.candidate_paths {
        if normalize_path(&candidate_path) == normalize_path(&request.seed_path) {
            continue;
        }
        let candidate = match store.items.get(&normalize_path(&candidate_path)) {
            Some(candidate) if is_current(candidate, Path::new(&candidate_path)) => candidate,
            _ => continue,
        };
        let embedding_score = cosine_similarity(&seed.embedding, &candidate.embedding);
        let mood_score = cosine_similarity(&seed.moods, &candidate.moods);
        let (relative_bpm, bpm_delta) = match (seed.bpm, candidate.bpm) {
            (Some(seed_bpm), Some(candidate_bpm)) => {
                let (relative, delta) =
                    compatible_bpm(seed_bpm, candidate_bpm, request.allow_half_double);
                (Some(relative), Some(delta))
            }
            _ => (None, None),
        };
        let bpm_compatible = request
            .bpm_tolerance
            .map(|tolerance| {
                relative_bpm
                    .map(|value| value <= tolerance)
                    .unwrap_or(false)
            })
            .unwrap_or(true);
        if !bpm_compatible {
            continue;
        }
        results.push(SimilarTrack {
            file_path: candidate.file_path.clone(),
            duration_seconds: candidate.duration_seconds,
            score: ((embedding_score + mood_score) * 0.5).clamp(0.0, 1.0),
            embedding_score,
            mood_score,
            bpm: candidate.bpm,
            bpm_delta,
            bpm_compatible,
            top_moods: candidate.top_moods.clone(),
        });
    }
    results.sort_by(|left, right| right.score.total_cmp(&left.score));
    results.truncate(request.limit.unwrap_or(10).min(20));
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_time_can_match_double_time() {
        let (relative, delta) = compatible_bpm(140.0, 70.0, true);
        assert!(relative < 0.001);
        assert!(delta.abs() < 0.001);
    }

    #[test]
    fn cosine_similarity_handles_identical_vectors() {
        assert!((cosine_similarity(&[1.0, 2.0], &[1.0, 2.0]) - 1.0).abs() < 0.0001);
    }

    #[test]
    fn mel_bank_has_expected_dimensions() {
        let bank = mel_filter_bank();
        assert_eq!(bank.len(), MEL_BANDS);
        assert_eq!(bank[0].len(), FRAME_SIZE / 2 + 1);
    }

    #[test]
    #[ignore = "requires external ONNX models and an audio fixture"]
    fn model_pipeline_smoke_test() {
        let embedding_model = std::env::var("SOUND_PAD_TEST_EMBED_MODEL").unwrap();
        let mood_model = std::env::var("SOUND_PAD_TEST_MOOD_MODEL").unwrap();
        let audio = std::env::var("SOUND_PAD_TEST_AUDIO").unwrap();
        let mut embedding_session = Session::builder()
            .unwrap()
            .commit_from_file(embedding_model)
            .unwrap();
        let mut mood_session = Session::builder()
            .unwrap()
            .commit_from_file(mood_model)
            .unwrap();
        let result = analyze_one(Path::new(&audio), &mut embedding_session, &mut mood_session)
            .expect("music analysis should complete");
        assert_eq!(result.embedding.len(), 1280);
        assert_eq!(result.moods.len(), MOOD_LABELS.len());
        assert_eq!(result.top_moods.len(), 3);
        assert!(result.bpm.is_some());
    }
}
