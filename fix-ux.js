const fs = require('fs');

let code = fs.readFileSync('src/App.tsx', 'utf8');

const patches = [
  {
    regex: /\{step === 1 && \(\s*<div style=\{\{ maxWidth: 900, width: "90%", maxHeight: "90vh", overflow: "auto", padding: "20px 0" \}\}>([\s\S]*?)<div style=\{\{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 32 \}\}>/g,
    replace: `{step === 1 && (
        <div style={{ maxWidth: 900, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>$1<div style={{ display: "flex", gap: 16, justifyContent: "center", marginBottom: 32 }}>`
  },
  {
    regex: /<div style=\{\{ display: "flex", gap: 12, justifyContent: "center" \}\}>\s*<button onClick=\{\(\) => setStep\(0\)\} style=\{\{([\s\S]*?)<button onClick=\{\(\) => selectedRole === "Custom" \? setStep\(1\.5\) : setStep\(2\)\}([\s\S]*?)\}\}>Next<\/button>\s*<\/div>\s*<\/div>\s*\)/g,
    replace: `</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", padding: "20px 0", borderTop: "1px solid rgba(0,0,0,0.05)", marginTop: "auto", background: "#fbfbf9" }}>
            <button onClick={() => setStep(0)} style={{$1<button onClick={() => selectedRole === "Custom" ? setStep(1.5) : setStep(2)}$2}}>Next</button>
          </div>
        </div>
      )`
  },
  {
    regex: /\{step === 1\.8 && \(\s*<div style=\{\{ maxWidth: 700, width: "90%", maxHeight: "90vh", overflow: "auto" \}\}>([\s\S]*?)<h1 style=\{\{ fontSize: 40/g,
    replace: `{step === 1.8 && (
        <div style={{ maxWidth: 700, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>$1<h1 style={{ fontSize: 40`
  },
  {
    regex: /<div style=\{\{ display: "flex", gap: 12, justifyContent: "center" \}\}>\s*<button onClick=\{\(\) => setStep\(1\)\} style=\{\{ padding: "12px 28px", borderRadius: 12, background: "#f4f4f0", color: "#636E72", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" \}\}>Back<\/button>\s*<\/div>\s*<\/div>\s*\)/g,
    replace: `</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", padding: "20px 0", borderTop: "1px solid rgba(0,0,0,0.05)", marginTop: "auto", background: "#fbfbf9" }}>
            <button onClick={() => setStep(1)} style={{ padding: "12px 28px", borderRadius: 12, background: "#f4f4f0", color: "#636E72", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Back</button>
          </div>
        </div>
      )`
  },
  {
    regex: /\{step === 2 && \(\s*<div style=\{\{ maxWidth: 600, width: "90%", maxHeight: "90vh", overflow: "auto" \}\}>([\s\S]*?)<h1 style=\{\{ fontSize: 40/g,
    replace: `{step === 2 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>$1<h1 style={{ fontSize: 40`
  },
  {
    regex: /<div style=\{\{ display: "flex", gap: 12, justifyContent: "flex-end" \}\}>\s*<button onClick=\{\(\) => setStep\(1\)\} style=\{\{([\s\S]*?)<button onClick=\{\(\) => setStep\(3\)\} disabled=\{!agentName\.trim\(\)\} style=\{\{([\s\S]*?)\}\}>Next<\/button>\s*<\/div>\s*<\/div>\s*\)/g,
    replace: `</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", padding: "20px 0", borderTop: "1px solid rgba(0,0,0,0.05)", marginTop: "auto", background: "#fbfbf9" }}>
            <button onClick={() => setStep(1)} style={{$1<button onClick={() => setStep(3)} disabled={!agentName.trim()} style={{$2}}>Next</button>
          </div>
        </div>
      )`
  },
  {
    regex: /\{step === 3 && \(\s*<div style=\{\{ maxWidth: 600, width: "90%", maxHeight: "90vh", overflow: "auto" \}\}>([\s\S]*?)<h1 style=\{\{ fontSize: 40/g,
    replace: `{step === 3 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>$1<h1 style={{ fontSize: 40`
  },
  {
    regex: /<div style=\{\{ display: "flex", gap: 12, justifyContent: "flex-end" \}\}>\s*<button onClick=\{\(\) => setStep\(2\)\} style=\{\{([\s\S]*?)<button onClick=\{\(\) => setStep\(4\)\} style=\{\{([\s\S]*?)\}\}>Next<\/button>\s*<\/div>\s*<\/div>\s*\)/g,
    replace: `</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", padding: "20px 0", borderTop: "1px solid rgba(0,0,0,0.05)", marginTop: "auto", background: "#fbfbf9" }}>
            <button onClick={() => setStep(2)} style={{$1<button onClick={() => setStep(4)} style={{$2}}>Next</button>
          </div>
        </div>
      )`
  },
  {
    regex: /\{step === 4 && \(\s*<div style=\{\{ maxWidth: 600, width: "90%", maxHeight: "90vh", overflow: "auto" \}\}>([\s\S]*?)<h1 style=\{\{ fontSize: 40/g,
    replace: `{step === 4 && (
        <div style={{ maxWidth: 600, width: "90%", height: "90vh", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto", padding: "20px 0" }}>$1<h1 style={{ fontSize: 40`
  },
  {
    regex: /<div style=\{\{ display: "flex", gap: 12, justifyContent: "flex-end" \}\}>\s*<button onClick=\{\(\) => setStep\(3\)\} style=\{\{([\s\S]*?)<button onClick=\{\(\) => \{\s*if \(enabledPlugins\.length > 0\) \{\s*setTestPluginIndex\(0\);\s*setStep\(5\);\s*\} else \{\s*setStep\(6\);\s*\}\s*\}\} style=\{\{([\s\S]*?)\}\}>Next<\/button>\s*<\/div>\s*<\/div>\s*\)/g,
    replace: `</div>
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", padding: "20px 0", borderTop: "1px solid rgba(0,0,0,0.05)", marginTop: "auto", background: "#fbfbf9" }}>
            <button onClick={() => setStep(3)} style={{$1<button onClick={() => {
              if (enabledPlugins.length > 0) {
                setTestPluginIndex(0);
                setStep(5);
              } else {
                setStep(6);
              }
            }} style={{$2}}>Next</button>
          </div>
        </div>
      )`
  }
];

let newCode = code;
for (const patch of patches) {
  newCode = newCode.replace(patch.regex, patch.replace);
}

fs.writeFileSync('src/App.tsx', newCode);
console.log('Patched App.tsx for fixed footers');
