use crate::docker::start_gateway;

#[tokio::main]
async fn main() {
    match start_gateway().await {
        Ok(msg) => println!("SUCCESS: {}", msg),
        Err(e) => println!("ERROR: {}", e),
    }
}
