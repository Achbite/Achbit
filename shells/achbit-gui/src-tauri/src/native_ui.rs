use std::{fs, path::Path};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem as Item, Submenu};

pub fn configured_language(config: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let path = config.join("user/local/settings/user-settings.json");
    let settings: serde_json::Value = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(error) => return Err(error.into()),
    };
    Ok(if settings["workbench.language"] == "en-US" {
        "en-US"
    } else {
        "zh-CN"
    }
    .into())
}

type Labels = Vec<(tauri::menu::MenuItemKind<tauri::Wry>, &'static str)>;

struct NativeMenu {
    labels: Labels,
}

fn remember<T: tauri::menu::IsMenuItem<tauri::Wry>>(
    item: T,
    key: &'static str,
    labels: &mut Labels,
) -> T {
    labels.push((item.kind(), key));
    item
}

fn language_pack(language: &str) -> serde_json::Value {
    serde_json::from_str(if language == "en-US" {
        include_str!("../../../../config/i18n/en-US.json")
    } else {
        include_str!("../../../../config/i18n/zh-CN.json")
    })
    .expect("built-in language pack")
}

fn label(pack: &serde_json::Value, key: &str) -> String {
    pack["messages"][format!("native.menu.{key}")]
        .as_str()
        .expect("native menu label")
        .to_owned()
}

/// Create native actions once. Language changes update these same items.
pub fn install_menu(app: &tauri::AppHandle, language: &str) -> tauri::Result<()> {
    use tauri::Manager;
    let pack = language_pack(language);
    let label = |key: &str| label(&pack, key);
    let mut labels = Vec::new();
    let menu = Menu::new(app)?;
    #[cfg(target_os = "macos")]
    menu.append(&Submenu::with_items(
        app,
        "Achbit",
        true,
        &[
            &remember(
                Item::about(app, Some(&label("about")), None)?,
                "about",
                &mut labels,
            ),
            &Item::separator(app)?,
            &remember(
                Item::services(app, Some(&label("services")))?,
                "services",
                &mut labels,
            ),
            &Item::separator(app)?,
            &remember(Item::hide(app, Some(&label("hide")))?, "hide", &mut labels),
            &remember(
                Item::hide_others(app, Some(&label("hideOthers")))?,
                "hideOthers",
                &mut labels,
            ),
            &Item::separator(app)?,
            &remember(Item::quit(app, Some(&label("quit")))?, "quit", &mut labels),
        ],
    )?)?;
    menu.append(&remember(
        Submenu::with_items(
            app,
            label("file"),
            true,
            &[
                &remember(
                    Item::close_window(app, Some(&label("close")))?,
                    "close",
                    &mut labels,
                ),
                #[cfg(not(target_os = "macos"))]
                &remember(Item::quit(app, Some(&label("quit")))?, "quit", &mut labels),
            ],
        )?,
        "file",
        &mut labels,
    ))?;
    menu.append(&remember(
        Submenu::with_items(
            app,
            label("edit"),
            true,
            &[
                &remember(Item::undo(app, Some(&label("undo")))?, "undo", &mut labels),
                &remember(Item::redo(app, Some(&label("redo")))?, "redo", &mut labels),
                &Item::separator(app)?,
                &remember(Item::cut(app, Some(&label("cut")))?, "cut", &mut labels),
                &remember(Item::copy(app, Some(&label("copy")))?, "copy", &mut labels),
                &remember(
                    Item::paste(app, Some(&label("paste")))?,
                    "paste",
                    &mut labels,
                ),
                &remember(
                    Item::select_all(app, Some(&label("selectAll")))?,
                    "selectAll",
                    &mut labels,
                ),
            ],
        )?,
        "edit",
        &mut labels,
    ))?;
    menu.append(&remember(
        Submenu::with_items(
            app,
            label("view"),
            true,
            &[
                &remember(
                    MenuItem::with_id(
                        app,
                        "reload-interface",
                        label("reload"),
                        true,
                        Some("CmdOrCtrl+Shift+R"),
                    )?,
                    "reload",
                    &mut labels,
                ),
                #[cfg(target_os = "macos")]
                &remember(
                    Item::fullscreen(app, Some(&label("fullscreen")))?,
                    "fullscreen",
                    &mut labels,
                ),
            ],
        )?,
        "view",
        &mut labels,
    ))?;
    let window = remember(
        Submenu::with_items(
            app,
            label("window"),
            true,
            &[
                &remember(
                    Item::minimize(app, Some(&label("minimize")))?,
                    "minimize",
                    &mut labels,
                ),
                &remember(
                    Item::maximize(app, Some(&label("zoom")))?,
                    "zoom",
                    &mut labels,
                ),
                &remember(
                    Item::close_window(app, Some(&label("close")))?,
                    "close",
                    &mut labels,
                ),
            ],
        )?,
        "window",
        &mut labels,
    );
    let help = remember(
        Submenu::with_items(app, label("help"), true, &[])?,
        "help",
        &mut labels,
    );
    menu.append(&window)?;
    menu.append(&help)?;
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }
    app.manage(NativeMenu { labels });
    Ok(())
}

#[tauri::command]
pub async fn achbit_set_ui_language(app: tauri::AppHandle, language: String) -> Result<(), String> {
    use tauri::{menu::MenuItemKind, Manager};
    if !matches!(language.as_str(), "zh-CN" | "en-US") {
        return Err("Unsupported UI language".into());
    }
    let pack = language_pack(&language);
    for (item, key) in &app.state::<NativeMenu>().labels {
        let text = label(&pack, key);
        match item {
            MenuItemKind::MenuItem(item) => item.set_text(&text),
            MenuItemKind::Submenu(item) => item.set_text(&text),
            MenuItemKind::Predefined(item) => item.set_text(&text),
            _ => unreachable!("only native menu labels are registered"),
        }
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}
