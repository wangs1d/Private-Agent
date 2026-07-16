// Round 2: handle additional patterns
// Case B: line ends with " (unterminated string) -> add "
// Case C: `...`" + delimiter (stray quote after template) -> remove "
const fs = require("fs");
const path = require("path");

const repoRoot = "E:\\ws-project\\Private-Agent";
const files = [
  "server/src/agent/agent-capabilities.ts",
  "server/src/agent/prompt-context-builder.ts",
  "server/src/services/agent-core.ts",
  "server/src/services/chat-turn-runner.ts",
  "server/src/services/intelligent-reminder/index.ts",
  "server/src/services/intelligent-reminder/voice-call-handler.ts",
  "server/src/services/voice-call-incoming-coordinator.ts",
  "server/src/services/voice-call-service.ts",
  "server/src/services/voice-capability-service.ts",
  "server/src/tools/agent-capability-query-tools.ts",
  "server/src/ws/connection.ts",
  "server/src/services/wechat-claw-bridge-service.ts",
];

let totalFixed = 0;

function countUnescapedQuotes(line) {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && i + 1 < line.length) {
      i++;
      continue;
    }
    if (line[i] === '"') {
      count++;
    }
  }
  return count;
}

for (const file of files) {
  const filepath = path.join(repoRoot, file);
  const content = fs.readFileSync(filepath, "utf8");
  const lines = content.split("\n");
  let fixed = 0;

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      return line;
    }

    // Case C: stray " after closing backtick
    // Pattern: `text`" followed by , ; ] ) } or end of line
    // The stray " is a literal " inside the file that opens an unterminated string
    if (/`"/.test(line)) {
      // Replace `" with ` only when the " is followed by delimiter/EOL
      // We want to remove the stray ", not add one
      const newLine = line.replace(/`"(?=[,;\])}]|$)/g, "`");
      if (newLine !== line) {
        fixed++;
        return newLine;
      }
    }

    // Count unescaped double quotes
    const count = countUnescapedQuotes(line);
    if (count % 2 === 0) return line;

    // Find the last unescaped quote
    let lastQuote = -1;
    for (let i = line.length - 1; i >= 0; i--) {
      if (line[i] === '"' && (i === 0 || line[i - 1] !== "\\")) {
        lastQuote = i;
        break;
      }
    }
    if (lastQuote === -1) return line;

    // Case B: line ends with " (no content after)
    if (lastQuote === line.length - 1) {
      fixed++;
      return line + '"';
    }

    // Case A: content after " followed by delimiter
    const after = line.substring(lastQuote + 1);
    const m = after.match(/^([\s\S]+?)([,;\])}])\s*$/);
    if (m) {
      fixed++;
      return line.substring(0, lastQuote) + '"' + m[1] + '"' + m[2];
    }

    // Case D: unterminated string content at end of line, no delimiter
    // The unterminated string consumes to end of line. Add closing " at EOL.
    if (lastQuote !== line.length - 1) {
      fixed++;
      return line + '"';
    }

    return line;
  });

  if (fixed > 0) {
    fs.writeFileSync(filepath, newLines.join("\n"));
    totalFixed += fixed;
    console.log(`Fixed ${fixed} lines in ${file}`);
  } else {
    console.log(`No fixes needed in ${file}`);
  }
}

console.log(`\nTotal fixed: ${totalFixed} lines`);
