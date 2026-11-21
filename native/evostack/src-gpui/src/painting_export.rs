//! Only registered painting images may be offered to the native Save dialog.
//! The renderer supplies an ID; the selected destination never crosses IPC.
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

const IMAGE_LIMIT: u64 = 20 * 1024 * 1024;
static NEXT_EXPORT: AtomicU64 = AtomicU64::new(1);

pub fn valid_input(input: &Value) -> bool {
    let Some(input) = input.as_object() else {
        return false;
    };
    let Some(id) = input.get("fileId").and_then(Value::as_str) else {
        return false;
    };
    input.len() == 1
        && id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

pub struct PreparedExport {
    pub name: String,
    bytes: Vec<u8>,
}

impl PreparedExport {
    pub fn from_registered(profile: &Path, value: &Value) -> Result<Self, String> {
        let unavailable = || "EVOSTACK_PAINTING_FILE_UNAVAILABLE".to_string();
        let source = Path::new(value["path"].as_str().ok_or_else(unavailable)?);
        let name = value["name"].as_str().ok_or_else(unavailable)?;
        let size = value["size"].as_u64().ok_or_else(unavailable)?;
        if !source.is_absolute()
            || size == 0
            || size > IMAGE_LIMIT
            || name.is_empty()
            || name.contains(['/', '\\', '\0', '\r', '\n'])
            || !matches!(
                value["mime"].as_str(),
                Some("image/png" | "image/jpeg" | "image/webp")
            )
        {
            return Err(unavailable());
        }
        let root = profile
            .join("paintings")
            .canonicalize()
            .map_err(|_| unavailable())?;
        let source = source.canonicalize().map_err(|_| unavailable())?;
        if source.parent() != Some(root.as_path()) {
            return Err(unavailable());
        }
        let file = File::open(source).map_err(|_| unavailable())?;
        let metadata = file.metadata().map_err(|_| unavailable())?;
        if !metadata.is_file() || metadata.len() != size {
            return Err(unavailable());
        }
        let mut bytes = Vec::with_capacity(size as usize);
        file.take(IMAGE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| unavailable())?;
        if bytes.len() as u64 != size {
            return Err(unavailable());
        }
        Ok(Self {
            name: name.to_string(),
            bytes,
        })
    }

    pub fn save(self, destination: &Path) -> Result<(), String> {
        if !destination.is_absolute() || destination.file_name().is_none() {
            return Err("EVOSTACK_INVALID_EXPORT_DESTINATION".into());
        }
        let parent = destination
            .parent()
            .ok_or("EVOSTACK_INVALID_EXPORT_DESTINATION")?;
        let temporary = parent.join(format!(
            ".tinycherry-export-{}-{}.tmp",
            std::process::id(),
            NEXT_EXPORT.fetch_add(1, Ordering::Relaxed)
        ));
        // Write beside the destination, then replace it only after all bytes are
        // durable. An I/O failure leaves an existing user's file intact.
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "EVOSTACK_PAINTING_EXPORT_FAILED")?;
        let result = output
            .write_all(&self.bytes)
            .and_then(|_| output.sync_all());
        drop(output);
        let result = result.and_then(|_| fs::rename(&temporary, destination));
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result.map_err(|_| "EVOSTACK_PAINTING_EXPORT_FAILED".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn renderer_can_only_supply_a_file_id() {
        assert!(valid_input(
            &json!({"fileId":"4c938635-6076-4caa-9c18-11613bf19d6b"})
        ));
        assert!(!valid_input(&json!({"fileId":"../../secret"})));
        assert!(!valid_input(
            &json!({"fileId":"4c938635-6076-4caa-9c18-11613bf19d6b", "path":"private"})
        ));
    }

    #[test]
    fn export_copies_registered_bytes_and_rejects_paths_outside_paintings() {
        let directory = std::env::temp_dir().join(format!(
            "tinycherry-export-test-{}-{}",
            std::process::id(),
            NEXT_EXPORT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(directory.join("paintings")).unwrap();
        let source = directory.join("paintings/image.png");
        fs::write(&source, b"synthetic-image").unwrap();
        let value = json!({"path":source,"name":"image.png","mime":"image/png","size":15});
        let prepared = PreparedExport::from_registered(&directory, &value).unwrap();
        assert_eq!(prepared.name, "image.png");
        let destination = directory.join("saved.png");
        fs::write(&destination, b"previous-file").unwrap();
        prepared.save(&destination).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"synthetic-image");
        let outside = json!({"path":destination,"name":"saved.png","mime":"image/png","size":15});
        assert!(PreparedExport::from_registered(&directory, &outside).is_err());
        let mut wrong_size = value.clone();
        wrong_size["size"] = json!(16);
        assert!(PreparedExport::from_registered(&directory, &wrong_size).is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
