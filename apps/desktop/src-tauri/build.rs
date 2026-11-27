fn main() {
    // default path of the GenCouncil CLI (this checkout), used for `service start|stop`;
    // GENCOUNCIL_CLI at run time overrides it
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let cli = manifest.join("../../../packages/cli/dist/cli.js");
    let cli = cli.canonicalize().unwrap_or(cli);
    let s = cli.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    println!("cargo:rustc-env=GENCOUNCIL_CLI_DEFAULT={s}");
    // app commands get ACL permissions (allow-<name>); capabilities/console.json grants them to
    // the localhost console pages, everything else stays closed to remote content
    let app = tauri_build::AppManifest::new().commands(&["desktop_mode", "float_restore", "float_drag", "float_hide", "float_menu"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app)).expect("tauri build")
}
