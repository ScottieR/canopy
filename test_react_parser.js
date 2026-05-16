const msgText = `<think>The user is asking for a consolidated list.

### Creative
27. **Brainstorm**`;

let text = msgText.replace(/<think>/gi, "[THOUGHT_PROCESS]").replace(/<\/think>/gi, "[/THOUGHT_PROCESS]");

const elements = [];
const thoughtStartRegex = /\[THOUGHT_PROCESS\]/i;
const thoughtEndRegex = /\[\/THOUGHT_PROCESS\]/i;

let remainingText = text;
while (remainingText.length > 0) {
    const startIndex = remainingText.search(thoughtStartRegex);
    if (startIndex === -1) {
        if (remainingText.trim()) {
            elements.push(`[Markdown: ${remainingText}]`);
        }
        break;
    }
    
    const before = remainingText.substring(0, startIndex);
    if (before.trim()) {
        elements.push(`[Markdown: ${before}]`);
    }
    
    remainingText = remainingText.substring(startIndex + "[THOUGHT_PROCESS]".length);
    const endIndex = remainingText.search(thoughtEndRegex);
    let thoughtText = "";
    if (endIndex === -1) {
        let unclosed = remainingText.trim();
        const heuristicRegex = /\n\n(?=### |## |# |\*\*|- |\* |\d+\. |Here |I have |Sure)/i;
        const heuristicMatch = unclosed.match(heuristicRegex);
        
        if (heuristicMatch && heuristicMatch.index !== undefined) {
            thoughtText = unclosed.substring(0, heuristicMatch.index).trim();
            remainingText = unclosed.substring(heuristicMatch.index).trim();
        } else {
            thoughtText = unclosed;
            remainingText = "";
        }
    } else {
        thoughtText = remainingText.substring(0, endIndex).trim();
        remainingText = remainingText.substring(endIndex + "[/THOUGHT_PROCESS]".length);
    }
    
    if (thoughtText) {
        elements.push(`[Details: ${thoughtText}]`);
    }
}

console.log(elements.join("\n"));
