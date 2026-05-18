use reqwest::Client;
use std::time::Duration;

#[tokio::test]
async fn test_auth_concurrent() {
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(5))
        .pool_idle_timeout(Duration::from_secs(15))
        .tcp_keepalive(Duration::from_secs(15))
        .pool_max_idle_per_host(8)
        .user_agent("canopy/slack")
        .build()
        .unwrap();

    let futures = (0..3).map(|_| {
        let c = client.clone();
        async move {
            let res = c.post("https://slack.com/api/auth.test").send().await;
            match res {
                Ok(r) => println!("Success: {:?}", r.status()),
                Err(e) => println!("Error: {}", e)
            }
        }
    });

    futures_util::future::join_all(futures).await;
}
