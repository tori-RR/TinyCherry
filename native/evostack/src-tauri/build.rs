fn main() {
    println!("cargo:rerun-if-env-changed=EVOSTACK_APP_VERSION");
    println!("cargo:rerun-if-env-changed=EVOSTACK_BUILD_REVISION");
    let root = std::path::Path::new("../../..");
    println!("cargo:rerun-if-changed=../../../package.json");
    let product: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("package.json")).expect("product metadata"),
    )
    .expect("valid product metadata");
    let version = product["version"].as_str().expect("product version");
    if let Ok(supplied) = std::env::var("EVOSTACK_APP_VERSION") {
        assert_eq!(supplied, version, "product and build version differ");
    }
    println!("cargo:rustc-env=EVOSTACK_APP_VERSION={version}");
    let revision = std::env::var("EVOSTACK_BUILD_REVISION").unwrap_or_else(|_| {
        assert_eq!(
            std::env::var("PROFILE").as_deref(),
            Ok("debug"),
            "release build requires an explicit source revision; use pnpm build"
        );
        "development".to_string()
    });
    println!("cargo:rustc-env=EVOSTACK_BUILD_REVISION={revision}");
    tauri_build::build()
}
