mod common;

use pi_edit::{
	EditMode, ModeEngine,
	modes::hashline::{
		HashlineEngine,
		patcher::{no_change_diagnostic, no_change_loop_diagnostic},
	},
	stream_json::ArgSnapshot,
};
use serde_json::json;

#[tokio::test]
async fn patcher_apply_cases() {
	common::run_fixture("hashline/patcher.json", EditMode::Hashline).await;
}

#[test]
fn matcher_paths_accept_partial_sections_and_header_noise() {
	let engine = HashlineEngine { enforce_seen_lines: false, max_columns: 512 };
	let inspected = engine.inspect(&ArgSnapshot {
		input: Some(
			"[one.ts#ABCD]\nPUT 1.=1:\n+one\n[*** Update File: dir with spaces/two.ts#1234]\nPUT \
			 2.=2:\n+two"
				.into(),
		),
		..ArgSnapshot::default()
	});
	assert_eq!(inspected.paths, ["one.ts", "dir with spaces/two.ts"]);
	assert_eq!(inspected.entries, [
		("one.ts".into(), "one".into()),
		("dir with spaces/two.ts".into(), "two".into())
	]);
}

#[test]
fn no_op_diagnostics_preserve_model_guidance() {
	assert_eq!(
		no_change_diagnostic("a.ts"),
		"Edits to a.ts parsed and applied cleanly, but produced no change: your body row(s) are \
		 byte-identical to the file at the targeted lines. The bug is somewhere else — re-read the \
		 file before issuing another edit. Do NOT widen the payload or add lines; verify the anchor \
		 first."
	);
	assert!(
		no_change_loop_diagnostic("a.ts", 3)
			.starts_with("STOP. Edits to a.ts have been a byte-identical no-op 3 times in a row")
	);
}

#[tokio::test]
async fn identical_noop_escalates_on_third_attempt() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "same\n");
	let tag = workspace.snapshot("a.txt", "same\n", None);
	let args = json!({ "input": format!("[a.txt#{tag}]\nPUT 1.=1:\n+same") });
	for _ in 0..2 {
		let outcome = workspace
			.apply_json(&args, &common::DiskWriter::default())
			.await
			.expect("soft no-op");
		assert!(outcome.text.contains("produced no change"));
	}
	let error = workspace
		.apply_json(&args, &common::DiskWriter::default())
		.await
		.expect_err("third no-op must fail");
	assert!(
		error
			.to_string()
			.starts_with("STOP. Edits to a.txt have been a byte-identical no-op 3 times in a row")
	);
}

#[test]
fn streaming_preview_keeps_completed_section_when_trailing_header_arrives() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	workspace.write("b.txt", "b\n");
	let tag_a = workspace.snapshot("a.txt", "a\n", None);
	let tag_b = workspace.snapshot("b.txt", "b\n", None);
	let input = format!("[a.txt#{tag_a}]\nPUT 1.=1:\n+A\n[b.txt#{tag_b}]");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": input }).to_string());
	let batch = session.preview();
	assert!(batch.streaming);
	assert_eq!(batch.files.len(), 1);
	assert_eq!(batch.files[0].display, "a.txt");
	assert!(
		batch.files[0]
			.diff
			.as_deref()
			.is_some_and(|diff| diff.contains("+1|A"))
	);
}

#[tokio::test]
async fn rejection_names_the_path_a_foreign_tag_was_issued_for() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let worktree = workspace.write("wt/crates/a/mcp.rs", "worktree\n");
	workspace.write("crates/a/mcp.rs", "parent\n");
	let tag = workspace.snapshot("wt/crates/a/mcp.rs", "worktree\n", None);
	let writer = common::DiskWriter::default();
	let input = format!("[crates/a/mcp.rs#{tag}]\nPUT 1.=1:\n+changed\n");
	let error = workspace
		.apply_json(&json!({ "input": input }), &writer)
		.await
		.expect_err("foreign tag must be rejected")
		.to_string();
	let origin = pi_edit::path_policy::canonical_key(&worktree);
	assert!(
		error.contains(&format!("Hash #{tag} was issued in this session for {}.", origin.display())),
		"{error}"
	);
	assert!(writer.requests.lock().is_empty());
	assert_eq!(workspace.read("crates/a/mcp.rs").as_deref(), Some("parent\n"));
	assert_eq!(workspace.read("wt/crates/a/mcp.rs").as_deref(), Some("worktree\n"));
}

#[tokio::test]
async fn recovered_rem_reports_authored_and_deleted_paths() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	let target = workspace.write("correct/target.ts", "const value = 1;\n");
	let tag = workspace.snapshot("correct/target.ts", "const value = 1;\n", None);
	let input = format!("[wrong/target.ts#{tag}]\nREM\n");
	let outcome = workspace
		.apply_json(&json!({ "input": input }), &common::DiskWriter::default())
		.await
		.expect("recovered delete");

	assert!(!target.exists());
	let deleted = pi_edit::path_policy::canonical_key(&target);
	assert!(
		outcome
			.text
			.contains(&format!("Deleted {}", deleted.display())),
		"{}",
		outcome.text
	);
	assert!(
		outcome.text.contains(&format!(
			"Warnings:\nPath \"wrong/target.ts\" does not exist; matched its filename and snapshot \
			 tag #{tag} to {}",
			deleted.display()
		)),
		"{}",
		outcome.text
	);
}

#[test]
fn completed_preview_surfaces_stale_hash_error() {
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("a.txt", "a\n");
	let mut session = workspace.session();
	session.set_args_json(&json!({ "input": "[a.txt#FFFF]\nPUT 1.=1:\n+A\n" }).to_string());
	session.finish();
	let batch = session.preview();
	assert!(!batch.streaming);
	assert!(
		batch.files[0]
			.error
			.as_deref()
			.is_some_and(|error| error.contains("not from this session"))
	);
}

/// A body that restates both neighbouring lines and is too short for its
/// range: `PUT 3.=5:` restates `alive = true;` above and the `isAlive()`
/// header below, with one blank row between them for three range rows. Its
/// repair used to drop only the trailing echo, writing `alive = true;` twice
/// and deleting `constructor() {}` while reporting success. It is refused,
/// the file is left as it was, and the resend the refusal asks for applies.
#[tokio::test]
async fn refuses_a_short_body_that_restates_both_neighbours_and_applies_the_resend() {
	const PROBE: &str = "class Probe {\n\talive = true;\n\n\tconstructor() {}\n\n\tisAlive(): \
	                     boolean {\n\t\treturn this.alive;\n\t}\n}\n";
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("probe.ts", PROBE);
	let tag = workspace.snapshot("probe.ts", PROBE, None);
	let error = workspace
		.apply_json(
			&json!({
				"input": format!(
					"[probe.ts#{tag}]\nPUT 3.=5:\n+\talive = true;\n+\n+\tisAlive(): boolean {{\n"
				)
			}),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("a body too short between two echoes must not apply")
		.to_string();
	assert!(
		error.contains("`PUT 3.=5:` rejected: the body restates both")
			&& error.contains("they leave out lines 4-5"),
		"{error}"
	);
	assert_eq!(workspace.read("probe.ts").as_deref(), Some(PROBE));
	workspace
		.apply_json(
			&json!({ "input": format!("[probe.ts#{tag}]\nPUT 3.=5:\n+\n") }),
			&common::DiskWriter::default(),
		)
		.await
		.expect("the resend covers exactly the changed lines");
	assert_eq!(
		workspace.read("probe.ts").as_deref(),
		Some(
			"class Probe {\n\talive = true;\n\n\tisAlive(): boolean {\n\t\treturn \
			 this.alive;\n\t}\n}\n"
		)
	);
}

/// Shapes that lost a range row while reporting success, each refused with
/// the file left as it was:
/// - a body that restates the line above twice, in a file with no parser (the
///   first copy was dropped as an echo and the second written as content,
///   deleting `z = 3`);
/// - a one-sided too-short group in a patch whose other group's repair made the
///   file parse (the short group was applied as written, writing `const a = 1;`
///   twice and deleting `const c = 3;`).
#[tokio::test]
async fn refuses_echo_shapes_that_lost_rows_and_leaves_the_file_unchanged() {
	const ROWS: &str = "x = 1\ny = 2\nz = 3\nw = 4\n";
	const MULTI: &str =
		"const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nfunction f() {\n\treturn 1;\n}\n";
	let cases = [
		("r.txt", ROWS, "PUT 2.=3:\n+x = 1\n+x = 1\n+Y = 2\n", "`PUT 2.=3:` rejected"),
		(
			"m.ts",
			MULTI,
			"PUT 2.=3:\n+const a = 1;\n+const B = 2;\nPUT 6.=6:\n+\treturn 1;\n+}\n",
			"`PUT 2.=3:` rejected",
		),
	];
	for (path, text, ops, refusal) in cases {
		let workspace = common::Workspace::new(EditMode::Hashline);
		workspace.write(path, text);
		let tag = workspace.snapshot(path, text, None);
		let error = workspace
			.apply_json(
				&json!({ "input": format!("[{path}#{tag}]\n{ops}") }),
				&common::DiskWriter::default(),
			)
			.await
			.expect_err(path)
			.to_string();
		assert!(error.contains(refusal), "{path}: {error}");
		assert_eq!(workspace.read(path).as_deref(), Some(text), "{path}");
	}
}

/// A repair that keeps a source row outside the restated copy: the copy then
/// sits inside the rows the patch writes, where a check at their edges does
/// not see it. This `PUT 2.=4:` restates the `{children}` line just below the
/// range and is a row short of it. The repair kept the range's `>` row, so
/// the result wrote `{children}` twice and deleted the `style=` attribute,
/// and it parsed, so only this check stops it.
#[tokio::test]
async fn refuses_a_repair_whose_kept_row_hides_a_restated_copy() {
	const GRID: &str = "\t\t<div\n\t\t\tclassName=\"stat-grid \
	                    rise\"\n\t\t\tstyle={min}\n\t\t>\n\t\t\t{children}\n\t\t</div>\n";
	let workspace = common::Workspace::new(EditMode::Hashline);
	workspace.write("Stat.tsx", GRID);
	let tag = workspace.snapshot("Stat.tsx", GRID, None);
	let error = workspace
		.apply_json(
			&json!({
				"input": format!(
					"[Stat.tsx#{tag}]\nPUT 2.=4:\n+\t\t\tclassName=\"stat-grid rise\"\n+\t\t\t{{children}}\n"
				)
			}),
			&common::DiskWriter::default(),
		)
		.await
		.expect_err("a repair that keeps a row must not hide the restated copy")
		.to_string();
	assert!(error.contains("`PUT 2.=4:` rejected"), "{error}");
	assert_eq!(workspace.read("Stat.tsx").as_deref(), Some(GRID));
}
