use super::*;
use tempfile::TempDir;

struct Project {
    _temp: TempDir,
    root: PathBuf,
}
impl Project {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::create_dir(root.join("work")).unwrap();
        Self { _temp: temp, root }
    }
    fn put(&self, entry: &str, body: &str) -> PathBuf {
        let path = self.root.join(".agents/skills").join(entry);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }
    fn catalog(&self, settings: &Value) -> Vec<Value> {
        search_plugins(
            settings,
            &[self.root.join("work")],
            "fixture-skill",
            30,
            0,
            false,
        )
        .unwrap()["plugins"]
            .as_array()
            .unwrap()
            .clone()
    }
    fn resolve(&self, settings: &Value, uri: &str) -> Result<ResolvedPluginSelection, String> {
        resolve_plugin_selection(
            settings,
            &[self.root.join("work")],
            &mut vec![selection(uri)],
            false,
            &[],
        )
    }
}
fn selection(uri: &str) -> PluginSelectionInput {
    PluginSelectionInput {
        selection_id: "select:test".into(),
        label: "Select".into(),
        uri: uri.into(),
    }
}
const TEXT: &str = "---\nname: fixture-skill\ndescription: |\n  Line one\n  and line two.\n---\n\nUnmodified body.\n";
const PROJECT: &str = "plugin://fixture-skill@project";

#[test]
fn discovery_and_admission_share_complete_yaml_and_model_invocation_policy() {
    let p = Project::new();
    p.put("valid.md", TEXT);
    for (file, text) in [
        ("nested.md", "---\nextra:\n  name: nested-fixture-skill\n  description: not top level\n---\n"),
        ("body.md", "Body\nname: body-fixture-skill\ndescription: not metadata\n"),
        ("open.md", "---\nname: open-fixture-skill\ndescription: not closed\n"),
        ("manual.md", "---\nname: manual-fixture-skill\ndescription: user only\ndisable-model-invocation: true\n---\n"),
        ("uri.md", "---\nname: _fixture-skill\ndescription: invalid URI\n---\n"),
        ("malformed.md", "---\nname: broken-fixture-skill\ndescription: [\n---\n"),
        ("not-text.md", "---\nname: number-fixture-skill\ndescription: 42\n---\n"),
    ] { p.put(file, text); }
    assert_eq!(
        p.catalog(&json!({})),
        vec![
            json!({"uri":PROJECT,"displayName":"fixture-skill","shortDescription":"Line one and line two."})
        ]
    );
    assert_eq!(
        p.resolve(&json!({}), PROJECT).unwrap().plugins[0].capability_summary,
        TEXT
    );
    assert!(p
        .resolve(&json!({}), "plugin://manual-fixture-skill@project")
        .unwrap_err()
        .starts_with("plugin_selection_unavailable:"));
}

#[test]
fn localized_identity_survives_reordering_edits_and_an_ascii_lookalike() {
    let p = Project::new();
    let settings = json!({});
    let text = |name: &str, body: &str| {
        format!("---\nname: {name}\ndescription: fixture-skill\n---\n{body}\n")
    };
    let by_name = || {
        p.catalog(&settings)
            .into_iter()
            .map(|item| {
                (
                    item["displayName"].as_str().unwrap().to_owned(),
                    item["uri"].as_str().unwrap().to_owned(),
                )
            })
            .collect::<BTreeMap<_, _>>()
    };
    p.put("a.md", &text("构建", "first"));
    p.put("z.md", &text("发布", "second"));
    let original = by_name();
    p.put("a.md", &text("构建", "body only"));
    assert_eq!(by_name(), original);
    let uri = &original["构建"];
    let ascii = uri
        .strip_prefix("plugin://")
        .unwrap()
        .strip_suffix("@project")
        .unwrap()
        .to_ascii_lowercase();
    p.put("lookalike.md", &text(&ascii, "ASCII"));
    // Reverse enumeration of the declarations and change only the contents of their bodies.
    let release = p.put("a.md", &text("发布", "updated release"));
    let build = p.put("z.md", &text("构建", "updated build"));
    let found = by_name();
    assert_eq!(found.len(), 3);
    assert_eq!(found["构建"], *uri);
    assert_eq!(found["发布"], original["发布"]);
    assert_eq!(found[&ascii], format!("plugin://{ascii}@project"));
    for (name, path) in [
        ("构建", build),
        ("发布", release),
        (&ascii[..], p.root.join(".agents/skills/lookalike.md")),
    ] {
        let id = &found[name];
        assert!(achbit_kernel_abi::valid_plugin_uri(id));
        let matches =
            search_plugins(&settings, &[p.root.join("work")], name, 30, 0, false).unwrap();
        assert!(matches["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["displayName"] == name && item["uri"] == id.as_str()));
        let selected = p.resolve(&settings, id).unwrap();
        assert_eq!(
            selected.plugins[0].capability_summary,
            fs::read_to_string(&path).unwrap()
        );
        assert_eq!(selected.project_reads(), [SkillReadScope::Entry(path)]);
    }
    // A nearer declaration shadows the same localized name only, including a manual-only one.
    let near = p.root.join("work/.achbit/skills/build/SKILL.md");
    fs::create_dir_all(near.parent().unwrap()).unwrap();
    fs::write(&near, text("构建", "nearer")).unwrap();
    assert_eq!(
        p.resolve(&settings, uri).unwrap().plugins[0].file_entry(),
        Some(near.as_path())
    );
    fs::write(
        &near,
        text("构建", "manual").replacen(
            "description:",
            "disable-model-invocation: true\ndescription:",
            1,
        ),
    )
    .unwrap();
    assert!(!by_name().contains_key("构建"));
    assert!(p.resolve(&settings, uri).is_err());
    assert_eq!(by_name()["发布"], original["发布"]);
    // Explicit mounts enumerate SKILL.md; a file directly in the collection stays file-scoped.
    let collection = p.root.join(".agents/skills");
    let path = collection.join("SKILL.md");
    fs::rename(collection.join("a.md"), &path).unwrap();
    let mounted =
        json!({"skills.mounts": json!([{"id":"stable", "path":path, "enabled":true}]).to_string()});
    let entry = p
        .catalog(&mounted)
        .into_iter()
        .find(|p| p["displayName"] == "发布")
        .unwrap();
    assert_eq!(entry["uri"], "plugin://stable-skills-1@skill");
    assert!(p.resolve(&mounted, &original["发布"]).is_err());
    assert_eq!(
        p.resolve(&mounted, entry["uri"].as_str().unwrap())
            .unwrap()
            .project_reads(),
        [SkillReadScope::Entry(path)]
    );
}

#[test]
fn explicit_mount_owns_the_file_even_when_disabled_and_manual_mounts_need_a_user() {
    let p = Project::new();
    let entry = p.put("bundle/SKILL.md", TEXT);
    let settings = |enabled| json!({"skills.mounts": json!([{"id":"stable", "path":entry.parent().unwrap(), "enabled":enabled}]).to_string()});
    let uri = "plugin://stable-bundle-1@skill";
    assert_eq!(p.catalog(&settings(true))[0]["uri"], uri);
    assert_eq!(p.catalog(&settings(true)).len(), 1);
    assert!(p.resolve(&settings(true), PROJECT).is_err());
    assert!(p.resolve(&settings(true), uri).is_ok());
    assert!(p.catalog(&settings(false)).is_empty());
    assert!(p.resolve(&settings(false), PROJECT).is_err());
    p.put(
        "bundle/SKILL.md",
        &TEXT.replace(
            "name: fixture-skill",
            "name: fixture-skill\ndisable-model-invocation: true",
        ),
    );
    assert!(p.catalog(&settings(true)).is_empty());
    let manual = p.resolve(&settings(true), uri).unwrap(); // Explicit user selection remains usable.
    assert!(manual.check_model_activation(&[selection(uri)]).is_err());
    assert!(p.resolve(&settings(true), PROJECT).is_err());
}

#[test]
fn project_read_grants_match_the_selected_entry_kind_and_are_rechecked_on_use() {
    let p = Project::new();
    for (file, bundle) in [
        ("flat.md", false),
        ("SKILL.md", false),
        ("bundle/SKILL.md", true),
    ] {
        let path = p.put(file, TEXT);
        let selected = p.resolve(&json!({}), PROJECT).unwrap();
        assert!(selected.file_read_roots().is_empty());
        let scope = selected.project_reads();
        assert_eq!(scope.len(), 1);
        let grant = if bundle {
            path.parent().unwrap()
        } else {
            &path
        };
        assert_eq!(scope[0].current_path(), Some(grant));
        assert_eq!(
            scope[0],
            if bundle {
                SkillReadScope::Bundle(grant.to_path_buf())
            } else {
                SkillReadScope::Entry(grant.to_path_buf())
            }
        );
        fs::remove_file(&path).unwrap();
        if !bundle {
            fs::create_dir(&path).unwrap();
            assert_eq!(
                scope[0].current_path(),
                None,
                "replacing a file with a directory cannot widen a captured grant"
            );
            fs::remove_dir(&path).unwrap();
        }
    }
}

#[cfg(unix)]
#[test]
fn project_discovery_ignores_linked_collections_packages_and_entries() {
    use std::os::unix::fs::symlink;
    let p = Project::new();
    let real = p.put("good/SKILL.md", TEXT);
    let other = p.root.join("fixtures");
    fs::create_dir_all(other.join("skills/package")).unwrap();
    fs::write(
        other.join("skills/package/SKILL.md"),
        TEXT.replace("fixture-skill", "linked-fixture-skill"),
    )
    .unwrap();
    let collection = real.parent().unwrap().parent().unwrap();
    symlink(&other, p.root.join("work/.agents")).unwrap();
    fs::create_dir(p.root.join("work/.achbit")).unwrap();
    symlink(other.join("skills"), p.root.join("work/.achbit/skills")).unwrap();
    symlink(
        other.join("skills/package"),
        collection.join("linked-package"),
    )
    .unwrap();
    for rel in ["linked.md", "SKILL.md", "nested/SKILL.md"] {
        let path = collection.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        symlink(other.join("skills/package/SKILL.md"), path).unwrap();
    }
    assert_eq!(
        p.catalog(&json!({}))
            .iter()
            .map(|p| &p["uri"])
            .collect::<Vec<_>>(),
        [&json!(PROJECT)]
    );
    assert!(p
        .resolve(&json!({}), "plugin://linked-fixture-skill@project")
        .is_err());
    let scopes = p.resolve(&json!({}), PROJECT).unwrap().project_reads();
    fs::rename(real.parent().unwrap(), collection.join("former")).unwrap();
    symlink(other.join("skills/package"), collection.join("good")).unwrap();
    assert_eq!(scopes[0].current_path(), None);
}
