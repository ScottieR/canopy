import React, { useState } from 'react';

interface PasswordInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  rightAction?: React.ReactNode;
}

export function PasswordInput({ rightAction, style, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  
  // Ensure we extract height or padding to prevent collapsing layout bugs if needed.
  return (
    <div style={{ position: 'relative', width: style?.width || "100%", flex: style?.flex }}>
      <input 
        {...props} 
        style={{ ...style, width: "100%", paddingRight: rightAction ? 100 : 40 }}
        type={visible ? "text" : "password"} 
      />
      <div style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 4 }}>
        <button 
          type="button"
          onClick={() => setVisible(!visible)} 
          style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 14, opacity: 0.6, padding: 6, display: "flex", alignItems: "center", justifyContent: "center" }}
          title={visible ? "Hide token" : "Show token"}
        >
          {visible ? "👁️‍🗨️" : "👁️"}
        </button>
        {rightAction}
      </div>
    </div>
  );
}
