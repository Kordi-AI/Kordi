//! Community catalog lists: search results and the most-installed leaderboards
//! (ClawHub and skills.sh). Detail, review and install live in the parent module.

use kordi_cli::skill_library::SkillLibraryEntry;
use reqwest::Client;
use serde::Deserialize;

use super::{
    catalog_url, clawhub_source_url, installed_match, response_json, skills_sh_token,
    ClawHubLatestVersion, ClawHubStats, DesktopCommunitySkillSummary, CLAWHUB_API, SKILLS_SH_API,
};

const COMMUNITY_RESULT_LIMIT: usize = 40;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSearchResponse {
    #[serde(default)]
    results: Vec<ClawHubSearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubSearchItem {
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    summary: String,
    version: Option<String>,
    #[serde(default)]
    downloads: u64,
    updated_at: Option<i64>,
    owner_handle: Option<String>,
}

/// One page of the ClawHub leaderboard (`GET /skills?sort=downloads`).
#[derive(Debug, Deserialize)]
struct ClawHubListResponse {
    #[serde(default)]
    items: Vec<ClawHubListItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClawHubListItem {
    slug: String,
    display_name: Option<String>,
    summary: Option<String>,
    #[serde(default)]
    stats: ClawHubStats,
    updated_at: Option<i64>,
    owner_handle: Option<String>,
    latest_version: Option<ClawHubLatestVersion>,
}

#[derive(Debug, Deserialize)]
struct SkillsShSearchResponse {
    #[serde(default)]
    data: Vec<SkillsShSearchItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillsShSearchItem {
    id: String,
    slug: String,
    name: String,
    source: String,
    #[serde(default)]
    installs: u64,
    url: String,
}

/// Searches one catalog. Queries shorter than two characters return nothing.
pub(super) async fn search(
    client: &Client,
    provider: &str,
    query: &str,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    match provider {
        "clawhub" => clawhub_search(client, query, installed).await,
        "skills-sh" => skills_sh_search(client, query, installed).await,
        _ => Err("Unknown community skill provider".to_string()),
    }
}

/// The catalog's most-installed skills, shown before the user types a query.
pub(super) async fn popular(
    client: &Client,
    provider: &str,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    match provider {
        "clawhub" => clawhub_popular(client, installed).await,
        "skills-sh" => skills_sh_popular(client, installed).await,
        _ => Err("Unknown community skill provider".to_string()),
    }
}

async fn clawhub_search(
    client: &Client,
    query: &str,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let limit = COMMUNITY_RESULT_LIMIT.to_string();
    let url = catalog_url(
        CLAWHUB_API,
        "search",
        &[
            ("q", query.trim()),
            ("nonSuspiciousOnly", "true"),
            ("limit", &limit),
        ],
    )?;
    let response: ClawHubSearchResponse = response_json(
        client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("ClawHub could not be reached: {error}"))?,
    )
    .await?;
    Ok(response
        .results
        .into_iter()
        .take(COMMUNITY_RESULT_LIMIT)
        .map(|item| {
            clawhub_summary(
                ClawHubSummaryParts {
                    owner: item.owner_handle,
                    slug: item.slug,
                    display_name: item.display_name,
                    summary: item.summary,
                    version: item.version,
                    downloads: item.downloads,
                    stars: 0,
                    updated_at: item.updated_at,
                },
                installed,
            )
        })
        .collect())
}

struct ClawHubSummaryParts {
    owner: Option<String>,
    slug: String,
    display_name: String,
    summary: String,
    version: Option<String>,
    downloads: u64,
    stars: u64,
    updated_at: Option<i64>,
}

fn clawhub_summary(
    parts: ClawHubSummaryParts,
    installed: &[SkillLibraryEntry],
) -> DesktopCommunitySkillSummary {
    let owner = parts.owner;
    DesktopCommunitySkillSummary {
        id: format!(
            "clawhub:{}:{}",
            owner.as_deref().unwrap_or("unknown"),
            parts.slug
        ),
        provider: "clawhub".to_string(),
        source_url: clawhub_source_url(owner.as_deref(), &parts.slug),
        installed: installed_match(installed, "clawhub", owner.as_deref(), &parts.slug),
        owner,
        name: if parts.display_name.trim().is_empty() {
            parts.slug.clone()
        } else {
            parts.display_name
        },
        slug: parts.slug,
        description: parts.summary,
        version: parts.version,
        downloads: parts.downloads,
        stars: parts.stars,
        updated_at_ms: parts.updated_at,
    }
}

/// Most-downloaded ClawHub skills, shown before the user types a query.
async fn clawhub_popular(
    client: &Client,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    let limit = COMMUNITY_RESULT_LIMIT.to_string();
    let url = catalog_url(
        CLAWHUB_API,
        "skills",
        &[
            ("sort", "downloads"),
            ("nonSuspiciousOnly", "true"),
            ("limit", &limit),
        ],
    )?;
    let response: ClawHubListResponse = response_json(
        client
            .get(url)
            .send()
            .await
            .map_err(|error| format!("ClawHub could not be reached: {error}"))?,
    )
    .await?;
    Ok(response
        .items
        .into_iter()
        .take(COMMUNITY_RESULT_LIMIT)
        .map(|item| {
            clawhub_summary(
                ClawHubSummaryParts {
                    owner: item.owner_handle,
                    slug: item.slug,
                    display_name: item.display_name.unwrap_or_default(),
                    summary: item.summary.unwrap_or_default(),
                    version: item.latest_version.map(|latest| latest.version),
                    downloads: item.stats.downloads,
                    stars: item.stats.stars,
                    updated_at: item.updated_at,
                },
                installed,
            )
        })
        .collect())
}

async fn skills_sh_search(
    client: &Client,
    query: &str,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let token = skills_sh_token()?;
    let limit = COMMUNITY_RESULT_LIMIT.to_string();
    let url = catalog_url(
        SKILLS_SH_API,
        "skills/search",
        &[("q", query.trim()), ("limit", &limit)],
    )?;
    let response: SkillsShSearchResponse = response_json(
        client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| format!("Skills.sh could not be reached: {error}"))?,
    )
    .await?;
    Ok(skills_sh_summaries(response, installed))
}

fn skills_sh_summaries(
    response: SkillsShSearchResponse,
    installed: &[SkillLibraryEntry],
) -> Vec<DesktopCommunitySkillSummary> {
    response
        .data
        .into_iter()
        .take(COMMUNITY_RESULT_LIMIT)
        .map(|item| DesktopCommunitySkillSummary {
            id: format!("skills-sh:{}", item.id),
            provider: "skills-sh".to_string(),
            owner: Some(item.source.clone()),
            slug: item.slug.clone(),
            name: item.name,
            description: format!("Published from {}", item.source),
            version: None,
            downloads: item.installs,
            stars: 0,
            updated_at_ms: None,
            source_url: item.url,
            installed: installed_match(installed, "skills-sh", Some(&item.source), &item.slug),
        })
        .collect()
}

/// The skills.sh all-time leaderboard (`GET /skills`), shown before the user types a query.
/// It returns the same item shape as search.
async fn skills_sh_popular(
    client: &Client,
    installed: &[SkillLibraryEntry],
) -> Result<Vec<DesktopCommunitySkillSummary>, String> {
    let token = skills_sh_token()?;
    let limit = COMMUNITY_RESULT_LIMIT.to_string();
    let url = catalog_url(
        SKILLS_SH_API,
        "skills",
        &[("view", "all-time"), ("per_page", &limit)],
    )?;
    let response: SkillsShSearchResponse = response_json(
        client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| format!("Skills.sh could not be reached: {error}"))?,
    )
    .await?;
    Ok(skills_sh_summaries(response, installed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clawhub_leaderboard_items_map_to_community_summaries() {
        let response: ClawHubListResponse = serde_json::from_str(
            r#"{"items":[{"ownerHandle":"pixel-forge","slug":"figma-to-code","displayName":"Figma to code","summary":null,"stats":{"downloads":21500,"stars":12},"updatedAt":5,"latestVersion":{"version":"1.2.0"}},{"slug":"bare","stats":{}}],"nextCursor":null}"#,
        )
        .expect("leaderboard parses");
        let summaries: Vec<_> = response
            .items
            .into_iter()
            .map(|item| {
                clawhub_summary(
                    ClawHubSummaryParts {
                        owner: item.owner_handle,
                        slug: item.slug,
                        display_name: item.display_name.unwrap_or_default(),
                        summary: item.summary.unwrap_or_default(),
                        version: item.latest_version.map(|latest| latest.version),
                        downloads: item.stats.downloads,
                        stars: item.stats.stars,
                        updated_at: item.updated_at,
                    },
                    &[],
                )
            })
            .collect();
        assert_eq!(summaries[0].id, "clawhub:pixel-forge:figma-to-code");
        assert_eq!(summaries[0].name, "Figma to code");
        assert_eq!(summaries[0].version.as_deref(), Some("1.2.0"));
        assert_eq!(summaries[0].downloads, 21500);
        assert_eq!(
            summaries[0].source_url,
            "https://clawhub.ai/pixel-forge/skills/figma-to-code"
        );
        assert_eq!(summaries[1].name, "bare");
        assert_eq!(summaries[1].description, "");
    }

    #[test]
    fn skills_sh_leaderboard_uses_the_search_item_shape() {
        let response: SkillsShSearchResponse = serde_json::from_str(
            r#"{"data":[{"id":"vercel-labs/skills/find-skills","slug":"find-skills","name":"find-skills","source":"vercel-labs/skills","installs":24531,"sourceType":"github","installUrl":"https://github.com/vercel-labs/skills","url":"https://skills.sh/vercel-labs/skills/find-skills"}],"pagination":{"page":0,"perPage":40,"total":1,"hasMore":false}}"#,
        )
        .expect("leaderboard parses");
        let summaries = skills_sh_summaries(response, &[]);
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].owner.as_deref(), Some("vercel-labs/skills"));
        assert_eq!(summaries[0].downloads, 24531);
    }
}
