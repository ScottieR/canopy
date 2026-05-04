with open('src/App.tsx', 'r') as f:
    app_text = f.read()

app_text = app_text.replace('const glass = (', 'export const glass = (')
app_text = app_text.replace('function Tooltip(', 'export function Tooltip(')
app_text = app_text.replace('function ServiceRow(', 'export function ServiceRow(')
app_text = app_text.replace('function Toggle(', 'export function Toggle(')
app_text = app_text.replace('interface GenerativeResult', 'export interface GenerativeResult')

with open('src/App.tsx', 'w') as f:
    f.write(app_text)

print("Exported shared components and types from App.tsx.")
