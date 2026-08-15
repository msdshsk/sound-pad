use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const LIBRARY_VERSION: u32 = 3;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LegacyBookmark {
    pub path: String,
    #[serde(default)]
    pub alias: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryRoot {
    pub id: String,
    pub root_path: String,
    #[serde(default)]
    pub alias: Option<String>,
    pub media_kind: String,
    #[serde(default = "default_true")]
    pub is_saved: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryFavorite {
    pub library_id: String,
    pub relative_path: String,
    pub tags: Vec<String>,
    pub added_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LibraryStore {
    pub version: u32,
    pub libraries: Vec<LibraryRoot>,
    pub favorites: Vec<LibraryFavorite>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FavoriteItem {
    pub file_path: String,
    pub tags: Vec<String>,
    pub added_at: String,
    #[serde(default)]
    pub library_id: Option<String>,
    #[serde(default)]
    pub media_kind: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct LibrarySnapshot {
    pub version: u32,
    pub libraries: Vec<LibraryRoot>,
    pub favorites: Vec<FavoriteItem>,
}

#[derive(Debug, Deserialize)]
struct FavoritesV2 {
    #[allow(dead_code)]
    version: u32,
    items: Vec<FavoriteItem>,
}

#[derive(Debug, Deserialize)]
struct FavoritesV1 {
    files: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    Ok(path)
}

pub fn library_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("library.json"))
}

fn legacy_favorites_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("favorites.json"))
}

pub fn normalize_path(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

pub fn path_is_within(path: &str, root: &str) -> bool {
    let path = normalize_path(path);
    let root = normalize_path(root);
    path == root || path.starts_with(&(root + "\\"))
}

fn folder_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string())
}

fn exact_folder_media_kind(path: &str) -> &'static str {
    match folder_name(path).to_uppercase().as_str() {
        "BGM" | "MUSIC" => "bgm",
        "SE" | "SFX" | "SOUND EFFECTS" => "sound_effect",
        _ => "unknown",
    }
}

pub fn infer_media_kind(path: &str) -> String {
    path.replace('/', "\\")
        .split('\\')
        .rev()
        .map(exact_folder_media_kind)
        .find(|kind| *kind != "unknown")
        .unwrap_or("unknown")
        .to_string()
}

fn make_library_id(root_path: &str, occupied: &HashSet<String>) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in normalize_path(root_path).as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let base = format!("library-{hash:016x}");
    if !occupied.contains(&base) {
        return base;
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base}-{suffix}");
        if !occupied.contains(&candidate) {
            return candidate;
        }
        suffix += 1;
    }
}

fn relative_path(file_path: &str, root_path: &str) -> Option<String> {
    if !path_is_within(file_path, root_path) {
        return None;
    }
    let root_len = root_path.trim_end_matches(['\\', '/']).len();
    Some(
        file_path[root_len..]
            .trim_start_matches(['\\', '/'])
            .replace('/', "\\"),
    )
}

fn resolved_path(library: &LibraryRoot, relative_path: &str) -> String {
    Path::new(&library.root_path)
        .join(relative_path)
        .to_string_lossy()
        .to_string()
}

impl LibraryStore {
    pub fn empty() -> Self {
        Self {
            version: LIBRARY_VERSION,
            libraries: Vec::new(),
            favorites: Vec::new(),
        }
    }

    pub fn load(app: &AppHandle) -> Result<Self, String> {
        let path = library_path(app)?;
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let store: Self = serde_json::from_str(&content).map_err(|error| error.to_string())?;
        if store.version != LIBRARY_VERSION {
            return Err(format!(
                "未対応のlibrary.jsonバージョンです: {}",
                store.version
            ));
        }
        store.validate()?;
        Ok(store)
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        self.validate()?;
        let content = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        fs::write(library_path(app)?, content).map_err(|error| error.to_string())
    }

    fn validate(&self) -> Result<(), String> {
        let ids: HashSet<&str> = self
            .libraries
            .iter()
            .map(|library| library.id.as_str())
            .collect();
        if ids.len() != self.libraries.len() {
            return Err("library.jsonに重複したライブラリIDがあります".to_string());
        }
        let roots: HashSet<String> = self
            .libraries
            .iter()
            .map(|library| normalize_path(&library.root_path))
            .collect();
        if roots.len() != self.libraries.len() {
            return Err("library.jsonに重複したライブラリパスがあります".to_string());
        }
        if self.libraries.iter().any(|library| {
            library.root_path.trim().is_empty()
                || !matches!(
                    library.media_kind.as_str(),
                    "bgm" | "sound_effect" | "unknown"
                )
        }) {
            return Err("library.jsonに不正なライブラリがあります".to_string());
        }
        if self
            .favorites
            .iter()
            .any(|favorite| !ids.contains(favorite.library_id.as_str()))
        {
            return Err("所属ライブラリが存在しないお気に入りがあります".to_string());
        }
        if self.favorites.iter().any(|favorite| {
            favorite.relative_path.trim().is_empty()
                || Path::new(&favorite.relative_path).is_absolute()
                || Path::new(&favorite.relative_path)
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
        }) {
            return Err("library.jsonに不正な相対パスがあります".to_string());
        }
        let favorite_keys: HashSet<(String, String)> = self
            .favorites
            .iter()
            .map(|favorite| {
                (
                    favorite.library_id.clone(),
                    normalize_path(&favorite.relative_path),
                )
            })
            .collect();
        if favorite_keys.len() != self.favorites.len() {
            return Err("library.jsonに重複したお気に入りがあります".to_string());
        }
        Ok(())
    }

    pub fn snapshot(&self) -> LibrarySnapshot {
        let by_id: HashMap<&str, &LibraryRoot> = self
            .libraries
            .iter()
            .map(|library| (library.id.as_str(), library))
            .collect();
        let favorites = self
            .favorites
            .iter()
            .filter_map(|favorite| {
                let library = by_id.get(favorite.library_id.as_str())?;
                Some(FavoriteItem {
                    file_path: resolved_path(library, &favorite.relative_path),
                    tags: favorite.tags.clone(),
                    added_at: favorite.added_at.clone(),
                    library_id: Some(library.id.clone()),
                    media_kind: Some(library.media_kind.clone()),
                })
            })
            .collect();
        LibrarySnapshot {
            version: self.version,
            libraries: self.libraries.clone(),
            favorites,
        }
    }

    pub fn containing_library(&self, file_path: &str) -> Option<&LibraryRoot> {
        self.libraries
            .iter()
            .filter(|library| path_is_within(file_path, &library.root_path))
            .max_by_key(|library| normalize_path(&library.root_path).len())
    }

    fn ensure_library(
        &mut self,
        root_path: String,
        alias: Option<String>,
        is_saved: bool,
    ) -> String {
        if let Some(library) = self
            .libraries
            .iter_mut()
            .find(|library| normalize_path(&library.root_path) == normalize_path(&root_path))
        {
            if alias.is_some() {
                library.alias = alias;
            }
            if is_saved {
                library.is_saved = true;
            }
            return library.id.clone();
        }
        let occupied: HashSet<String> = self
            .libraries
            .iter()
            .map(|library| library.id.clone())
            .collect();
        let id = make_library_id(&root_path, &occupied);
        self.libraries.push(LibraryRoot {
            id: id.clone(),
            media_kind: infer_media_kind(&root_path),
            root_path,
            alias,
            is_saved,
            created_at: timestamp(),
        });
        id
    }

    pub fn add_or_save_library(&mut self, root_path: String, alias: Option<String>) {
        let paths_before_change: Vec<String> = self
            .snapshot()
            .favorites
            .into_iter()
            .map(|favorite| favorite.file_path)
            .collect();
        self.ensure_library(root_path, alias, true);
        for (index, file_path) in paths_before_change.into_iter().enumerate() {
            let Some(library) = self.containing_library(&file_path) else {
                continue;
            };
            let library_id = library.id.clone();
            let root_path = library.root_path.clone();
            let Some(relative_path) = relative_path(&file_path, &root_path) else {
                continue;
            };
            self.favorites[index].library_id = library_id;
            self.favorites[index].relative_path = relative_path;
        }
        self.deduplicate();
    }

    pub fn set_library_saved(&mut self, root_path: &str, is_saved: bool) -> Result<(), String> {
        let index = self
            .libraries
            .iter()
            .position(|library| normalize_path(&library.root_path) == normalize_path(root_path))
            .ok_or_else(|| "ライブラリが見つかりません".to_string())?;
        self.libraries[index].is_saved = is_saved;
        let id = self.libraries[index].id.clone();
        if !is_saved
            && !self
                .favorites
                .iter()
                .any(|favorite| favorite.library_id == id)
        {
            self.libraries.remove(index);
        }
        Ok(())
    }

    pub fn update_alias(&mut self, root_path: &str, alias: Option<String>) -> Result<(), String> {
        let library = self
            .libraries
            .iter_mut()
            .find(|library| normalize_path(&library.root_path) == normalize_path(root_path))
            .ok_or_else(|| "ライブラリが見つかりません".to_string())?;
        library.alias = alias;
        Ok(())
    }

    pub fn update_media_kind(&mut self, root_path: &str, media_kind: String) -> Result<(), String> {
        if !matches!(media_kind.as_str(), "bgm" | "sound_effect" | "unknown") {
            return Err("不正なライブラリ種別です".to_string());
        }
        let library = self
            .libraries
            .iter_mut()
            .find(|library| normalize_path(&library.root_path) == normalize_path(root_path))
            .ok_or_else(|| "ライブラリが見つかりません".to_string())?;
        library.media_kind = media_kind;
        Ok(())
    }

    pub fn replace_root(&mut self, old_path: &str, new_path: String) -> Result<(), String> {
        if self.libraries.iter().any(|library| {
            normalize_path(&library.root_path) == normalize_path(&new_path)
                && normalize_path(&library.root_path) != normalize_path(old_path)
        }) {
            return Err("移動先はすでに別のライブラリとして登録されています".to_string());
        }
        let library = self
            .libraries
            .iter_mut()
            .find(|library| normalize_path(&library.root_path) == normalize_path(old_path))
            .ok_or_else(|| "ライブラリが見つかりません".to_string())?;
        library.root_path = new_path;
        Ok(())
    }

    fn add_favorite_with_timestamp(
        &mut self,
        file_path: String,
        tags: Vec<String>,
        added_at: String,
    ) -> Result<(), String> {
        if let Some(index) =
            self.snapshot().favorites.iter().position(|favorite| {
                normalize_path(&favorite.file_path) == normalize_path(&file_path)
            })
        {
            for tag in tags {
                if !self.favorites[index].tags.contains(&tag) {
                    self.favorites[index].tags.push(tag);
                }
            }
            return Ok(());
        }
        let library_id = if let Some(library) = self.containing_library(&file_path) {
            library.id.clone()
        } else {
            let parent = Path::new(&file_path)
                .parent()
                .ok_or_else(|| "お気に入りの親フォルダを取得できません".to_string())?
                .to_path_buf();
            let inferred_root = parent
                .ancestors()
                .find(|ancestor| exact_folder_media_kind(&ancestor.to_string_lossy()) != "unknown")
                .unwrap_or(parent.as_path())
                .to_string_lossy()
                .to_string();
            self.ensure_library(inferred_root, None, true)
        };
        let library = self
            .libraries
            .iter()
            .find(|library| library.id == library_id)
            .ok_or_else(|| "所属ライブラリを作成できませんでした".to_string())?;
        let relative_path = relative_path(&file_path, &library.root_path)
            .ok_or_else(|| "お気に入りをライブラリ相対パスへ変換できません".to_string())?;
        self.favorites.push(LibraryFavorite {
            library_id,
            relative_path,
            tags,
            added_at,
        });
        Ok(())
    }

    pub fn add_favorite(&mut self, file_path: String, tags: Vec<String>) -> Result<(), String> {
        self.add_favorite_with_timestamp(file_path, tags, timestamp())
    }

    pub fn remove_favorites(&mut self, file_paths: &HashSet<String>) -> usize {
        let libraries: HashMap<String, LibraryRoot> = self
            .libraries
            .iter()
            .cloned()
            .map(|library| (library.id.clone(), library))
            .collect();
        let before = self.favorites.len();
        self.favorites.retain(|favorite| {
            let Some(library) = libraries.get(&favorite.library_id) else {
                return false;
            };
            !file_paths.contains(&normalize_path(&resolved_path(
                library,
                &favorite.relative_path,
            )))
        });
        before - self.favorites.len()
    }

    pub fn update_tags(&mut self, file_path: &str, tags: Vec<String>) -> Result<(), String> {
        let libraries: HashMap<String, LibraryRoot> = self
            .libraries
            .iter()
            .cloned()
            .map(|library| (library.id.clone(), library))
            .collect();
        let favorite = self
            .favorites
            .iter_mut()
            .find(|favorite| {
                libraries
                    .get(&favorite.library_id)
                    .map(|library| {
                        normalize_path(&resolved_path(library, &favorite.relative_path))
                            == normalize_path(file_path)
                    })
                    .unwrap_or(false)
            })
            .ok_or_else(|| "お気に入りが見つかりません".to_string())?;
        favorite.tags = tags;
        Ok(())
    }

    pub fn replace_favorite_paths(&mut self, replacements: &HashMap<String, String>) -> usize {
        let snapshot = self.snapshot();
        let original_libraries: HashMap<String, LibraryRoot> = self
            .libraries
            .iter()
            .cloned()
            .map(|library| (library.id.clone(), library))
            .collect();
        let mut updated = 0;
        for item in snapshot.favorites {
            let Some(new_path) = replacements.get(&normalize_path(&item.file_path)) else {
                continue;
            };
            let Some((new_library_id, new_root)) = self
                .containing_library(new_path)
                .map(|library| (library.id.clone(), library.root_path.clone()))
            else {
                continue;
            };
            let Some(relative) = relative_path(new_path, &new_root) else {
                continue;
            };
            let old_library_id = item.library_id.clone().unwrap_or_default();
            if let Some(favorite) = self.favorites.iter_mut().find(|favorite| {
                favorite.library_id == old_library_id
                    && original_libraries
                        .get(&favorite.library_id)
                        .map(|old_library| {
                            normalize_path(&resolved_path(old_library, &favorite.relative_path))
                                == normalize_path(&item.file_path)
                        })
                        .unwrap_or(false)
            }) {
                favorite.library_id = new_library_id;
                favorite.relative_path = relative;
                updated += 1;
            }
        }
        self.deduplicate();
        updated
    }

    fn deduplicate(&mut self) {
        let mut merged: Vec<LibraryFavorite> = Vec::new();
        let mut indices: HashMap<(String, String), usize> = HashMap::new();
        for favorite in self.favorites.drain(..) {
            let key = (
                favorite.library_id.clone(),
                normalize_path(&favorite.relative_path),
            );
            if let Some(index) = indices.get(&key).copied() {
                for tag in favorite.tags {
                    if !merged[index].tags.contains(&tag) {
                        merged[index].tags.push(tag);
                    }
                }
            } else {
                indices.insert(key, merged.len());
                merged.push(favorite);
            }
        }
        self.favorites = merged;
    }
}

fn read_legacy_favorites(path: &Path) -> Result<Vec<FavoriteItem>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if let Ok(v2) = serde_json::from_str::<FavoritesV2>(&content) {
        return Ok(v2.items);
    }
    if let Ok(v1) = serde_json::from_str::<FavoritesV1>(&content) {
        let added_at = timestamp();
        return Ok(v1
            .files
            .into_iter()
            .map(|file_path| FavoriteItem {
                file_path,
                tags: Vec::new(),
                added_at: added_at.clone(),
                library_id: None,
                media_kind: None,
            })
            .collect());
    }
    Err("旧favorites.jsonを読み込めません".to_string())
}

fn write_migration_backup(
    app: &AppHandle,
    legacy_path: &Path,
    bookmarks: &[LegacyBookmark],
) -> Result<(), String> {
    let backup_dir = app_data_dir(app)?
        .join("library-backups")
        .join(format!("migration-{}", timestamp()));
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    if legacy_path.exists() {
        fs::copy(legacy_path, backup_dir.join("favorites.v2.json"))
            .map_err(|error| error.to_string())?;
    }
    let bookmark_json =
        serde_json::to_string_pretty(bookmarks).map_err(|error| error.to_string())?;
    fs::write(
        backup_dir.join("folder-bookmarks.localstorage.json"),
        bookmark_json,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn initialize(app: &AppHandle, bookmarks: Vec<LegacyBookmark>) -> Result<LibraryStore, String> {
    let target = library_path(app)?;
    if target.exists() {
        return LibraryStore::load(app);
    }

    let legacy_path = legacy_favorites_path(app)?;
    let legacy_favorites = read_legacy_favorites(&legacy_path)?;
    write_migration_backup(app, &legacy_path, &bookmarks)?;

    let mut store = LibraryStore::empty();
    for bookmark in bookmarks {
        store.ensure_library(bookmark.path, bookmark.alias, true);
    }
    for item in legacy_favorites {
        store.add_favorite_with_timestamp(item.file_path, item.tags, item.added_at)?;
    }
    store.save(app)?;
    LibraryStore::load(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_uses_longest_library_root_and_relative_paths() {
        let mut store = LibraryStore::empty();
        store.ensure_library(r"C:\media".to_string(), None, true);
        let bgm_id = store.ensure_library(r"C:\media\BGM".to_string(), None, true);
        store
            .add_favorite(
                r"C:\media\BGM\song.mp3".to_string(),
                vec!["fast".to_string()],
            )
            .unwrap();

        assert_eq!(store.favorites[0].library_id, bgm_id);
        assert_eq!(store.favorites[0].relative_path, "song.mp3");
        assert_eq!(
            store.snapshot().favorites[0].media_kind.as_deref(),
            Some("bgm")
        );
    }

    #[test]
    fn unsaved_library_is_retained_while_it_owns_favorites() {
        let mut store = LibraryStore::empty();
        store.ensure_library(r"C:\media\SE".to_string(), None, true);
        store
            .add_favorite(r"C:\media\SE\hit.wav".to_string(), Vec::new())
            .unwrap();
        store.set_library_saved(r"C:\media\SE", false).unwrap();

        assert_eq!(store.libraries.len(), 1);
        assert!(!store.libraries[0].is_saved);
        assert_eq!(store.snapshot().favorites.len(), 1);
    }

    #[test]
    fn migration_infers_known_media_root_without_legacy_bookmark() {
        let mut store = LibraryStore::empty();
        store
            .add_favorite(
                r"F:\assets\SE\transitions\hit.wav".to_string(),
                vec!["高頻度SE".to_string()],
            )
            .unwrap();

        assert_eq!(store.libraries.len(), 1);
        assert_eq!(store.libraries[0].root_path, r"F:\assets\SE");
        assert_eq!(store.libraries[0].media_kind, "sound_effect");
        assert_eq!(store.favorites[0].relative_path, r"transitions\hit.wav");
    }

    #[test]
    fn validation_rejects_parent_traversal() {
        let mut store = LibraryStore::empty();
        let id = store.ensure_library(r"C:\media\BGM".to_string(), None, true);
        store.favorites.push(LibraryFavorite {
            library_id: id,
            relative_path: r"..\outside.mp3".to_string(),
            tags: Vec::new(),
            added_at: timestamp(),
        });

        assert!(store.validate().is_err());
    }

    #[test]
    fn duplicate_legacy_favorites_merge_tags() {
        let mut store = LibraryStore::empty();
        store.ensure_library(r"C:\media\BGM".to_string(), None, true);
        store
            .add_favorite_with_timestamp(
                r"C:\media\BGM\song.mp3".to_string(),
                vec!["fast".to_string()],
                "100".to_string(),
            )
            .unwrap();
        store
            .add_favorite_with_timestamp(
                r"c:\MEDIA\bgm\song.mp3".to_string(),
                vec!["bright".to_string()],
                "200".to_string(),
            )
            .unwrap();

        assert_eq!(store.favorites.len(), 1);
        assert_eq!(store.favorites[0].tags, vec!["fast", "bright"]);
        assert_eq!(store.favorites[0].added_at, "100");
    }

    #[test]
    fn adding_nested_library_rehomes_existing_favorites() {
        let mut store = LibraryStore::empty();
        store.add_or_save_library(r"C:\media".to_string(), None);
        store
            .add_favorite(r"C:\media\BGM\song.mp3".to_string(), Vec::new())
            .unwrap();

        store.add_or_save_library(r"C:\media\BGM".to_string(), None);

        assert_eq!(store.libraries.len(), 2);
        assert_eq!(
            store.snapshot().favorites[0].media_kind.as_deref(),
            Some("bgm")
        );
        assert_eq!(store.favorites[0].relative_path, "song.mp3");
    }
}
