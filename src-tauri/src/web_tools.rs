//! Web tools — Tier 1 (search), Tier 2 (page fetch), Tier 3 (deep research).
//!
//! These are separate from OpenClaw's own built-in `browser`/`gog` skills (which run
//! entirely inside the OpenClaw container and are configured via `sync_agent_skills`).
//! The agent cannot call a Tauri command directly — it only reaches the host over the
//! JIT bridge (port 18802, see `jit_server.rs`) — so the routes there are what actually
//! make these tools callable from a running agent. The `#[tauri::command]` wrappers here
//! exist for the Canopy frontend (manual testing, a future "web search" panel, etc.).
//!
//! Fetched web content is untrusted input. Callers MUST wrap `PageContent::text` and
//! `ResearchPacket` source text in a `<web_content source="...">` tag when handing it to
//! a model, per `PERMISSIONS.md` (see `openclaw::write_permissions_md`).

use serde::{Deserialize, Serialize};
use std::time::Duration;

const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CanopyAgent/1.0";
const FETCH_TIMEOUT_SECS: u64 = 20;
const SEARCH_TIMEOUT_SECS: u64 = 12;
const CDP_CONNECT_TIMEOUT_SECS: u64 = 8;
const CDP_CALL_TIMEOUT_SECS: u64 = 15;
const MAX_TEXT_CHARS: usize = 20_000;
const RESEARCH_PAGE_TEXT_CHARS: usize = 6_000;
const MAX_LINKS: usize = 25;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageContent {
    pub title: String,
    pub requested_url: String,
    pub final_url: String,
    pub text: String,
    pub links: Vec<String>,
    pub rendered_via_browser: bool,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchPacket {
    pub topic: String,
    pub depth: u8,
    pub search_results: Vec<SearchResult>,
    pub sources: Vec<PageContent>,
}

// ─── Fixed, non-configurable fetch blocklist ──────────────────────────────────
//
// Mirrors `screen_capture::CAPTURE_BLOCKLIST_BUNDLE_IDS`: a hard list checked before any
// fetch proceeds, with no permission-grant override. If the agent needs one of these, it
// asks the user to open the page themselves rather than auto-fetching financial or
// medical account data.
pub const FETCH_BLOCKLIST_DOMAINS: &[&str] = &[
    // Banking / brokerage
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citibank.com",
    "citi.com",
    "usbank.com",
    "capitalone.com",
    "schwab.com",
    "fidelity.com",
    "vanguard.com",
    "ally.com",
    "discover.com",
    "americanexpress.com",
    "amex.com",
    // Payments / crypto
    "paypal.com",
    "venmo.com",
    "coinbase.com",
    "kraken.com",
    // Healthcare / medical portals
    "mychart.com",
    "myuhc.com",
    "healthcare.gov",
    "kp.org",
    "anthem.com",
    "cigna.com",
    "aetna.com",
    "epic.com",
];

fn blocklisted_domain(host: &str) -> Option<&'static str> {
    let host = host.to_lowercase();
    FETCH_BLOCKLIST_DOMAINS
        .iter()
        .find(|d| host == **d || host.ends_with(&format!(".{d}")))
        .copied()
}

/// SSRF guard. Mirrors the always-on block in `browser_manager::build_pac_script`
/// (localhost, RFC1918, link-local) — this is a host-side gate in front of a direct
/// `reqwest` call, not a proxied one, so it needs to hold on its own.
fn is_private_or_local(host: &str) -> bool {
    let host = host.trim().to_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast()
                    || v4.is_documentation()
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() {
                    return true;
                }
                let seg0 = v6.segments()[0];
                (seg0 & 0xfe00) == 0xfc00 // fc00::/7 — unique local
                    || (seg0 & 0xffc0) == 0xfe80 // fe80::/10 — link-local
            }
        };
    }
    false
}

fn cap_text(text: String, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text, false);
    }
    let capped: String = text.chars().take(max_chars).collect();
    (capped, true)
}

fn extract_title_and_text(html: &str) -> (String, String) {
    let document = scraper::Html::parse_document(html);
    let title = scraper::Selector::parse("title")
        .ok()
        .and_then(|sel| document.select(&sel).next())
        .map(|el| el.text().collect::<String>().trim().to_string())
        .unwrap_or_default();
    let text = html2text::from_read(html.as_bytes(), 100);
    (title, text)
}

fn extract_links(html: &str, base: &url::Url) -> Vec<String> {
    let document = scraper::Html::parse_document(html);
    let Ok(sel) = scraper::Selector::parse("a[href]") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for el in document.select(&sel) {
        if out.len() >= MAX_LINKS {
            break;
        }
        let Some(href) = el.value().attr("href") else {
            continue;
        };
        if let Ok(joined) = base.join(href) {
            if matches!(joined.scheme(), "http" | "https") {
                out.push(joined.to_string());
            }
        }
    }
    out
}

/// Heuristic for "this page is an empty SPA shell" — short extracted text, or copy
/// that explicitly asks the visitor to enable JavaScript.
fn looks_js_rendered(html: &str, text: &str) -> bool {
    let low = html.to_lowercase();
    let word_count = text.split_whitespace().count();
    word_count < 40
        || low.contains("enable javascript")
        || low.contains("requires javascript")
        || low.contains("turn on javascript")
        || low.contains("javascript is disabled")
}

async fn lightweight_fetch(url: &url::Url) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))?;

    let resp = client
        .get(url.clone())
        .header("Accept", "text/html,application/xhtml+xml")
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;

    let final_url = resp.url().to_string();
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("server returned HTTP {} for {}", status.as_u16(), url));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("could not read response body: {e}"))?;
    Ok((final_url, html))
}

// ─── Tier 2 escalation: render via the agent's managed Chrome (browser_manager) ──

struct RenderedPage {
    final_url: String,
    title: String,
    text: String,
    links: Vec<String>,
}

async fn cdp_call(
    ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    id: i64,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let req = serde_json::json!({ "id": id, "method": method, "params": params });
    ws.send(Message::Text(req.to_string().into()))
        .await
        .map_err(|e| format!("CDP send failed for '{method}': {e}"))?;

    loop {
        match tokio::time::timeout(Duration::from_secs(CDP_CALL_TIMEOUT_SECS), ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let Ok(resp) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                if resp.get("id").and_then(|v| v.as_i64()) != Some(id) {
                    continue; // a CDP event, not our response — keep waiting
                }
                if let Some(err) = resp.get("error") {
                    return Err(format!("CDP error for '{method}': {err}"));
                }
                return Ok(resp.get("result").cloned().unwrap_or(serde_json::Value::Null));
            }
            Ok(Some(Ok(_))) => continue, // ping/pong/binary frame — ignore
            _ => return Err(format!("rendering browser connection lost waiting for '{method}'")),
        }
    }
}

async fn render_via_cdp(cdp_endpoint: &str, url: &str) -> Result<RenderedPage, String> {
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(CDP_CONNECT_TIMEOUT_SECS),
        tokio_tungstenite::connect_async(cdp_endpoint),
    )
    .await
    .map_err(|_| "timed out connecting to rendering browser".to_string())?
    .map_err(|e| format!("could not connect to rendering browser: {e}"))?;

    cdp_call(&mut ws, 1, "Page.enable", serde_json::json!({})).await?;
    cdp_call(&mut ws, 2, "Page.navigate", serde_json::json!({ "url": url })).await?;

    // Poll document.readyState rather than waiting on Page.loadEventFired — some SPA
    // routers never fire a clean load event after their initial client-side navigation.
    let mut ready = false;
    for id in 3..15 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let result = cdp_call(
            &mut ws,
            id,
            "Runtime.evaluate",
            serde_json::json!({ "expression": "document.readyState", "returnByValue": true }),
        )
        .await?;
        if result.pointer("/result/value").and_then(|v| v.as_str()) == Some("complete") {
            ready = true;
            break;
        }
    }
    if !ready {
        tracing::debug!(
            "render_via_cdp: {} never reported readyState=complete within budget; extracting anyway",
            url
        );
    }

    // `complete` only means the initial document finished loading, not that a
    // React/Vue-style app has hydrated and painted its content yet.
    tokio::time::sleep(Duration::from_millis(800)).await;

    let extract = cdp_call(
        &mut ws,
        99,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": "JSON.stringify({title: document.title, text: (document.body ? document.body.innerText : ''), url: location.href, links: Array.from(document.querySelectorAll('a[href]')).slice(0,50).map(a => a.href)})",
            "returnByValue": true
        }),
    )
    .await?;

    let raw = extract
        .pointer("/result/value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "rendering browser returned no page data".to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("could not parse rendered page data: {e}"))?;

    Ok(RenderedPage {
        final_url: parsed
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or(url)
            .to_string(),
        title: parsed
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        text: parsed
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        links: parsed
            .get("links")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
    })
}

/// True if this status describes a Chrome we can actually open a CDP connection to.
/// Duplicated (not imported) from `browser_manager::status_is_connectable`, which is
/// module-private; the two must be kept in sync if that check ever changes.
fn browser_status_connectable(status: &crate::browser_manager::BrowserStatus) -> bool {
    status.mode == crate::browser_manager::BrowserMode::Automated
        && !status.cdp_endpoint.is_empty()
        && status.port != 0
}

async fn browser_render(
    app_handle: &tauri::AppHandle,
    browser_manager: &crate::browser_manager::BrowserManager,
    agent: &crate::models::Agent,
    url: &str,
) -> Result<RenderedPage, String> {
    // Gateway (non-isolated) agents all share one Chrome instance keyed "shared-browser"
    // (see browser_manager::effective_browsing_profile) — reuse it instead of spawning a
    // redundant dedicated Chrome under the agent's own id. Isolated agents get their own.
    let browser_key = if agent.isolated {
        agent.id.clone()
    } else {
        "shared-browser".to_string()
    };

    let status = match browser_manager
        .get_status(&browser_key)
        .await
        .map_err(|e| e.to_string())?
    {
        Some(s) if browser_status_connectable(&s) => s,
        _ => browser_manager
            .start_browser(app_handle.clone(), &browser_key)
            .await
            .map_err(|e| format!("could not start rendering browser: {e}"))?,
    };

    render_via_cdp(&status.cdp_endpoint, url).await
}

// ─── Tier 2: fetch_page ────────────────────────────────────────────────────────

pub async fn fetch_page_impl(
    app_handle: &tauri::AppHandle,
    browser_manager: &crate::browser_manager::BrowserManager,
    agent: &crate::models::Agent,
    allow_browser_escalation: bool,
    url_str: &str,
) -> Result<PageContent, String> {
    let parsed =
        url::Url::parse(url_str.trim()).map_err(|_| format!("'{url_str}' is not a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http:// and https:// URLs are supported".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?
        .to_string();
    if is_private_or_local(&host) {
        return Err(format!("refusing to fetch local/private address '{host}'"));
    }
    if let Some(blocked) = blocklisted_domain(&host) {
        return Err(format!(
            "'{host}' matches the fixed fetch blocklist ({blocked}, a financial/medical portal) \
             and cannot be auto-fetched — ask the user to open it themselves or paste the content you need"
        ));
    }

    let (final_url, html) = lightweight_fetch(&parsed).await?;
    let (title, text) = extract_title_and_text(&html);

    if allow_browser_escalation && looks_js_rendered(&html, &text) {
        match browser_render(app_handle, browser_manager, agent, url_str).await {
            Ok(rendered) if rendered.text.split_whitespace().count() > text.split_whitespace().count() => {
                let (capped, truncated) = cap_text(rendered.text, MAX_TEXT_CHARS);
                return Ok(PageContent {
                    title: if rendered.title.is_empty() { title } else { rendered.title },
                    requested_url: url_str.to_string(),
                    final_url: rendered.final_url,
                    text: capped,
                    links: rendered.links.into_iter().take(MAX_LINKS).collect(),
                    rendered_via_browser: true,
                    truncated,
                });
            }
            Ok(_) => tracing::debug!(
                "fetch_page: browser render for {} didn't beat the static fetch; using static result",
                url_str
            ),
            Err(e) => tracing::warn!("fetch_page: browser escalation failed for {}: {}", url_str, e),
        }
    }

    let links = extract_links(&html, &parsed);
    let (capped, truncated) = cap_text(text, MAX_TEXT_CHARS);
    Ok(PageContent {
        title,
        requested_url: url_str.to_string(),
        final_url,
        text: capped,
        links,
        rendered_via_browser: false,
        truncated,
    })
}

// ─── Tier 1: web_search ─────────────────────────────────────────────────────────

pub async fn web_search_impl(query: &str, num_results: u32) -> Result<Vec<SearchResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("query must not be empty".to_string());
    }
    let n = num_results.clamp(1, 10) as usize;

    if let Ok(key) = crate::keychain::get_secret("BRAVE_SEARCH_API_KEY") {
        let key = key.trim().to_string();
        if !key.is_empty() {
            match brave_search(query, n, &key).await {
                Ok(results) if !results.is_empty() => return Ok(results),
                Ok(_) => tracing::debug!(
                    "web_search: Brave returned zero results for '{}', falling back to DuckDuckGo",
                    query
                ),
                Err(e) => tracing::warn!(
                    "web_search: Brave Search failed ({}), falling back to DuckDuckGo",
                    e
                ),
            }
        }
    }

    duckduckgo_search(query, n).await
}

async fn brave_search(query: &str, n: usize, api_key: &str) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", &n.to_string())])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", api_key)
        .send()
        .await
        .map_err(|e| format!("Brave Search request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Brave Search returned HTTP {}", resp.status().as_u16()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Brave Search returned invalid JSON: {e}"))?;

    let results = body
        .pointer("/web/results")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .take(n)
                .filter_map(|r| {
                    let url = r.get("url")?.as_str()?.to_string();
                    let title = r
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&url)
                        .to_string();
                    let snippet = r
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    Some(SearchResult { title, url, snippet })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(results)
}

/// `RelatedTopics` entries are either a leaf `{Text, FirstURL}` or a category grouping
/// `{Name, Topics: [...]}` — recurse into the latter so nested groups still surface results.
fn collect_related_topics(topics: &[serde_json::Value], out: &mut Vec<SearchResult>, n: usize) {
    for topic in topics {
        if out.len() >= n {
            return;
        }
        if let Some(nested) = topic.get("Topics").and_then(|v| v.as_array()) {
            collect_related_topics(nested, out, n);
            continue;
        }
        let text = topic.get("Text").and_then(|v| v.as_str()).unwrap_or_default();
        let url = topic.get("FirstURL").and_then(|v| v.as_str()).unwrap_or_default();
        if !text.is_empty() && !url.is_empty() {
            let title = text.split(" - ").next().unwrap_or(text).to_string();
            out.push(SearchResult {
                title,
                url: url.to_string(),
                snippet: text.to_string(),
            });
        }
    }
}

async fn duckduckgo_search(query: &str, n: usize) -> Result<Vec<SearchResult>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get("https://api.duckduckgo.com/")
        .query(&[
            ("q", query),
            ("format", "json"),
            ("no_html", "1"),
            ("skip_disambig", "1"),
        ])
        .send()
        .await
        .map_err(|e| format!("DuckDuckGo request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("DuckDuckGo returned HTTP {}", resp.status().as_u16()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("DuckDuckGo returned invalid JSON: {e}"))?;

    let mut results = Vec::new();

    let heading = body.get("Heading").and_then(|v| v.as_str()).unwrap_or_default();
    let abstract_text = body
        .get("AbstractText")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let abstract_url = body
        .get("AbstractURL")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if !abstract_url.is_empty() && !abstract_text.is_empty() {
        results.push(SearchResult {
            title: if heading.is_empty() { query.to_string() } else { heading.to_string() },
            url: abstract_url.to_string(),
            snippet: abstract_text.to_string(),
        });
    }

    if let Some(topics) = body.get("RelatedTopics").and_then(|v| v.as_array()) {
        collect_related_topics(topics, &mut results, n);
    }
    results.truncate(n);

    if results.is_empty() {
        return Err(format!(
            "no results from DuckDuckGo's Instant Answer API for '{query}' — it only covers topics \
             with a summary/definition, not general web search. Set BRAVE_SEARCH_API_KEY for full \
             web search results."
        ));
    }

    Ok(results)
}

// ─── Tier 3: research ───────────────────────────────────────────────────────────

pub async fn research_impl(
    app_handle: &tauri::AppHandle,
    browser_manager: &crate::browser_manager::BrowserManager,
    agent: &crate::models::Agent,
    can_browse: bool,
    topic: &str,
    depth: u8,
) -> Result<ResearchPacket, String> {
    let requested_depth = depth.clamp(1, 3);
    let search_results = web_search_impl(topic, 10).await?;

    if requested_depth == 1 || !can_browse {
        return Ok(ResearchPacket {
            topic: topic.to_string(),
            depth: if can_browse { requested_depth } else { 1 },
            search_results,
            sources: Vec::new(),
        });
    }

    let mut sources = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut follow_up: Vec<String> = Vec::new();

    for result in search_results.iter().take(5) {
        if !seen.insert(result.url.clone()) {
            continue;
        }
        match fetch_page_impl(app_handle, browser_manager, agent, true, &result.url).await {
            Ok(mut page) => {
                let (capped, truncated) = cap_text(page.text, RESEARCH_PAGE_TEXT_CHARS);
                page.text = capped;
                page.truncated = page.truncated || truncated;
                if requested_depth >= 3 {
                    follow_up.extend(page.links.iter().take(2).cloned());
                }
                sources.push(page);
            }
            Err(e) => tracing::debug!("research: could not fetch {}: {}", result.url, e),
        }
    }

    if requested_depth >= 3 {
        for link in follow_up.into_iter().take(10) {
            if sources.len() >= 12 || !seen.insert(link.clone()) {
                continue;
            }
            if let Ok(mut page) = fetch_page_impl(app_handle, browser_manager, agent, true, &link).await {
                let (capped, truncated) = cap_text(page.text, RESEARCH_PAGE_TEXT_CHARS);
                page.text = capped;
                page.truncated = page.truncated || truncated;
                sources.push(page);
            }
        }
    }

    Ok(ResearchPacket {
        topic: topic.to_string(),
        depth: requested_depth,
        search_results,
        sources,
    })
}

// ─── Tier 4: authenticated fetch (explicit per-domain consent) ──────────────────
//
// Never reuses the user's whole Chrome profile. The agent proposes a domain, the user
// approves it once/for-this-agent-forever/deny via the existing `/request_permission`
// flow (permission_id `webauth:<domain>`, handled in jit_server::resolve_permission_request),
// and only THEN does `chrome_cookies::read_cookies_for_host` ever run for that exact
// host. Approved-forever domains persist to a small per-agent JSON file (mirroring the
// browser allowlist pattern in browser_manager.rs — kept outside the DB to avoid a
// migration); once/session approvals live only in memory and are gone on restart.

fn web_auth_dir(agent_id: &str) -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("Canopy").join("agent-web-auth").join(agent_id))
}

fn web_auth_domains_path(agent_id: &str) -> Option<std::path::PathBuf> {
    web_auth_dir(agent_id).map(|d| d.join("approved_domains.json"))
}

fn read_persisted_web_auth_domains(agent_id: &str) -> Vec<String> {
    let Some(path) = web_auth_domains_path(agent_id) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_default()
}

/// Persists `domain` to the agent's approved-forever list. Called only when the user
/// picks "Always for this agent" in the permission-request modal.
pub fn approve_web_auth_domain_forever(agent_id: &str, domain: &str) -> Result<(), String> {
    let dir = web_auth_dir(agent_id).ok_or_else(|| "could not resolve app data directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut domains = read_persisted_web_auth_domains(agent_id);
    if !domains.iter().any(|d| d == domain) {
        domains.push(domain.to_string());
    }
    std::fs::write(
        web_auth_domains_path(agent_id).unwrap(),
        serde_json::to_string_pretty(&domains).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

pub fn revoke_web_auth_domain(agent_id: &str, domain: &str) -> Result<(), String> {
    let dir = web_auth_dir(agent_id).ok_or_else(|| "could not resolve app data directory".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut domains = read_persisted_web_auth_domains(agent_id);
    domains.retain(|d| d != domain);
    std::fs::write(
        web_auth_domains_path(agent_id).unwrap(),
        serde_json::to_string_pretty(&domains).unwrap_or_default(),
    )
    .map_err(|e| e.to_string())
}

pub fn list_web_auth_domains(agent_id: &str) -> Vec<String> {
    read_persisted_web_auth_domains(agent_id)
}

lazy_static::lazy_static! {
    /// "Once" and "session" grants — deliberately not distinguished (both cleared only on
    /// app restart). A true single-use grant would need to be consumed atomically by the
    /// one fetch it authorizes, which risks stranding the agent if that fetch fails for an
    /// unrelated reason (network blip) and it has to ask the user to approve twice. Given
    /// the interactive-approval step already dominates the cost of granting access at all,
    /// this simplification is an accepted, disclosed scope reduction rather than a bug.
    static ref TEMP_WEB_AUTH_GRANTS: std::sync::Mutex<std::collections::HashSet<(String, String)>> =
        std::sync::Mutex::new(std::collections::HashSet::new());
}

pub fn grant_temporary_web_auth(agent_id: &str, domain: &str) {
    if let Ok(mut grants) = TEMP_WEB_AUTH_GRANTS.lock() {
        grants.insert((agent_id.to_string(), domain.to_string()));
    }
}

pub fn is_web_auth_domain_approved(agent_id: &str, domain: &str) -> bool {
    read_persisted_web_auth_domains(agent_id).iter().any(|d| d == domain)
        || TEMP_WEB_AUTH_GRANTS
            .lock()
            .map(|g| g.contains(&(agent_id.to_string(), domain.to_string())))
            .unwrap_or(false)
}

pub async fn fetch_authenticated_page_impl(url_str: &str, agent_id: &str) -> Result<PageContent, String> {
    let parsed =
        url::Url::parse(url_str.trim()).map_err(|_| format!("'{url_str}' is not a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http:// and https:// URLs are supported".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?
        .to_string();
    if is_private_or_local(&host) {
        return Err(format!("refusing to fetch local/private address '{host}'"));
    }
    if let Some(blocked) = blocklisted_domain(&host) {
        return Err(format!(
            "'{host}' matches the fixed fetch blocklist ({blocked}) and cannot be auto-fetched, \
             authenticated or not — no permission grant overrides this"
        ));
    }
    if !is_web_auth_domain_approved(agent_id, &host) {
        return Err(format!(
            "not approved for authenticated access to '{host}' yet — POST /request_permission with \
             permission_id \"webauth:{host}\" and a justification first. The user will be asked to \
             allow once, always for this agent, or deny before any cookies are touched; no cookies \
             are read until that grant lands."
        ));
    }

    let cookies = crate::chrome_cookies::read_cookies_for_host(&host)?;
    let cookie_header = crate::chrome_cookies::cookie_header(&cookies);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("could not build HTTP client: {e}"))?;

    let resp = client
        .get(parsed.clone())
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|e| format!("authenticated fetch failed: {e}"))?;

    let final_url = resp.url().to_string();
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("server returned HTTP {} for {}", status.as_u16(), url_str));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("could not read response body: {e}"))?;
    let (title, text) = extract_title_and_text(&html);
    let links = extract_links(&html, &parsed);
    let (capped, truncated) = cap_text(text, MAX_TEXT_CHARS);
    Ok(PageContent {
        title,
        requested_url: url_str.to_string(),
        final_url,
        text: capped,
        links,
        rendered_via_browser: false,
        truncated,
    })
}

// ─── Shared CDP action primitives (Tier 5 sandboxed browser + Tier 6 real Chrome) ──
//
// Both browser_manager.rs's sandboxed-browser commands and the Tier 6 commands below
// act on a page-level (or single-target "browser") CDP WebSocket the same way — connect,
// issue one or two protocol calls, done. Kept here as `pub(crate)` so browser_manager.rs
// calls the same primitives instead of re-implementing raw CDP JSON a second time.

pub(crate) async fn cdp_navigate(ws_url: &str, url: &str) -> Result<(), String> {
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(CDP_CONNECT_TIMEOUT_SECS),
        tokio_tungstenite::connect_async(ws_url),
    )
    .await
    .map_err(|_| "timed out connecting to Chrome".to_string())?
    .map_err(|e| format!("could not connect to Chrome: {e}"))?;
    cdp_call(&mut ws, 1, "Page.enable", serde_json::json!({})).await?;
    cdp_call(&mut ws, 2, "Page.navigate", serde_json::json!({ "url": url })).await?;
    Ok(())
}

pub(crate) async fn cdp_get_content(ws_url: &str) -> Result<(String, String), String> {
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(CDP_CONNECT_TIMEOUT_SECS),
        tokio_tungstenite::connect_async(ws_url),
    )
    .await
    .map_err(|_| "timed out connecting to Chrome".to_string())?
    .map_err(|e| format!("could not connect to Chrome: {e}"))?;
    let result = cdp_call(
        &mut ws,
        1,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": "JSON.stringify({title: document.title, text: (document.body ? document.body.innerText : '')})",
            "returnByValue": true
        }),
    )
    .await?;
    let raw = result
        .pointer("/result/value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Chrome returned no page data".to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("could not parse page data: {e}"))?;
    Ok((
        parsed.get("title").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        parsed.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
    ))
}

pub(crate) async fn cdp_click(ws_url: &str, selector: &str) -> Result<(), String> {
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(CDP_CONNECT_TIMEOUT_SECS),
        tokio_tungstenite::connect_async(ws_url),
    )
    .await
    .map_err(|_| "timed out connecting to Chrome".to_string())?
    .map_err(|e| format!("could not connect to Chrome: {e}"))?;
    let selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    let expr = format!(
        "(() => {{ const el = document.querySelector({selector_json}); if (!el) return null; \
         el.scrollIntoView({{block:'center', inline:'center'}}); const r = el.getBoundingClientRect(); \
         return JSON.stringify({{x: r.x + r.width/2, y: r.y + r.height/2}}); }})()"
    );
    let result = cdp_call(
        &mut ws,
        1,
        "Runtime.evaluate",
        serde_json::json!({ "expression": expr, "returnByValue": true }),
    )
    .await?;
    let raw = result
        .pointer("/result/value")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("no element matched selector '{selector}'"))?;
    let point: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("could not parse element position: {e}"))?;
    let x = point.get("x").and_then(|v| v.as_f64()).ok_or_else(|| "missing x".to_string())?;
    let y = point.get("y").and_then(|v| v.as_f64()).ok_or_else(|| "missing y".to_string())?;
    cdp_call(
        &mut ws,
        2,
        "Input.dispatchMouseEvent",
        serde_json::json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 }),
    )
    .await?;
    cdp_call(
        &mut ws,
        3,
        "Input.dispatchMouseEvent",
        serde_json::json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 }),
    )
    .await?;
    Ok(())
}

pub(crate) async fn cdp_type(ws_url: &str, selector: &str, text: &str) -> Result<(), String> {
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(CDP_CONNECT_TIMEOUT_SECS),
        tokio_tungstenite::connect_async(ws_url),
    )
    .await
    .map_err(|_| "timed out connecting to Chrome".to_string())?
    .map_err(|e| format!("could not connect to Chrome: {e}"))?;
    let selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    let expr = format!(
        "(() => {{ const el = document.querySelector({selector_json}); if (!el) return false; \
         el.focus(); return true; }})()"
    );
    let result = cdp_call(
        &mut ws,
        1,
        "Runtime.evaluate",
        serde_json::json!({ "expression": expr, "returnByValue": true }),
    )
    .await?;
    if result.pointer("/result/value").and_then(|v| v.as_bool()) != Some(true) {
        return Err(format!("no element matched selector '{selector}'"));
    }
    cdp_call(&mut ws, 2, "Input.insertText", serde_json::json!({ "text": text })).await?;
    Ok(())
}

pub(crate) async fn cdp_screenshot(ws_url: &str) -> Result<String, String> {
    let (mut ws, _) = tokio::time::timeout(
        Duration::from_secs(CDP_CONNECT_TIMEOUT_SECS),
        tokio_tungstenite::connect_async(ws_url),
    )
    .await
    .map_err(|_| "timed out connecting to Chrome".to_string())?
    .map_err(|e| format!("could not connect to Chrome: {e}"))?;
    let result = cdp_call(&mut ws, 1, "Page.captureScreenshot", serde_json::json!({ "format": "png" })).await?;
    result
        .get("data")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Chrome did not return screenshot data".to_string())
}

/// Tier 5 (agent-owned sandboxed Chromium) is implemented in `browser_manager.rs` —
/// `BrowserManager::start_sandbox_browser`/`stop_sandbox_browser` and the
/// `launch_agent_browser`/`close_agent_browser`/`agent_browser_*` Tauri commands there —
/// because it needs the same Chrome-process lifecycle management (spawn, reap, profile
/// prep, DevTools-URL parsing) `BrowserManager` already owns for the shared/isolated
/// automation browser. Extending that file avoids a second, competing "who owns this
/// Chrome process" authority; see the module doc comment there for the full design.

// ─── Tier 6: full live CDP control of the user's real Chrome ────────────────────
//
// Unlike Tier 5, Canopy does not launch this Chrome — the user already has one running
// (their everyday browser, real fingerprint, real logins) and exposes it via
// `--remote-debugging-port` (configurable, default 9222 — Chrome's own convention).
// Every action, including reads, requires a fresh per-call user confirmation (see
// `request_chrome_control_confirmation` below) — this is deliberately NOT a one-time
// capability grant like the rest of this file's permission model, because a single
// approval to "control the user's real browser" would be a blank check.

fn require_browser_control(agent: &crate::models::Agent) -> Result<(), String> {
    if !agent.capabilities.browser_control {
        return Err(
            "this agent does not have the Full Chrome Control (browser_control) capability enabled"
                .to_string(),
        );
    }
    Ok(())
}

const DEFAULT_CHROME_DEBUG_PORT: u16 = 9222;
const CHROME_DISCOVERY_TIMEOUT_SECS: u64 = 3;
const CHROME_CONTROL_CONFIRMATION_TIMEOUT_SECS: u64 = 120;

/// Configurable per the task spec ("uses a configurable port (default 9222)"). No
/// Settings UI field exists yet for this — TODO(web-tools-tier6-settings): add one:
/// for now it's an env var override so it's genuinely configurable rather than a
/// hardcoded constant, without inventing a new Settings section in this pass.
fn chrome_debug_port() -> u16 {
    std::env::var("CANOPY_CHROME_DEBUG_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_CHROME_DEBUG_PORT)
}

fn chrome_not_reachable_error(port: u16) -> String {
    format!(
        "Could not reach Chrome's remote debugging port {port}. Full Chrome Control (Tier 6) needs your \
         actual Chrome running with remote debugging enabled — quit Chrome completely, then relaunch it \
         with:\n\n  open -a \"Google Chrome\" --args --remote-debugging-port={port}\n\nThis only opens a \
         port on localhost; nothing outside this Mac can reach it. If you use a different port, set the \
         CANOPY_CHROME_DEBUG_PORT environment variable to match before starting Canopy."
    )
}

async fn chrome_version_info(port: u16) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CHROME_DISCOVERY_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await
        .map_err(|_| chrome_not_reachable_error(port))?;
    if !resp.status().is_success() {
        return Err(chrome_not_reachable_error(port));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Chrome responded but sent invalid JSON: {e}"))
}

#[derive(Debug, Clone)]
struct ChromeTarget {
    url: String,
    ws_url: String,
}

async fn list_chrome_targets(port: u16) -> Result<Vec<ChromeTarget>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CHROME_DISCOVERY_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let raw = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await
        .map_err(|_| chrome_not_reachable_error(port))?
        .json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| format!("Chrome responded but sent an invalid target list: {e}"))?;
    Ok(raw
        .into_iter()
        .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        .filter_map(|t| {
            Some(ChromeTarget {
                url: t.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                ws_url: t.get("webSocketDebuggerUrl")?.as_str()?.to_string(),
            })
        })
        .collect())
}

/// The tab Tier 6 acts on: the first real (non-devtools/chrome-internal) page target, or
/// a newly opened one at `fallback_url` if none exists yet.
async fn active_or_new_chrome_target(port: u16, fallback_url: &str) -> Result<ChromeTarget, String> {
    let targets = list_chrome_targets(port).await?;
    if let Some(t) = targets
        .into_iter()
        .find(|t| !t.url.starts_with("devtools://") && !t.url.starts_with("chrome://"))
    {
        return Ok(t);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let created = client
        .put(format!(
            "http://127.0.0.1:{port}/json/new?{}",
            urlencoding::encode(fallback_url)
        ))
        .send()
        .await
        .map_err(|e| format!("could not open a new Chrome tab: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Chrome returned an invalid response creating a tab: {e}"))?;
    let ws_url = created
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Chrome did not return a debugger URL for the new tab".to_string())?
        .to_string();
    Ok(ChromeTarget {
        url: created.get("url").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        ws_url,
    })
}

lazy_static::lazy_static! {
    static ref PENDING_CHROME_CONTROL_CONFIRMATIONS: std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<bool>>>> =
        std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
}

/// Blocks (up to `CHROME_CONTROL_CONFIRMATION_TIMEOUT_SECS`) waiting for the user to
/// approve or deny one Tier 6 action via the frontend's confirmation sheet. A timeout,
/// a dropped channel, or an explicit deny all resolve to `false` — silence is never
/// treated as approval.
async fn request_chrome_control_confirmation(
    app_handle: &tauri::AppHandle,
    agent_id: &str,
    action_description: &str,
) -> Result<bool, String> {
    use tauri::Emitter;
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    {
        let mut pending = PENDING_CHROME_CONTROL_CONFIRMATIONS.lock().await;
        pending.insert(request_id.clone(), tx);
    }
    let _ = app_handle.emit(
        "agent_chrome_control_confirmation_requested",
        serde_json::json!({
            "request_id": request_id,
            "agent_id": agent_id,
            "action_description": action_description,
        }),
    );
    let approved = tokio::time::timeout(Duration::from_secs(CHROME_CONTROL_CONFIRMATION_TIMEOUT_SECS), rx)
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(false);
    if !approved {
        PENDING_CHROME_CONTROL_CONFIRMATIONS.lock().await.remove(&request_id);
    }
    Ok(approved)
}

/// Frontend resolves a pending Tier 6 action-confirmation sheet with allow/deny.
#[tauri::command]
pub async fn resolve_chrome_control_confirmation(request_id: String, approved: bool) -> Result<(), String> {
    let mut pending = PENDING_CHROME_CONTROL_CONFIRMATIONS.lock().await;
    if let Some(tx) = pending.remove(&request_id) {
        let _ = tx.send(approved);
    }
    Ok(())
}

async fn require_browser_control_and_reachable(
    db: &tauri::State<'_, crate::db::Database>,
    agent_id: &str,
) -> Result<(crate::models::Agent, u16), String> {
    let agent = db
        .get_agent(agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "agent not found".to_string())?;
    require_browser_control(&agent)?;
    let port = chrome_debug_port();
    chrome_version_info(port).await?;
    Ok((agent, port))
}

// ─── Tauri commands (Canopy frontend surface) ────────────────────────────────────

#[tauri::command]
pub async fn web_search(query: String, num_results: Option<u32>) -> Result<Vec<SearchResult>, String> {
    web_search_impl(&query, num_results.unwrap_or(10)).await
}

#[tauri::command]
pub async fn fetch_page(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    browser_manager: tauri::State<'_, crate::browser_manager::BrowserManager>,
    url: String,
    agent_id: String,
) -> Result<PageContent, String> {
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "agent not found".to_string())?;
    if !agent.capabilities.web_browse {
        return Err("this agent does not have the Web Browse capability enabled".to_string());
    }
    fetch_page_impl(&app_handle, &browser_manager, &agent, true, &url).await
}

#[tauri::command]
pub async fn fetch_authenticated_page(
    db: tauri::State<'_, crate::db::Database>,
    url: String,
    agent_id: String,
) -> Result<PageContent, String> {
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "agent not found".to_string())?;
    if !agent.capabilities.web_auth {
        return Err("this agent does not have the Authenticated Browsing (web_auth) capability enabled".to_string());
    }
    fetch_authenticated_page_impl(&url, &agent_id).await
}

#[tauri::command]
pub fn list_web_auth_approved_domains(agent_id: String) -> Result<Vec<String>, String> {
    Ok(list_web_auth_domains(&agent_id))
}

#[tauri::command]
pub fn revoke_web_auth_approved_domain(agent_id: String, domain: String) -> Result<(), String> {
    revoke_web_auth_domain(&agent_id, &domain)
}

#[tauri::command]
pub async fn chrome_navigate(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    url: String,
) -> Result<(), String> {
    let (_, port) = require_browser_control_and_reachable(&db, &agent_id).await?;
    let parsed = url::Url::parse(url.trim()).map_err(|_| format!("'{url}' is not a valid URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http:// and https:// URLs are supported".to_string());
    }
    if !request_chrome_control_confirmation(&app_handle, &agent_id, &format!("navigate your Chrome to {url}")).await? {
        return Err("the user denied this Chrome control action".to_string());
    }
    let target = active_or_new_chrome_target(port, &url).await?;
    cdp_navigate(&target.ws_url, &url).await
}

#[tauri::command]
pub async fn chrome_click(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    selector: String,
) -> Result<(), String> {
    let (_, port) = require_browser_control_and_reachable(&db, &agent_id).await?;
    let target = active_or_new_chrome_target(port, "about:blank").await?;
    if let Some(blocked) = target_blocklist_hit(&target) {
        return Err(blocked);
    }
    if !request_chrome_control_confirmation(
        &app_handle,
        &agent_id,
        &format!("click \"{selector}\" on {}", target.url),
    )
    .await?
    {
        return Err("the user denied this Chrome control action".to_string());
    }
    cdp_click(&target.ws_url, &selector).await
}

#[tauri::command]
pub async fn chrome_type(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
    selector: String,
    text: String,
) -> Result<(), String> {
    let (_, port) = require_browser_control_and_reachable(&db, &agent_id).await?;
    let target = active_or_new_chrome_target(port, "about:blank").await?;
    if let Some(blocked) = target_blocklist_hit(&target) {
        return Err(blocked);
    }
    if !request_chrome_control_confirmation(
        &app_handle,
        &agent_id,
        &format!("type into \"{selector}\" on {}", target.url),
    )
    .await?
    {
        return Err("the user denied this Chrome control action".to_string());
    }
    cdp_type(&target.ws_url, &selector, &text).await
}

#[tauri::command]
pub async fn chrome_get_content(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<String, String> {
    let (_, port) = require_browser_control_and_reachable(&db, &agent_id).await?;
    let target = active_or_new_chrome_target(port, "about:blank").await?;
    if !request_chrome_control_confirmation(&app_handle, &agent_id, &format!("read the page content of {}", target.url)).await? {
        return Err("the user denied this Chrome control action".to_string());
    }
    let (title, text) = cdp_get_content(&target.ws_url).await?;
    Ok(serde_json::json!({ "title": title, "url": target.url, "text": text }).to_string())
}

#[tauri::command]
pub async fn chrome_screenshot(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    agent_id: String,
) -> Result<String, String> {
    let (_, port) = require_browser_control_and_reachable(&db, &agent_id).await?;
    let target = active_or_new_chrome_target(port, "about:blank").await?;
    if !request_chrome_control_confirmation(&app_handle, &agent_id, &format!("take a screenshot of {}", target.url)).await? {
        return Err("the user denied this Chrome control action".to_string());
    }
    cdp_screenshot(&target.ws_url).await
}

/// Financial-transaction pages are read-only even with `browser_control` enabled — this
/// gates `chrome_click`/`chrome_type` only, never `chrome_get_content`/`chrome_screenshot`.
fn target_blocklist_hit(target: &ChromeTarget) -> Option<String> {
    let host = url::Url::parse(&target.url).ok()?.host_str()?.to_string();
    let blocked = blocklisted_domain(&host)?;
    Some(format!(
        "'{host}' matches the fixed fetch blocklist ({blocked}, a financial/medical portal) — click/type \
         is refused on this page even with browser_control enabled. You may still read it."
    ))
}

#[tauri::command]
pub async fn research(
    app_handle: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    browser_manager: tauri::State<'_, crate::browser_manager::BrowserManager>,
    topic: String,
    depth: u8,
    agent_id: String,
) -> Result<ResearchPacket, String> {
    let agent = db
        .get_agent(&agent_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "agent not found".to_string())?;
    if !agent.capabilities.web_search {
        return Err("this agent does not have the Web Search capability enabled".to_string());
    }
    research_impl(
        &app_handle,
        &browser_manager,
        &agent,
        agent.capabilities.web_browse,
        &topic,
        depth,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_known_financial_and_medical_domains() {
        assert_eq!(blocklisted_domain("chase.com"), Some("chase.com"));
        assert_eq!(blocklisted_domain("www.chase.com"), Some("chase.com"));
        assert_eq!(blocklisted_domain("login.paypal.com"), Some("paypal.com"));
        assert_eq!(blocklisted_domain("example.com"), None);
        // Must not false-positive on unrelated domains that merely contain a blocked one.
        assert_eq!(blocklisted_domain("notchase.com"), None);
    }

    #[test]
    fn blocks_private_and_loopback_hosts() {
        assert!(is_private_or_local("localhost"));
        assert!(is_private_or_local("127.0.0.1"));
        assert!(is_private_or_local("192.168.1.5"));
        assert!(is_private_or_local("10.0.0.5"));
        assert!(is_private_or_local("172.16.0.5"));
        assert!(is_private_or_local("169.254.1.1"));
        assert!(is_private_or_local("::1"));
        assert!(is_private_or_local("service.local"));
        assert!(!is_private_or_local("example.com"));
        assert!(!is_private_or_local("8.8.8.8"));
    }

    #[test]
    fn detects_js_rendered_shells() {
        assert!(looks_js_rendered("<html><body><div id=\"root\"></div></body></html>", ""));
        assert!(looks_js_rendered(
            "<html><body>Please enable JavaScript to view this site.</body></html>",
            "Please enable JavaScript to view this site."
        ));
        let long_text = "word ".repeat(60);
        assert!(!looks_js_rendered("<html></html>", &long_text));
    }

    #[test]
    fn caps_text_and_reports_truncation() {
        let (short, truncated) = cap_text("hello".to_string(), 10);
        assert_eq!(short, "hello");
        assert!(!truncated);

        let (capped, truncated) = cap_text("a".repeat(100), 10);
        assert_eq!(capped.chars().count(), 10);
        assert!(truncated);
    }

    #[test]
    fn extracts_title_and_readable_text() {
        let html = "<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>World</p></body></html>";
        let (title, text) = extract_title_and_text(html);
        assert_eq!(title, "Test Page");
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
    }

    #[test]
    fn resolves_relative_links_against_base() {
        let base = url::Url::parse("https://example.com/blog/post").unwrap();
        let html = r#"<html><body><a href="/about">About</a><a href="next">Next</a><a href="javascript:void(0)">JS</a></body></html>"#;
        let links = extract_links(html, &base);
        assert!(links.contains(&"https://example.com/about".to_string()));
        assert!(links.contains(&"https://example.com/blog/next".to_string()));
        assert!(!links.iter().any(|l| l.starts_with("javascript:")));
    }

    #[test]
    fn duckduckgo_related_topics_recurse_into_categories() {
        let topics = serde_json::json!([
            { "Text": "Rust (language) - a systems language", "FirstURL": "https://duckduckgo.com/Rust" },
            {
                "Name": "See also",
                "Topics": [
                    { "Text": "Rust (disambiguation)", "FirstURL": "https://duckduckgo.com/Rust_(disambiguation)" }
                ]
            }
        ]);
        let mut out = Vec::new();
        collect_related_topics(topics.as_array().unwrap(), &mut out, 10);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].title, "Rust (language)");
        assert_eq!(out[1].url, "https://duckduckgo.com/Rust_(disambiguation)");
    }

    #[test]
    fn tier6_click_type_are_refused_on_blocklisted_pages_but_read_stays_allowed() {
        let blocked = ChromeTarget {
            url: "https://www.chase.com/login".to_string(),
            ws_url: "ws://127.0.0.1:9222/devtools/page/abc".to_string(),
        };
        let hit = target_blocklist_hit(&blocked);
        assert!(hit.is_some());
        assert!(hit.unwrap().contains("chase.com"));

        let safe = ChromeTarget {
            url: "https://example.com/docs".to_string(),
            ws_url: "ws://127.0.0.1:9222/devtools/page/def".to_string(),
        };
        assert!(target_blocklist_hit(&safe).is_none());
    }

    #[test]
    fn chrome_not_reachable_error_names_the_port_and_the_fix() {
        let msg = chrome_not_reachable_error(9222);
        assert!(msg.contains("9222"));
        assert!(msg.contains("--remote-debugging-port=9222"));
    }
}
