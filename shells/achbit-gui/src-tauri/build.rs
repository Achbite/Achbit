fn main() {
    println!("cargo:rerun-if-changed=capabilities");
    tauri_build::try_build(
        tauri_build::Attributes::new().capabilities_path_pattern("./capabilities/*.json"),
    )
    .expect("failed to build Achbit Tauri shell");
}
