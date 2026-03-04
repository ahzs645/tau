# oxlint / tsgolint crash investigation (PR draft)

## Summary

`oxlint` can panic (and abort the process) when its output pipe is closed while it is writing final CLI output.
This is **not primarily a tsgolint semantic/type-check bug**. The immediate crash is an I/O error handling bug in `apps/oxlint/src/lint.rs`.

## Smoking gun evidence

### 1) Crash report signature (Cursor-owned node process)

- Crash file: `~/Library/Logs/DiagnosticReports/node-2026-03-05-110931.ips`
- Faulting thread: `tokio-runtime-worker`
- Key frames:
  - `core::result::unwrap_failed`
  - `oxlint::lint::print_and_flush_stdout`
  - `oxlint::lint::CliRunner::run`
- Process had `oxlint.darwin-arm64.node` loaded.

### 2) Deterministic local reproduction

Repro command (from `repos/oxc`):

```bash
python3 - <<'PY'
import subprocess
cmd=['../../node_modules/oxlint/bin/oxlint','--no-ignore','-D','no-debugger','apps/oxlint/fixtures/linter']
proc=subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
proc.stdout.close()  # simulate consumer disconnect
out, err = proc.communicate()
print('returncode:', proc.returncode)
print(err[-800:])
PY
```

Observed:

- `returncode: -6` (SIGABRT)
- Panic line:
  - `apps/oxlint/src/lint.rs:537:20`
  - `called Result::unwrap() on an Err value: Os { code: 32, kind: BrokenPipe, message: "Broken pipe" }`

Additional repro note:

- If both stdout and stderr are closed by the parent, process still aborts (`-6`) but panic output can be lost (matches the "empty panic log" symptom when the hook writes to broken stderr first).

### 3) Not a primary tsgolint logic panic

- The crash stack does not show a tsgolint rule/data panic site.
- Repro above uses a non-type-aware rule path (`-D no-debugger`) and still crashes.
- Type-aware workloads may increase frequency due longer-running async tasks and cancellation/stream teardown timing, but the panic root is output-stream handling.

### 4) Deeper trigger analysis: this crash was CLI path, not LSP request handling

From the symbolicated stack:

- `oxlint::run::lint_impl` (`run.rs:244`) -> `CliRunner::run` -> `print_and_flush_stdout`
- This path is only reached in non-LSP flow. In `run.rs`, when `--lsp` is active, execution goes to `run_lsp(...)` and returns early.

Implication:

- The crashing `node` process was a **one-shot CLI-style invocation** (or equivalent argument set), not the steady-state LSP request loop.
- The process lifetime in the crash report (`procLaunch` to crash in ~8s) also matches an ephemeral command.
- So the first trigger is: **caller disconnected/terminated while a CLI invocation was flushing final output**.

## Root cause

`print_and_flush_stdout` handles `BrokenPipe`/`Interrupted` for `write_all`, but **not for `flush`**:

```rust
pub fn print_and_flush_stdout(stdout: &mut dyn Write, message: &str) {
    stdout.write_all(message.as_bytes()).or_else(check_for_writer_error).unwrap();
    stdout.flush().unwrap();
}
```

When the consumer closes the pipe/channel, `flush()` can return `BrokenPipe`; `unwrap()` then panics and aborts.

## Why panic logs were sometimes empty

The custom panic hook currently does `eprintln!` before durable file write and then calls `default_hook`.
If stderr is unavailable, this can trigger nested panic behavior and lose the intended panic-file breadcrumb.

## Proposed fix set (maintainer-aligned)

### A) Fix stdout flush panic (minimal, targeted)

#### Diff signature

```diff
diff --git a/apps/oxlint/src/lint.rs b/apps/oxlint/src/lint.rs
@@ pub fn print_and_flush_stdout(stdout: &mut dyn Write, message: &str) {
-    stdout.write_all(message.as_bytes()).or_else(check_for_writer_error).unwrap();
-    stdout.flush().unwrap();
+    stdout.write_all(message.as_bytes()).or_else(check_for_writer_error).unwrap();
+    stdout.flush().or_else(check_for_writer_error).unwrap();
 }
```

Rationale:

- Preserves existing fail-fast behavior for real I/O errors.
- Explicitly treats `BrokenPipe` / `Interrupted` as non-fatal (same policy as diagnostics service).

### B) Make panic hook non-panicking and file-first

#### Diff signature

```diff
diff --git a/apps/oxlint/src/init.rs b/apps/oxlint/src/init.rs
@@ fn install_panic_hook() {
-            eprintln!("{report}");
-            let log_path = panic_log_path();
-            if let Ok(mut log_file) = OpenOptions::new().create(true).append(true).open(&log_path) {
+            let log_path = panic_log_path();
+            if let Ok(mut log_file) = OpenOptions::new().create(true).append(true).open(&log_path) {
                 let _ = log_file.write_all(report.as_bytes());
                 let _ = log_file.flush();
             }
+            let _ = std::io::stderr().write_all(report.as_bytes());
+            let _ = std::io::stderr().flush();
-
-            default_hook(panic_info);
+            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| default_hook(panic_info)));
         }));
```

Rationale:

- Guarantees best-effort panic persistence to file first.
- Avoids recursive panics from stderr/default hook path when streams are already closed.

### C) Regression coverage

#### Diff signature

```diff
diff --git a/apps/oxlint/src/lint.rs b/apps/oxlint/src/lint.rs
@@ #[cfg(test)]
+#[test]
+fn print_and_flush_stdout_ignores_broken_pipe_on_flush() {
+    // custom writer that returns BrokenPipe on flush
+    // assert no panic
+}
```

Optional integration test:

```diff
diff --git a/apps/oxlint/test/fixtures/... b/apps/oxlint/test/fixtures/...
```

Use child-process harness that closes stdout early and asserts non-abort exit semantics.

### D) Add opt-in runtime invocation logging (for next crash cycle)

#### Diff signature

```diff
diff --git a/apps/oxlint/src/run.rs b/apps/oxlint/src/run.rs
@@
+const OXLINT_RUNTIME_DEBUG_ENV: &str = "OXLINT_RUNTIME_DEBUG";
+fn runtime_debug_log(...) { ... }
@@ async fn lint_impl(...) -> CliRunResult {
+    runtime_debug_log("lint_impl_enter", ...);
+    runtime_debug_log("lint_impl_parsed_command", ...);
+    if command.lsp {
+        runtime_debug_log("lint_impl_enter_lsp", ...);
+        ...
+        runtime_debug_log("lint_impl_exit_lsp", ...);
+    } else {
+        runtime_debug_log("lint_impl_enter_cli_runner", ...);
+        ...
+        runtime_debug_log("lint_impl_exit_cli_runner", ...);
+    }
 }
```

Behavior:

- If `OXLINT_RUNTIME_DEBUG` is unset: no overhead / no runtime log file writes.
- If `OXLINT_RUNTIME_DEBUG=1` (or `true` / empty): write to default temp file (`$TMPDIR/oxlint-runtime.log`).
- If `OXLINT_RUNTIME_DEBUG=/path/to/file.log`: append runtime entries there.

Current local sample confirms:

- invocation args are captured
- mode is captured (`cli` vs `lsp`)
- selected env breadcrumbs are captured (`VSCODE_PID`, IPC hook, etc.)
- final `CliRunResult` is captured

## Local implementation status

- `apps/oxlint/src/lint.rs`: patched `flush()` path (`or_else(check_for_writer_error)`).
- `apps/oxlint/src/lint.rs`: added test `print_and_flush_stdout_ignores_broken_pipe_on_flush`.
- `apps/oxlint/src/init.rs`: panic hook changed to file-first best-effort writes + non-panicking default hook call.
- `apps/oxlint/src/run.rs`: added opt-in runtime invocation logging.
- Rebuilt `oxlint` NAPI binding and deployed patched `.node` to local `node_modules` binding path with ad-hoc codesign.
- Added workspace wrapper `.vscode/oxlint-debug-wrapper.mjs` and pointed `oxc.path.oxlint` to it.
- Wrapper ensures default log targets for IDE sessions:
  - runtime: `/tmp/oxlint-runtime.log`
  - panic: `/tmp/oxlint-panic.log`

## Scope and non-goals

- This fix does **not** change rule evaluation semantics or tsgolint behavior.
- It addresses process stability under output stream teardown/cancellation conditions.
- If additional type-aware panics exist, they should surface after this crash path is removed.

## Upstream context

- Broken pipe panic class previously fixed in diagnostics path:
  - Issue: https://github.com/oxc-project/oxc/issues/5452
  - PR: https://github.com/oxc-project/oxc/pull/5526
- VS Code crash hardening precedents:
  - https://github.com/oxc-project/oxc/issues/7434
  - https://github.com/oxc-project/oxc/pull/7440
  - https://github.com/oxc-project/oxc/issues/10575
  - https://github.com/oxc-project/oxc/issues/14565
  - https://github.com/oxc-project/oxc/issues/8594
