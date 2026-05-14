use reqwest::Client;

#[tokio::test]
async fn test_auth() {
    let client = Client::builder().build().unwrap();
    let res = client.post("https://slack.com/api/auth.test").send().await;
    println!("RES: {:?}", res);
}
