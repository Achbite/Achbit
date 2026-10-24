//! Physical read adapter for an explicitly selected local file. It does not
//! attach a workspace or add anything to the conversation/model context.

#[tauri::command]
pub async fn deepcode_read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        achbit_host_connection::selected_file::read(std::path::Path::new(&path))
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|error| format!("file_reader_failed: {error}"))?
}
