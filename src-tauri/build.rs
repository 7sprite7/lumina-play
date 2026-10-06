fn main() {
    tauri_build::build();

    // Make libmpv-2.dll available at runtime. The crate links against the
    // import lib via the plugin's build.rs search path, but at launch time
    // Windows looks for the DLL on PATH / next to the exe. Copying it into
    // the target profile dir covers `cargo tauri dev` and `cargo tauri
    // build`; the Tauri bundler then packages it as a resource for the
    // installer (see `bundle.resources` in tauri.conf.json).
    //
    // This is a no-op on non-Windows targets.
    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;

        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
            .expect("CARGO_MANIFEST_DIR not set");
        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");

        let src = PathBuf::from(&manifest_dir)
            .join("binaries")
            .join("libmpv-2.dll");

        if !src.exists() {
            // Not fatal — a dev may be building before running the download
            // script. Warn and move on; the mpv plugin will fail at runtime
            // when the user actually hits play().
            println!(
                "cargo:warning=libmpv-2.dll not found at {} — run scripts/download-libmpv.ps1",
                src.display()
            );
            return;
        }

        // OUT_DIR looks like `<target>/<profile>/build/lumina-play-<hash>/out`
        // — ancestors().nth(3) gives us the profile dir.
        let profile_dir = PathBuf::from(&out_dir)
            .ancestors()
            .nth(3)
            .expect("OUT_DIR too shallow")
            .to_path_buf();
        let dest = profile_dir.join("libmpv-2.dll");

        // Only copy when the source is newer, or dest is missing. Avoids
        // rewriting the 115MB file every incremental compile.
        let need_copy = match (
            std::fs::metadata(&src).and_then(|m| m.modified()),
            std::fs::metadata(&dest).and_then(|m| m.modified()),
        ) {
            (Ok(s), Ok(d)) => s > d,
            _ => true,
        };
        if need_copy {
            if let Err(e) = std::fs::copy(&src, &dest) {
                println!("cargo:warning=failed to copy libmpv-2.dll: {e}");
            } else {
                println!("cargo:warning=libmpv-2.dll copied to {}", dest.display());
            }
        }
        println!("cargo:rerun-if-changed={}", src.display());
    }
}
