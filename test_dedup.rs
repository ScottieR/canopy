fn cleanup_agent_text(s: &str) -> String {
    if let Some(start) = s.find("<final>") {
        if let Some(end_offset) = s[start..].find("</final>") {
            let inside = s[start + 7 .. start + end_offset].trim();
            let mut outside_str = s.to_string();
            outside_str.replace_range(start .. start + end_offset + 8, "");
            let outside = outside_str.trim();
            
            if outside.is_empty() {
                return inside.to_string();
            }
            if inside.is_empty() {
                return outside.to_string();
            }
            
            // Calculate similarity (word overlap)
            let inside_words: std::collections::HashSet<&str> = inside.split_whitespace().collect();
            let outside_words: std::collections::HashSet<&str> = outside.split_whitespace().collect();
            
            let common_words = inside_words.intersection(&outside_words).count();
            let min_len = std::cmp::min(inside_words.len(), outside_words.len());
            
            if min_len > 0 && common_words as f64 / min_len as f64 > 0.5 {
                // They are similar, pick the longer one
                if outside.len() > inside.len() {
                    return outside.to_string();
                } else {
                    return inside.to_string();
                }
            } else {
                // Not similar, just strip the tags
                return s.replace("<final>", "").replace("</final>", "");
            }
        }
    }
    s.to_string()
}

fn main() {
    let s1 = "<final>Your updates are perfect. Is there anything else you need?</final>Your updates are perfect. This is fully ready to go live. Is there anything else you need?";
    let s2 = "Here is the final answer: <final>42</final>";
    println!("1: {}", cleanup_agent_text(s1));
    println!("2: {}", cleanup_agent_text(s2));
}
