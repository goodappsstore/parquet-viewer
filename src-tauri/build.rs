fn main() {
    tauri_build::build();

    // Declare env dependencies UNCONDITIONALLY so that switching between the
    // `scripts/with-duckdb.mjs` wrapper (DUCKDB_* set) and a bare `cargo` /
    // `npx tauri` invocation (DUCKDB_* unset) invalidates the cached
    // build-script output. (Emitting these only inside the static branch
    // means cargo never learns to rerun us when the env flips, leaving stale
    // link args in place and producing either `-lduckdb not found` or missing
    // `-lc++` / extension-archive errors.)
    println!("cargo:rerun-if-env-changed=DUCKDB_LIB_DIR");
    println!("cargo:rerun-if-env-changed=DUCKDB_STATIC");
    println!("cargo:rerun-if-env-changed=DUCKDB_TRIPLE");
    // `--features source-bundled` compiles DuckDB from source; never link
    // prebuilt archives there (Windows MSVC path).
    if std::env::var("CARGO_FEATURE_SOURCE_BUNDLED").is_ok() {
        return;
    }

    if let Ok(dir) = std::env::var("DUCKDB_LIB_DIR") {
        if is_static_link() {
            link_duckdb_static_bundle(&dir);
        }
        return;
    }

    // Fallback for bare `cargo ...` / `npx tauri ...` invocations that bypass
    // `scripts/with-duckdb.mjs`: auto-discover the staged
    // `libs/<target-triple>/` archives. This pairs with the generated
    // `.cargo/config.toml` (written at the repo root by
    // `scripts/fetch-duckdb.mjs`), which gives libduckdb-sys itself
    // `DUCKDB_LIB_DIR` + `DUCKDB_STATIC=1` so it requests
    // `static=duckdb_static` (instead of `dylib=duckdb`) and emits its own
    // search path; we supply the remaining extension archives and the
    // platform C++ runtime here.
    if is_static_link() {
        // Watch the candidate archive so staging it later triggers a rerun.
        if let Some(dir) = discover_staged_libs() {
            link_duckdb_static_bundle(&dir);
        } else {
            println!("cargo:warning=DuckDB prebuilt archives not found: run `node scripts/fetch-duckdb.mjs` (or build via `npm run tauri:build`) to stage src-tauri/libs/<triple>/");
        }
    }
}

fn is_static_link() -> bool {
    // Mirrors libduckdb-sys: any non-"0" value (wrapper env or generated
    // `.cargo/config.toml`) means static linking.
    std::env::var("DUCKDB_STATIC").is_ok_and(|v| v != "0")
}

/// Resolve `src-tauri/libs/<triple>/` holding `libduckdb_static.a`, where
/// `<triple>` is `$DUCKDB_TRIPLE` when set, else the cargo `$TARGET`.
/// Returns the directory as a string on success.
fn discover_staged_libs() -> Option<String> {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").ok()?;
    let target = std::env::var("TARGET").ok()?;
    let triple = std::env::var("DUCKDB_TRIPLE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or(target);
    println!("cargo:rerun-if-changed=libs/{triple}");
    let dir = std::path::Path::new(&manifest)
        .join("libs")
        .join(&triple);
    if dir.join("libduckdb_static.a").exists() {
        Some(dir.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Link every static archive in `dir`, with the main library and the
/// generated extension loader first (referencers before providers for
/// one-pass Unix linkers), then the platform system libraries.
/// Skipped entirely under `--features source-bundled` (see `main`).
fn link_duckdb_static_bundle(dir: &str) {
    println!("cargo:rerun-if-env-changed=DUCKDB_LIB_DIR");
    println!("cargo:rerun-if-env-changed=DUCKDB_STATIC");

    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("lib") && n.ends_with(".a"))
            .map(|n| n.trim_start_matches("lib").trim_end_matches(".a").to_string())
            .collect(),
        Err(_) => Vec::new(),
    };
    // Referencers first: the main archive calls into the generated loader,
    // which calls into the extension archives, which call into third-party.
    names.sort_by_key(|n| match n.as_str() {
        "duckdb_static" => 0,
        "duckdb_generated_extension_loader" => 1,
        _ => 2,
    });

    println!("cargo:rustc-link-search=native={dir}");
    for name in &names {
        println!("cargo:rustc-link-lib=static={name}");
    }

    // System libraries that `cc` would otherwise pull in for a bundled build.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    match target_os.as_str() {
        "macos" => println!("cargo:rustc-link-lib=c++"),
        "linux" => {
            println!("cargo:rustc-link-lib=stdc++");
            println!("cargo:rustc-link-lib=pthread");
            println!("cargo:rustc-link-lib=dl");
            println!("cargo:rustc-link-lib=m");
        }
        _ => {}
    }
}
