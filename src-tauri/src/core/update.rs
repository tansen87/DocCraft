//! Lightweight release update check (GitHub Releases API).
//!
//! Deliberately not the official updater plugin: no signing keys / packaging
//! pipeline exist yet, so we only *detect* a newer version and hand the
//! release's markdown body to the frontend, which shows it in a dialog with
//! a link to the release page. All failures degrade gracefully so an
//! unreachable endpoint never bothers the user outside the explicit check.

use serde::Serialize;

/// GitHub API endpoint returning the latest published release (drafts and
/// prereleases are excluded by GitHub itself). `body` carries the release
/// notes as markdown.
const RELEASE_API_URL: &str = "https://api.github.com/repos/tansen87/DocCraft/releases/latest";

/// Page the frontend's "update" button navigates to.
pub const RELEASE_PAGE_URL: &str = "https://github.com/tansen87/DocCraft/releases/latest/";

const HTTP_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
  /// Version without the leading `v` (parsed from `tag_name`).
  pub version: String,
  /// Release title (`name` field).
  pub title: String,
  /// Release notes markdown (`body` field).
  pub notes: String,
  /// Release page URL (`html_url` field).
  pub url: String,
}

/// Ask GitHub whether a release newer than the running app exists.
/// Returns `Ok(None)` when up-to-date or when the repository simply has no
/// releases yet; network failures surface as errors for the manual check.
pub async fn check_for_update(app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
  let current = app.package_info().version.to_string();
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
    // GitHub rejects API requests without a User-Agent.
    .user_agent(concat!("DocCraft/", env!("CARGO_PKG_VERSION")))
    .build()
    .map_err(|e| e.to_string())?;

  let response = client
    .get(RELEASE_API_URL)
    .send()
    .await
    .map_err(|e| e.to_string())?;
  if response.status().as_u16() == 404 {
    // No releases published yet.
    return Ok(None);
  }
  let release: serde_json::Value = response
    .error_for_status()
    .map_err(|e| e.to_string())?
    .json()
    .await
    .map_err(|e| e.to_string())?;

  let tag = release
    .get("tag_name")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim();
  let latest = tag.trim_start_matches('v').to_string();
  if latest.is_empty() || !is_newer(&latest, &current) {
    return Ok(None);
  }

  let str_field = |key: &str| {
    release
      .get(key)
      .and_then(|v| v.as_str())
      .unwrap_or("")
      .to_string()
  };

  Ok(Some(UpdateInfo {
    version: latest,
    title: str_field("name"),
    notes: str_field("body"),
    url: str_field("html_url"),
  }))
}

/// Compare dotted numeric versions (`0.2.0` > `0.1.10`). Non-numeric parts
/// compare as zero; missing components count as `0`.
fn is_newer(candidate: &str, current: &str) -> bool {
  fn parse(v: &str) -> Vec<u64> {
    v.split('.')
      .map(|p| {
        p.chars()
          .take_while(char::is_ascii_digit)
          .collect::<String>()
          .parse()
          .unwrap_or(0)
      })
      .collect()
  }
  let (a, b) = (parse(candidate), parse(current));
  for i in 0..a.len().max(b.len()) {
    let (av, bv) = (
      a.get(i).copied().unwrap_or(0),
      b.get(i).copied().unwrap_or(0),
    );
    if av != bv {
      return av > bv;
    }
  }
  false
}
