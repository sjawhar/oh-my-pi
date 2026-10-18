//! An EXIT trap set inside a subshell, command substitution, pipeline stage or
//! background job runs when that context ends, so cleanup traps there do not
//! leave their files behind.
#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

async fn run(command: &str, cwd: &std::path::Path) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions {
			command: command.to_string(),
			cwd: Some(cwd.to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let output: String = rx.drain().collect();
	(result.exit_code, output)
}

/// The `mktemp` + `trap 'rm -f' EXIT` cleanup idiom inside `( ... )`.
#[tokio::test]
async fn subshell_exit_trap_removes_its_temp_file() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run(
		r#"( f=$(mktemp -p "$PWD"); trap 'rm -f "$f"' EXIT; echo "$f" ); echo "left: $(ls -A | wc -l)""#,
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "output: {output}");
	assert!(output.trim_end().ends_with("left: 0"), "temp file was left behind: {output}");
}

#[tokio::test]
async fn command_substitution_exit_trap_removes_its_temp_file() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run(
		r#"x=$(f=$(mktemp -p "$PWD"); trap 'rm -f "$f"' EXIT; echo "$f"); echo "left: $(ls -A | wc -l)""#,
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "output: {output}");
	assert!(output.trim_end().ends_with("left: 0"), "temp file was left behind: {output}");
}

#[tokio::test]
async fn pipeline_stage_exit_trap_removes_its_temp_file() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run(
		r#"{ f=$(mktemp -p "$PWD"); trap 'rm -f "$f"' EXIT; echo "$f"; } | cat > /dev/null; echo "left: $(ls -A | wc -l)""#,
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "output: {output}");
	assert!(output.trim_end().ends_with("left: 0"), "temp file was left behind: {output}");
}

#[tokio::test]
async fn background_job_exit_trap_removes_its_temp_file() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) = run(
		r#"{ f=$(mktemp -p "$PWD"); trap 'rm -f "$f"' EXIT; echo "$f" > path; } & wait; echo "left: $(ls -A | wc -l)""#,
		dir.path(),
	)
	.await;
	assert_eq!(code, Some(0), "output: {output}");
	// Only the `path` file the job wrote remains.
	assert!(output.trim_end().ends_with("left: 1"), "temp file was left behind: {output}");
}

/// The parent's EXIT trap is never run by a subshell it spawns.
#[tokio::test]
async fn inherited_exit_trap_does_not_run_in_a_subshell() {
	let dir = tempfile::tempdir().expect("tempdir");
	let (code, output) =
		run(r#"trap 'echo parent-exit' EXIT; ( echo sub ); echo after"#, dir.path()).await;
	assert_eq!(code, Some(0), "output: {output}");
	assert!(output.starts_with("sub\nafter\n"), "output: {output}");
}
