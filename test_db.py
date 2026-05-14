import sqlite3
import os

db_path = os.path.expanduser("~/Library/Messages/chat.db")
if not os.path.exists(db_path):
    print("No DB")
    exit(1)

try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c = conn.cursor()
    c.execute("SELECT chat_identifier, display_name FROM chat LIMIT 5;")
    print(c.fetchall())
except Exception as e:
    print(f"Error: {e}")
