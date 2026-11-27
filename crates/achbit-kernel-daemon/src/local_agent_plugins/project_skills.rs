//! Read project guidance relative to a verified collection directory. Discovery never grants a mount.
use super::*;
use achbit_host_connection::plugin_artifact::skill_frontmatter;
use achbit_kernel_runtime::file_access::{process_visible_path, SkillReadScope};
use std::{ffi::OsString, io::Read};

pub(super) fn discover(roots: &[PathBuf], mounts: &MountClaims) -> Vec<PluginCatalogEntry> {
    let mut skills = BTreeMap::new();
    for collection in directories(roots) {
        let Ok(dir) = directory::open(&collection) else {
            continue;
        };
        let Ok(mut names) = directory::names(&dir, &collection) else {
            continue;
        };
        names.sort();
        for name in names {
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') || matches!(name, "node_modules" | "target") {
                continue;
            }
            let child = collection.join(name);
            // A directory may itself have a .md suffix. Only a child directory with its own
            // entry owns a bundle; SKILL.md directly in the shared collection is a single file.
            let bundle = directory::child(&dir, &child).ok();
            let (parent, path, scope) = match &bundle {
                Some(bundle) => (
                    bundle,
                    child.join("SKILL.md"),
                    SkillReadScope::Bundle(child),
                ),
                None if name.ends_with(".md") => {
                    (&dir, child.clone(), SkillReadScope::Entry(child))
                }
                _ => continue,
            };
            if path.to_str().is_none() || mounts.owns(&path) {
                continue;
            }
            let Ok(file) = directory::file(parent, &path) else {
                continue;
            };
            let Ok(text) = read_entry(file) else {
                continue;
            };
            let Ok(Some(meta)) = skill_frontmatter(&text) else {
                continue;
            };
            let (Some(name), Some(description)) = (meta.name, meta.description) else {
                continue;
            };
            let name = name.trim();
            let description = description.split_whitespace().collect::<Vec<_>>().join(" ");
            if name.is_empty() || name.chars().any(char::is_control) || description.is_empty() {
                continue;
            }
            let slug = project_skill_slug(name);
            if !slug.starts_with(|c: char| c.is_ascii_alphanumeric()) {
                continue;
            }
            if meta.manual_only {
                skills.remove(&slug); // A nearer manual declaration must not expose a shadowed definition.
                continue;
            }
            let Ok(source) = project_skill_source(&path, &slug, name, &description, text, scope)
            else {
                continue;
            };
            skills.insert(slug, PluginCatalogEntry::Loaded(source));
        }
    }
    skills.into_values().collect()
}

/// A project entry retains its read boundary when an explicit mount supplies the URI.
pub(super) fn mounted_scope(path: &Path) -> Option<SkillReadScope> {
    let collection = |dir: &Path| {
        PROJECT_SKILL_DIRECTORIES
            .iter()
            .any(|suffix| dir.ends_with(suffix))
    };
    let dir = path.parent()?;
    if collection(dir) {
        Some(SkillReadScope::Entry(path.to_owned()))
    } else if dir.parent().is_some_and(collection) {
        Some(SkillReadScope::Bundle(dir.to_owned()))
    } else {
        None
    }
}

pub(super) fn open_entry(path: &Path) -> std::io::Result<fs::File> {
    let dir = directory::open(path.parent().ok_or(std::io::ErrorKind::InvalidInput)?)?;
    directory::file(&dir, path)
}

pub(super) fn read_entry(file: fs::File) -> std::io::Result<String> {
    use std::io::{Error, ErrorKind};
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(ErrorKind::InvalidInput.into());
    }
    let oversized = || Error::new(ErrorKind::InvalidData, "Skill exceeds the size limit");
    if meta.len() > MAX_SKILL_BYTES {
        return Err(oversized());
    }
    let mut text = String::new();
    file.take(MAX_SKILL_BYTES + 1).read_to_string(&mut text)?;
    if text.len() > MAX_SKILL_BYTES as usize {
        return Err(oversized());
    }
    Ok(text)
}

fn directories(roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut high_to_low = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        // The workspace registry supplies canonical locations (Win32 spelling is also accepted).
        let Ok(canonical) = root.canonicalize() else {
            continue;
        };
        if !canonical.is_dir() || process_visible_path(root) != process_visible_path(&canonical) {
            continue;
        }
        for ancestor in canonical.ancestors() {
            for name in PROJECT_SKILL_DIRECTORIES.iter().rev() {
                let path = ancestor.join(name);
                if seen.insert(path.clone()) {
                    high_to_low.push(path);
                }
            }
        }
    }
    high_to_low.reverse();
    high_to_low
}

#[cfg(unix)]
mod directory {
    use super::*;
    use rustix::fs::{openat, Dir, Mode, OFlags, CWD};
    use std::{
        io,
        os::{fd::OwnedFd, unix::ffi::OsStringExt},
        path::Component,
    };
    type Directory = OwnedFd;
    const DIRECTORY: OFlags = OFlags::RDONLY
        .union(OFlags::DIRECTORY)
        .union(OFlags::NOFOLLOW)
        .union(OFlags::CLOEXEC);

    pub(super) fn open(path: &Path) -> io::Result<Directory> {
        let mut dir = openat(CWD, "/", DIRECTORY, Mode::empty())?;
        for part in path.components() {
            if let Component::Normal(part) = part {
                dir = openat(&dir, part, DIRECTORY, Mode::empty())?;
            }
        }
        Ok(dir)
    }
    pub(super) fn child(dir: &Directory, path: &Path) -> io::Result<Directory> {
        Ok(openat(
            dir,
            path.file_name().unwrap(),
            DIRECTORY,
            Mode::empty(),
        )?)
    }
    pub(super) fn names(dir: &Directory, _: &Path) -> io::Result<Vec<OsString>> {
        Ok(Dir::read_from(dir)?
            .filter_map(Result::ok)
            .map(|entry| OsString::from_vec(entry.file_name().to_bytes().to_vec()))
            .collect())
    }
    pub(super) fn file(dir: &Directory, path: &Path) -> io::Result<fs::File> {
        Ok(openat(
            dir,
            path.file_name().unwrap(),
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )?
        .into())
    }
}

#[cfg(windows)]
mod directory {
    use super::*;
    use std::{
        io,
        os::windows::fs::{MetadataExt, OpenOptionsExt},
    };
    // Keep ancestors open without delete sharing while resolving the next component.
    pub(super) struct Directory(Vec<fs::File>);
    fn checked(path: &Path, directory: bool) -> io::Result<fs::File> {
        const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const BACKUP_SEMANTICS: u32 = 0x0200_0000;
        const REPARSE_POINT: u32 = 0x400;
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(1 | 2)
            .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)
            .open(path)?;
        let meta = file.metadata()?;
        if meta.file_attributes() & REPARSE_POINT != 0
            || if directory {
                !meta.is_dir()
            } else {
                !meta.is_file()
            }
        {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(file)
    }
    pub(super) fn open(path: &Path) -> io::Result<Directory> {
        let mut handles = Vec::new();
        for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
            handles.push(checked(ancestor, true)?);
        }
        Ok(Directory(handles))
    }
    pub(super) fn child(_: &Directory, path: &Path) -> io::Result<Directory> {
        Ok(Directory(vec![checked(path, true)?]))
    }
    pub(super) fn names(dir: &Directory, path: &Path) -> io::Result<Vec<OsString>> {
        debug_assert!(!dir.0.is_empty());
        Ok(fs::read_dir(path)?
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .collect())
    }
    pub(super) fn file(_: &Directory, path: &Path) -> io::Result<fs::File> {
        checked(path, false)
    }
}
