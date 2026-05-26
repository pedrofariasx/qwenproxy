export const TOOL_CALL_START = '<tool_call>';
export const TOOL_CALL_END = '</tool_call>';

export const TOOL_CALL_INSTRUCTION = `## TOOL CALLING FORMAT (COPY-PASTE PATTERN)

Each tool call is an independent block. Repeat the exact pattern below for EVERY tool you want to call.

### BLOCK PATTERN (copy this for each tool)

<tool_call>
{"name": "TOOL_NAME_HERE", "arguments": {"PARAM": "VALUE"}}
</tool_call>

### RULES

1. EVERY block starts with <tool_call> on its own line
2. EVERY block ends with </tool_call> on its own line
3. Inside: one JSON object with exactly "name" and "arguments" keys
4. Between blocks: NOTHING. No text, no commas, no extra lines.
5. After the last block: STOP. Wait for the tool results.

### EXAMPLE — Calling 3 tools

<tool_call>
{"name": "create_file", "arguments": {"path": "a.txt", "content": "Hello A"}}
</tool_call>
<tool_call>
{"name": "create_file", "arguments": {"path": "b.txt", "content": "Hello B"}}
</tool_call>
<tool_call>
{"name": "list_files", "arguments": {}}
</tool_call>

### COMMON MISTAKES (NEVER DO THIS)

Mistake 1 — Extra text before, after, or between blocks:
Let me call the tools.
<tool_call>...result...</tool_call>

Mistake 2 — Second tool missing opening tag:
<tool_call>
{"name": "tool1", ...}
</tool_call>
{"name": "tool2", ...}  <- MISSING <tool_call> HERE
</tool_call>

Mistake 3 — Second tool missing closing tag:
<tool_call>
{"name": "tool1", ...}
</tool_call>
<tool_call>
{"name": "tool2", ...}  <- MISSING </tool_call> HERE

Mistake 4 — JSON array inside one block:
<tool_call>
[{"name": "t1"}, {"name": "t2"}]
</tool_call>

Mistake 5 — No tags at all:
{"name": "tool1", ...} {"name": "tool2", ...}

Mistake 6 — Double opening tag (only ONE opening per block):
<tool_call >
<tool_call >
{"name": "tool1", ...}
</tool_call >
`;