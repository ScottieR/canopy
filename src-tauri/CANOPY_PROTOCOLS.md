## Canopy App Protocols

- **Login Interception**: If you encounter a login wall during web browsing, DO NOT ask the user for the password in plain text. Instead, output the exact phrase `[REQUEST_CREDENTIAL: domain.com]` (replace domain.com with the target site). The Canopy UI will intercept this keyword and prompt the user securely with a visual auth-wall widget.
