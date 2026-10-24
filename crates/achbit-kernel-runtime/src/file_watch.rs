use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

/// Owns native registrations. Dropping the subscription releases every watch.
pub struct FileWatch {
    _watcher: RecommendedWatcher,
    pub changes: UnboundedReceiver<Result<Vec<PathBuf>, String>>,
}

impl FileWatch {
    pub async fn next(&mut self) -> Option<Result<Vec<PathBuf>, String>> {
        self.changes.recv().await
    }

    pub fn new(paths: &[PathBuf]) -> Result<Self, String> {
        let (sender, changes) = unbounded_channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let change = match event {
                    Ok(event) if matches!(event.kind, EventKind::Access(_)) => return,
                    Ok(event) => Ok(event.paths),
                    Err(error) => Err(error.to_string()),
                };
                let _ = sender.send(change);
            })
            .map_err(|error| error.to_string())?;
        let mut roots = HashSet::new();
        for path in paths {
            // Parent notifications also cover atomic file replacement and directory removal.
            if path.is_dir() {
                roots.insert(path.clone());
            }
            if let Some(parent) = path.parent() {
                roots.insert(parent.to_path_buf());
            }
        }
        for root in roots {
            watcher
                .watch(&root, RecursiveMode::NonRecursive)
                .map_err(|error| error.to_string())?;
        }
        Ok(Self {
            _watcher: watcher,
            changes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn directory_watch_observes_create_modify_delete() {
        let root = std::env::temp_dir().join(format!("deepcode-watch-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let target = root.join("sample.txt");
        let mut watch = FileWatch::new(std::slice::from_ref(&root)).unwrap();
        for content in [Some("first"), Some("changed"), None] {
            if let Some(content) = content {
                std::fs::write(&target, content).unwrap();
            } else {
                std::fs::remove_file(&target).unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    if watch.next().await.unwrap().unwrap().contains(&target) {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        drop(watch);
        std::fs::remove_dir(&root).unwrap();
    }
}
