use std::{
    fs,
    path::{Path, PathBuf},
};

fn main() {
    println!("cargo:rerun-if-env-changed=EVOSTACK_APP_VERSION");
    println!("cargo:rerun-if-env-changed=EVOSTACK_BUILD_REVISION");
    println!("cargo:rerun-if-changed=../../../package.json");
    let root = Path::new("../../..");
    let product: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("package.json")).expect("product metadata"),
    )
    .expect("valid product metadata");
    let version = product["version"].as_str().expect("product version");
    if let Ok(supplied) = std::env::var("EVOSTACK_APP_VERSION") {
        assert_eq!(supplied, version, "product and build version differ");
    }
    println!("cargo:rustc-env=EVOSTACK_APP_VERSION={version}");
    let release = std::env::var("PROFILE").as_deref() == Ok("release");
    let revision = std::env::var("EVOSTACK_BUILD_REVISION").unwrap_or_else(|_| {
        assert!(
            !release,
            "release build requires an explicit source revision; use pnpm build"
        );
        "development".into()
    });
    println!("cargo:rustc-env=EVOSTACK_BUILD_REVISION={revision}");
    embed_frontend(release);
    #[cfg(windows)]
    windows_resources(version);
}

fn embed_frontend(required: bool) {
    let directory = Path::new("../dist/frontend");
    println!("cargo:rerun-if-changed={}", directory.display());
    if required {
        assert!(
            directory.join("windows/evostack/index.html").is_file(),
            "build the React frontend first; use pnpm build"
        );
    }
    let mut paths = Vec::new();
    if directory.is_dir() {
        visit(directory, &mut paths);
    }
    paths.sort();
    let mut source = String::from("static EMBEDDED_ASSETS: &[Asset] = &[\n");
    for path in paths {
        let name = path
            .strip_prefix(directory)
            .unwrap()
            .to_str()
            .unwrap()
            .replace('\\', "/");
        let absolute = path.canonicalize().unwrap();
        source.push_str(&format!(
            "Asset {{ path: {:?}, content: include_bytes!({:?}) }},\n",
            name, absolute
        ));
        println!("cargo:rerun-if-changed={}", path.display());
    }
    source.push_str("];\n");
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("frontend_assets.rs");
    fs::write(output, source).expect("write embedded frontend index");
}

fn visit(directory: &Path, paths: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).expect("read frontend directory") {
        let entry = entry.expect("read frontend entry");
        let kind = entry.file_type().expect("frontend file type");
        assert!(
            !kind.is_symlink(),
            "frontend assets cannot be symbolic links"
        );
        if kind.is_dir() {
            visit(&entry.path(), paths);
        } else if kind.is_file() {
            paths.push(entry.path());
        }
    }
}

#[cfg(windows)]
fn windows_resources(version: &str) {
    println!("cargo:rerun-if-changed=../../../build/icon.ico");
    println!("cargo:rerun-if-changed=app.manifest");
    let parts: Vec<u64> = version
        .split('.')
        .map(|part| part.parse().expect("numeric product version"))
        .collect();
    assert_eq!(parts.len(), 3);
    assert!(parts.iter().all(|part| *part <= 65535));
    let encoded = (parts[0] << 48) | (parts[1] << 32) | (parts[2] << 16);
    winresource::WindowsResource::new()
        .set_icon("../../../build/icon.ico")
        .set_manifest_file("app.manifest")
        .set("ProductName", "TinyCherry")
        .set("FileDescription", "TinyCherry GPUI + Wry desktop")
        .set("ProductVersion", version)
        .set("FileVersion", version)
        .set("OriginalFilename", "TinyCherry.exe")
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, encoded)
        .set_version_info(winresource::VersionInfo::FILEVERSION, encoded)
        .compile()
        .expect("compile TinyCherry Windows resources");
}
