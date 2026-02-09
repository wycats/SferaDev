/**
 * Forensic Log Analysis Tool for Token Accounting
 * 
 * Reads ~/.vscode-ai-gateway/token-count-calls.jsonl and groups calls into "bursts"
 * to visualize the token budget seen by VS Code during provideTokenCount().
 * 
 * Usage: node scripts/analyze-forensic-logs.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const logPath = path.join(os.homedir(), '.vscode-ai-gateway', 'token-count-calls.jsonl');

if (!fs.existsSync(logPath)) {
    console.error(`Log file not found at ${logPath}`);
    console.error(`Please ensure forensic logging is enabled in provider.ts and you have generated some activity.`);
    process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim());
const entries = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
}).filter(e => e !== null);

// Group by "bursts" (approx 1 second windows)
// VS Code evaluates context in a tight loop.
const bursts = [];
let currentBurst = null;
let lastTs = 0;

entries.forEach(entry => {
    const ts = new Date(entry.ts).getTime();
    if (!currentBurst || ts - lastTs > 1500) { // 1.5s window
        currentBurst = {
            start: entry.ts,
            strings: [],
            messages: []
        };
        bursts.push(currentBurst);
    }
    
    if (entry.type === 'string') {
        currentBurst.strings.push(entry);
    } else {
        currentBurst.messages.push(entry);
    }
    lastTs = ts;
});

console.log(`Analyzing ${entries.length} log entries in ${bursts.length} evaluation bursts...`);

bursts.forEach((burst, index) => {
    const stringCount = burst.strings.length;
    const stringTokens = burst.strings.reduce((sum, e) => sum + e.estimate, 0);
    
    const messageCount = burst.messages.length;
    
    // Deduplication strategy for messages:
    // VS Code may call estimate on the same message object multiple times in a pass or across passes if they merge.
    // For a single snapshot, we assume unique messages by content hash approximation (role + preview).
    const uniqueMessages = new Map();
    burst.messages.forEach(m => {
        // Use a key that represents the content. 
        // Note: 'preview' is truncated, so this is imperfect but likely good enough for distinct user/bot turns.
        const key = `${m.role}:${m.preview.substring(0, 40)}`;
        uniqueMessages.set(key, m.estimate);
    });
    const messageTokensDeduped = Array.from(uniqueMessages.values()).reduce((a, b) => a + b, 0);

    const totalDeduped = stringTokens + messageTokensDeduped;

    if (totalDeduped > 100) { // Filter out tiny checks
        console.log(`\nBurst #${index + 1} at ${burst.start}`);
        console.log(`  Tools (Strings): ${stringCount} calls, ${stringTokens} tokens`);
        console.log(`  Messages:        ${uniqueMessages.size} unique (${messageCount} calls), ${messageTokensDeduped} tokens`);
        
        const limit = burst.strings[0]?.maxInput || burst.messages[0]?.maxInput || 128000;
        
        console.log(`  Total Usage:     ${totalDeduped} / ${limit}`);
        
        if (totalDeduped > limit) {
             console.log(`  🔴 OVER LIMIT by ${totalDeduped - limit} tokens`);
        } else {
             console.log(`  ✅ Remaining: ${limit - totalDeduped} tokens`);
        }
        
        console.log(`  Overhead Ratio:  ${(stringTokens / totalDeduped * 100).toFixed(1)}% tools`);
    }
});
