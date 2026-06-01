const fs = require('fs');
const file = 'src-tauri/src/models.rs';
let content = fs.readFileSync(file, 'utf8');

const newModels = `
// ─── Telemetry & Warnings ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageRecord {
    pub id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub model: String,
    pub provider: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemWarning {
    pub id: String,
    pub agent_id: String,
    pub timestamp: String,
    pub warning_type: String,
    pub message: String,
    pub resolved: bool,
}
`;

if (!content.includes('SystemWarning')) {
    content += newModels;
    fs.writeFileSync(file, content);
    console.log("Updated models.rs");
} else {
    console.log("models.rs already contains SystemWarning");
}
