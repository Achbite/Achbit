use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use tokio::sync::watch;

// Each subscription has one revision per target, irrespective of the number of
// writes between reads. No event paths or file contents are retained.
struct Changes {
    revisions: watch::Receiver<Result<Vec<u64>, String>>,
    seen: Vec<u64>,
}

impl Changes {
    fn new(count: usize) -> (watch::Sender<Result<Vec<u64>, String>>, Self) {
        let seen = vec![0; count];
        let (sender, revisions) = watch::channel(Ok(seen.clone()));
        (sender, Self { revisions, seen })
    }

    async fn next(&mut self) -> Option<Result<Vec<usize>, String>> {
        self.revisions.changed().await.ok()?;
        let revisions = self.revisions.borrow_and_update();
        Some(match &*revisions {
            Err(error) => Err(error.clone()),
            Ok(current) => {
                let changed = self
                    .seen
                    .iter()
                    .zip(current)
                    .enumerate()
                    .filter_map(|(i, (old, new))| (old != new).then_some(i))
                    .collect();
                self.seen.copy_from_slice(current);
                Ok(changed)
            }
        })
    }
}

fn handler(
    targets: Vec<(PathBuf, bool)>,
    sender: watch::Sender<Result<Vec<u64>, String>>,
) -> impl Fn(notify::Result<notify::Event>) {
    move |event| {
        sender.send_if_modified(|state| {
            let Ok(revisions) = state else { return false };
            let event = match event {
                Ok(event) if !event.need_rescan() && matches!(event.kind, EventKind::Access(_)) => {
                    return false
                }
                Ok(event) => event,
                Err(error) => {
                    *state = Err(error.to_string());
                    return true;
                }
            };
            let mut changed = false;
            for ((target, directory), revision) in targets.iter().zip(revisions) {
                if event.need_rescan()
                    || event.paths.iter().any(|path| {
                        path == target || (*directory && path.parent() == Some(target.as_path()))
                    })
                {
                    *revision = revision.wrapping_add(1);
                    changed = true;
                }
            }
            changed
        });
    }
}

/// Owns native registrations. Dropping the subscription releases every watch.
pub struct FileWatch {
    _watcher: RecommendedWatcher,
    changes: Changes,
}

impl FileWatch {
    /// Returns positions in the original subscription, including duplicate targets.
    pub async fn next(&mut self) -> Option<Result<Vec<usize>, String>> {
        self.changes.next().await
    }

    pub fn new(paths: &[PathBuf]) -> Result<Self, String> {
        let mut roots = HashSet::new();
        let mut targets = Vec::with_capacity(paths.len());
        for path in paths {
            let directory = path.is_dir();
            targets.push((path.clone(), directory));
            // Parent notifications also cover atomic file replacement and directory removal.
            if directory {
                roots.insert(path.clone());
            }
            if let Some(parent) = path.parent() {
                roots.insert(parent.to_path_buf());
            }
        }
        let (sender, changes) = Changes::new(targets.len());
        let mut watcher = notify::recommended_watcher(handler(targets, sender))
            .map_err(|error| error.to_string())?;
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
        let root = std::env::temp_dir().join(format!("achbit-watch-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let target = root.join("sample.txt");
        let mut watch = FileWatch::new(std::slice::from_ref(&root)).unwrap();
        for content in [Some("first"), Some("changed"), None, Some("recreated")] {
            if let Some(content) = content {
                std::fs::write(&target, content).unwrap();
            } else {
                std::fs::remove_file(&target).unwrap();
            }
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    if watch.next().await.unwrap().unwrap() == [0] {
                        break;
                    }
                }
            })
            .await
            .unwrap();
        }
        drop(watch);
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(&root).unwrap();
    }

    #[tokio::test]
    async fn slow_subscription_reports_only_affected_identities_and_preserves_errors() {
        let root = PathBuf::from("project");
        let first = root.join("first");
        let second = root.join("second");
        let ignored = root.join("elsewhere").join("nested");
        let targets = vec![
            (root, true),
            (first.clone(), false),
            (second.clone(), false),
            (first.clone(), false),
        ];
        let (send, mut changes) = Changes::new(targets.len());
        let callback = handler(targets, send);
        let changed = |path: &PathBuf| {
            callback(Ok(notify::Event::new(EventKind::Any).add_path(path.clone())));
        };
        for _ in 0..1000 {
            changed(&first);
            changed(&ignored);
        }
        changed(&second);
        assert_eq!(changes.next().await.unwrap().unwrap(), [0, 1, 2, 3]);
        changed(&ignored);
        changed(&second);
        assert_eq!(changes.next().await.unwrap().unwrap(), [0, 2]);
        callback(Ok(
            notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan)
        ));
        assert_eq!(changes.next().await.unwrap().unwrap(), [0, 1, 2, 3]);
        callback(Err(notify::Error::generic("watch backend stopped")));
        changed(&first);
        assert!(changes
            .next()
            .await
            .unwrap()
            .unwrap_err()
            .contains("watch backend stopped"));
    }
}
