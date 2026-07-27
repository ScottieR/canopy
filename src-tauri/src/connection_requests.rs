use std::collections::BTreeMap;

const REQUEST_CONNECTION_PREFIX: &str = "[request_connection:";
const CANOPY_COMPANION_DEEP_LINK_HOST: &str = "companion";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionRequestTag {
    pub full_match: String,
    pub companion_type: String,
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalConnectionPrompt {
    pub companion_type: String,
    pub params: BTreeMap<String, String>,
    pub body_text: String,
    pub button_text: String,
    pub deep_link_url: String,
    pub plain_text_message: String,
}

pub fn parse_connection_request_tag(text: &str) -> Option<ConnectionRequestTag> {
    let lowercase = text.to_ascii_lowercase();
    let start = lowercase.find(REQUEST_CONNECTION_PREFIX)?;
    let payload_start = start + REQUEST_CONNECTION_PREFIX.len();
    let closing = text[payload_start..].find(']')? + payload_start;
    let full_match = text[start..=closing].to_string();
    let payload = text[payload_start..closing].trim();

    let (raw_companion_type, raw_query) = payload.split_once('?').unwrap_or((payload, ""));
    let companion_type = raw_companion_type.trim().to_ascii_lowercase();
    if companion_type.is_empty() {
        return None;
    }

    let params = url::form_urlencoded::parse(raw_query.as_bytes())
        .into_owned()
        .collect::<BTreeMap<String, String>>();

    Some(ConnectionRequestTag {
        full_match,
        companion_type,
        params,
    })
}

pub fn build_companion_deep_link(
    companion_type: &str,
    agent_id: &str,
    agent_name: Option<&str>,
    params: &BTreeMap<String, String>,
) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("companion", &companion_type.trim().to_ascii_lowercase());
    serializer.append_pair("agentId", agent_id);
    if let Some(name) = agent_name.filter(|value| !value.trim().is_empty()) {
        serializer.append_pair("agentName", name);
    }
    for (key, value) in params {
        serializer.append_pair(key, value);
    }

    format!(
        "canopy://{}?{}",
        CANOPY_COMPANION_DEEP_LINK_HOST,
        serializer.finish()
    )
}

pub fn build_external_connection_prompt(
    text: &str,
    agent_id: &str,
    agent_name: Option<&str>,
) -> Option<ExternalConnectionPrompt> {
    let request = parse_connection_request_tag(text)?;
    let body_text = strip_request_tag(text, &request.full_match);
    let display_name = connection_display_name(&request.companion_type, &request.params);
    let button_text = match request.params.get("providerName").map(String::as_str) {
        Some(provider_name) if !provider_name.trim().is_empty() => {
            format!("Connect {}", provider_name.trim())
        }
        _ => format!("Open {}", display_name),
    };
    let deep_link_url = build_companion_deep_link(
        &request.companion_type,
        agent_id,
        agent_name,
        &request.params,
    );
    let body_text = if body_text.is_empty() {
        format!("I need you to finish the {} setup in Canopy.", display_name)
    } else {
        body_text
    };
    let plain_text_message = format!("{body_text}\n\nOpen in Canopy: {deep_link_url}");

    Some(ExternalConnectionPrompt {
        companion_type: request.companion_type,
        params: request.params,
        body_text,
        button_text,
        deep_link_url,
        plain_text_message,
    })
}

fn strip_request_tag(text: &str, full_match: &str) -> String {
    text.replacen(full_match, "", 1).trim().to_string()
}

fn connection_display_name(
    companion_type: &str,
    params: &BTreeMap<String, String>,
) -> String {
    if let Some(provider_name) = params.get("providerName").map(String::as_str) {
        if !provider_name.trim().is_empty() {
            return provider_name.trim().to_string();
        }
    }

    companion_type
        .split('_')
        .filter(|part| !part.is_empty())
        .map(title_case_word)
        .collect::<Vec<String>>()
        .join(" ")
}

fn title_case_word(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_request_connection_tags() {
        let parsed = parse_connection_request_tag(
            "Please connect this [request_connection: custom_oauth?providerName=Airbnb&scopes=reservations.read,reservations.write]",
        )
        .expect("expected request tag");

        assert_eq!(parsed.companion_type, "custom_oauth");
        assert_eq!(
            parsed.params.get("providerName").map(String::as_str),
            Some("Airbnb")
        );
        assert_eq!(
            parsed.params.get("scopes").map(String::as_str),
            Some("reservations.read,reservations.write")
        );
    }

    #[test]
    fn builds_companion_deep_links() {
        let mut params = BTreeMap::new();
        params.insert("providerName".to_string(), "Airbnb".to_string());
        params.insert(
            "scopes".to_string(),
            "reservations.read,reservations.write".to_string(),
        );

        let deep_link = build_companion_deep_link(
            "custom_oauth",
            "agent-1",
            Some("Bridge Bot"),
            &params,
        );

        assert_eq!(
            deep_link,
            "canopy://companion?companion=custom_oauth&agentId=agent-1&agentName=Bridge+Bot&providerName=Airbnb&scopes=reservations.read%2Creservations.write"
        );
    }

    #[test]
    fn builds_plain_text_fallbacks_for_external_channels() {
        let prompt = build_external_connection_prompt(
            "[request_connection: custom_oauth?providerName=Airbnb]",
            "agent-1",
            Some("Bridge Bot"),
        )
        .expect("expected external connection prompt");

        assert_eq!(prompt.button_text, "Connect Airbnb");
        assert!(prompt.body_text.contains("Airbnb setup"));
        assert!(prompt.plain_text_message.contains("canopy://companion?"));
    }
}
