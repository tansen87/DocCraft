use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;

use tauri::AppHandle;

use crate::models::{UsageInput, UsageLogEntry, UsagePeriodStats, UsageStats};

/// Append-only local usage log stored as JSONL next to the app settings
/// (`usage-log.jsonl` under the config data dir). Never leaves the machine and
/// is intentionally NOT part of the exported / imported configuration.
const USAGE_LOG_FILE: &str = "usage-log.jsonl";

/// Serialise appends so concurrent conversions never interleave JSON lines.
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn usage_log_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  Ok(crate::core::settings::data_dir(app)?.join(USAGE_LOG_FILE))
}

/// Append one usage event to the local log. Pure file I/O - no network.
pub fn record_usage(app: &AppHandle, input: UsageInput) -> Result<(), String> {
  let entry = UsageLogEntry {
    date: input.date,
    kind: input.kind,
    file_count: input.file_count,
    page_count: input.page_count,
    ocr_page_count: input.ocr_page_count,
    engine: input.engine,
    total_ms: input.total_ms,
  };
  let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
  let path = usage_log_path(app)?;

  let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let mut file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| e.to_string())?;
  writeln!(file, "{line}").map_err(|e| e.to_string())?;
  Ok(())
}

fn read_entries(path: &std::path::Path) -> Vec<UsageLogEntry> {
  let Ok(file) = std::fs::File::open(path) else {
    return Vec::new();
  };
  BufReader::new(file)
    .lines()
    .filter_map(|line| {
      line
        .ok()
        .and_then(|l| serde_json::from_str::<UsageLogEntry>(&l).ok())
    })
    .collect()
}

/// Aggregate the log into today / this month / total counters. `today` is the
/// frontend-computed local date (`YYYY-MM-DD`); the month bucket derives from it.
pub fn get_usage_stats(app: &AppHandle, today: &str) -> Result<UsageStats, String> {
  let month = today.chars().take(7).collect::<String>();
  let mut month_stats = UsagePeriodStats::default();
  let mut today_stats = UsagePeriodStats::default();
  let mut total_stats = UsagePeriodStats::default();

  for entry in read_entries(&usage_log_path(app)?) {
    total_stats.add(&entry);
    if entry.month() == month {
      month_stats.add(&entry);
    }
    if entry.date == today {
      today_stats.add(&entry);
    }
  }

  Ok(UsageStats {
    month: month_stats,
    today: today_stats,
    total: total_stats,
  })
}

/// Delete the usage log entirely ("clear statistics" in settings).
pub fn clear_usage_stats(app: &AppHandle) -> Result<(), String> {
  let path = usage_log_path(app)?;
  if path.exists() {
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
  }
  Ok(())
}
