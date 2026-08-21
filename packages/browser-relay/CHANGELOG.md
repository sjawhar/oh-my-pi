# Changelog

## [Unreleased]

### Changed

- The extension now enforces the `omp` tab group as the access-control list — it announces only grouped tabs, re-derives membership on reconnect, checks scope on every attach/send/remove/activate at execution time, suppresses commands and debugger events while a membership change is being recomputed (a reconciliation that fails revokes the affected tabs rather than restoring them), force-detaches and retracts tabs that leave the group (including cross-window drags), and closes a created tab it fails to group; the group is no longer dissolved when the relay disconnects.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
