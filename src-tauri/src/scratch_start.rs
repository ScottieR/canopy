use crate::docker::start_gateway;

#[tokio::main]
async fn main() {
    match crate::docker::start_gateway_internal(None).await {
        Ok(msg) => println!("SUCCESS: {}", msg),
        Err(e) => println!("ERROR: {}", e),
    }
}
