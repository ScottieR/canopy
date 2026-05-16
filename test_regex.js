const text = `[THOUGHT_PROCESS] The user is asking for a consolidated list.

### Creative
27. **Brainstorm**`;

const thoughtStartRegex = /\[THOUGHT_PROCESS\]/i;
const thoughtEndRegex = /\[\/THOUGHT_PROCESS\]/i;

let remainingText = text;
const startIndex = remainingText.search(thoughtStartRegex);
remainingText = remainingText.substring(startIndex + "[THOUGHT_PROCESS]".length);
const endIndex = remainingText.search(thoughtEndRegex);

let thoughtText = "";
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

console.log("Thought text:", JSON.stringify(thoughtText));
console.log("Remaining text:", JSON.stringify(remainingText));
