fn main() {
    let agent_id = "agent-atlas";
    let sessions_dir = dirs::data_dir()
        .map(|d| d.join("Canopy").join("openclaw-state").join("agents").join(&agent_id).join("sessions"))
        .unwrap();

    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                if let Ok(file) = std::fs::File::open(&path) {
                    let reader = std::io::BufReader::new(file);
                    use std::io::BufRead;
                    for line in reader.lines().flatten() {
                        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                            if json.get("type").and_then(|t| t.as_str()) == Some("message") {
                                let id = json.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                let ts_str = json.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                
                                if let Some(msg_obj) = json.get("message") {
                                    let role = msg_obj.get("role").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                    let mut final_content = String::new();
                                    if let Some(content_arr) = msg_obj.get("content").and_then(|v| v.as_array()) {
                                        for block in content_arr {
                                            if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                                                if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                                                    final_content.push_str(text);
                                                }
                                            }
                                        }
                                    }
                                    if !final_content.is_empty() {
                                        println!("Parsed msg {} [{}] length: {}", id, ts_str, final_content.len());
                                    } else {
                                        println!("EMPTY final_content for msg {}", id);
                                    }
                                } else {
                                    println!("NO message object for msg {}", id);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
