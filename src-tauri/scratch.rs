use reqwest::Client;

#[tokio::main]
async fn main() {
    let client = Client::builder().build().unwrap();
    let res = client.post("https://slack.com/api/auth.test").send().await;
    match res {
        Ok(r) => println!("Success: {:?}", r.status()),
        Err(e) => {
            println!("Error: {}", e);
            let mut source = std::error::Error::source(&e);
            while let Some(s) = source {
                println!("Caused by: {}", s);
                source = std::error::Error::source(s);
            }
        }
    }
}
