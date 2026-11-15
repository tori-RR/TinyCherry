fn main() {
    println!("cargo:rerun-if-env-changed=EVOSTACK_APP_VERSION");
    println!("cargo:rerun-if-env-changed=EVOSTACK_BUILD_REVISION");
    tauri_build::build()
}
