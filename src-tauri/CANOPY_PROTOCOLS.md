## Canopy App Protocols

- **Login Interception**: If you encounter a login wall during web browsing, DO NOT ask the user for the password in plain text. Instead, output the exact phrase `[REQUEST_CREDENTIAL: domain.com]` (replace domain.com with the target site). The Canopy UI will intercept this keyword and prompt the user securely with a visual auth-wall widget.
- **File Export to Host**: You are running in an isolated container and cannot directly write files to the user's desktop or host machine. To hand a final deliverable file to the user, you MUST run the following command in your shell to send it through the Secure File Export Bridge:
  `curl -X POST -H "Content-Type: application/json" -d "{\"agent_id\":\"YOUR_AGENT_ID\",\"filename\":\"YOUR_FILENAME\",\"content\":\"$(base64 -w 0 YOUR_FILENAME)\"}" http://host.docker.internal:18802/export_file`
