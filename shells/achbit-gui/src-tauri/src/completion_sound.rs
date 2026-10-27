use rodio::{Decoder, OutputStream, Sink, Source};
use serde::Serialize;
use std::io::{Cursor, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};

const DEFAULT_SOUND: &[u8] = include_bytes!("../sounds/completion.wav");
pub const MAX_SOUND_BYTES: usize = 8 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundInfo {
    path: String,
    custom: bool,
}

fn path() -> PathBuf {
    crate::runtime_locations()
        .user
        .config_dir
        .join("user/local/sounds/completion.wav")
}

fn read_sound(path: &Path) -> Result<Vec<u8>, String> {
    match std::fs::File::open(path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_SOUND_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            Ok(bytes)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(DEFAULT_SOUND.to_vec()),
        Err(error) => Err(error.to_string()),
    }
}

fn decode(bytes: Vec<u8>) -> Result<Decoder<Cursor<Vec<u8>>>, String> {
    if bytes.len() > MAX_SOUND_BYTES {
        return Err("completion_sound_too_large: maximum 8 MiB".into());
    }
    let sound = Decoder::new_wav(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    match sound.total_duration() {
        Some(duration) if !duration.is_zero() && duration.as_secs_f64() <= 30.0 => Ok(sound),
        _ => Err("completion_sound_duration: use a WAV between 0 and 30 seconds".into()),
    }
}

pub fn play() -> Result<(), String> {
    // Open and decode on every playback: replacing the file takes effect without a restart.
    let sound = decode(read_sound(&path())?)?;
    let (_stream, handle) = OutputStream::try_default().map_err(|error| error.to_string())?;
    let sink = Sink::try_new(&handle).map_err(|error| error.to_string())?;
    sink.append(sound);
    sink.sleep_until_end();
    Ok(())
}

#[tauri::command]
pub fn achbit_completion_sound() -> Result<SoundInfo, String> {
    let path = path();
    let custom = path.try_exists().map_err(|error| error.to_string())?;
    Ok(SoundInfo {
        path: path.to_string_lossy().into_owned(),
        custom,
    })
}

fn replace_sound(path: &Path, data: Option<Vec<u8>>) -> Result<(), String> {
    if let Some(data) = data {
        // Validate before replacing a working sound, then publish the complete file atomically.
        decode(data.clone())?;
        let parent = path.parent().ok_or("completion_sound_directory_missing")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
        file.write_all(&data).map_err(|error| error.to_string())?;
        file.persist(path).map_err(|error| error.to_string())?;
    } else {
        match std::fs::remove_file(path) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn achbit_set_completion_sound(data: Option<Vec<u8>>) -> Result<SoundInfo, String> {
    replace_sound(&path(), data)?;
    achbit_completion_sound()
}

#[tauri::command]
pub async fn achbit_preview_completion_sound() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(play)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_sound_hot_replacement_and_reset() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sounds/completion.wav");
        assert!(decode(read_sound(&path).unwrap()).is_ok());
        let mut custom = DEFAULT_SOUND.to_vec();
        // Change PCM samples without changing the valid WAV format.
        for byte in &mut custom[44..] {
            *byte = 0;
        }
        replace_sound(&path, Some(custom.clone())).unwrap();
        assert_eq!(read_sound(&path).unwrap(), custom);
        assert!(replace_sound(&path, Some(b"not a wave file".to_vec())).is_err());
        assert_eq!(
            read_sound(&path).unwrap(),
            custom,
            "invalid replacement must preserve the previous sound"
        );
        replace_sound(&path, None).unwrap();
        assert_eq!(read_sound(&path).unwrap(), DEFAULT_SOUND);
        std::fs::write(&path, b"broken external replacement").unwrap();
        assert!(
            decode(read_sound(&path).unwrap()).is_err(),
            "do not silently replace a broken custom file with the default"
        );
    }
}
