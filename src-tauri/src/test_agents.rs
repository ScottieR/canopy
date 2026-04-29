use crate::db::Database;
use std::sync::Mutex;

pub fn print_agents(db: &Database) {
    let agents = db.list_agents().unwrap();
    for agent in agents {
        println!("Agent ID: {}", agent.id);
        println!("  Paused: {}", agent.paused);
        println!("  VI: {:?}", agent.visual_identity);
    }
}
