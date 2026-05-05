fn main() {
    let mut vec = vec![1, 2, 3, 2, 1];
    vec.sort();
    vec.dedup_by(|a, b| a == b);
    println!("{:?}", vec);
}
