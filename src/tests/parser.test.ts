import assert from "node:assert";
import { test } from "node:test";
import { RetryableQwenStreamError } from "../services/qwen.ts";
import { StreamingToolParser } from "../tools/parser.ts";

test("StreamingToolParser: basic tool call", () => {
	const parser = new StreamingToolParser();
	const chunk1 = `Hello! <tool_call>{"name": "test_tool", "arguments": {"foo": "bar"}}</tool_call>`;
	const result = parser.feed(chunk1);

	assert.strictEqual(result.text, "Hello! ");
	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "test_tool");
	assert.deepStrictEqual(result.toolCalls[0].arguments, { foo: "bar" });
});

test("StreamingToolParser: fragmented tool call", () => {
	const parser = new StreamingToolParser();

	const res1 = parser.feed("Some text <tool_");
	assert.strictEqual(res1.text, "Some text ");
	assert.strictEqual(res1.toolCalls.length, 0);

	const res2 = parser.feed(`call>{"name": "fragmented", "arg`);
	assert.strictEqual(res2.text, "");
	assert.strictEqual(res2.toolCalls.length, 0);

	const res3 = parser.feed(`uments": {"ok": true}}</tool_call> Trailing text`);
	assert.strictEqual(res3.text, "");
	assert.strictEqual(res3.toolCalls.length, 1);
	assert.strictEqual(res3.toolCalls[0].name, "fragmented");
	assert.deepStrictEqual(res3.toolCalls[0].arguments, { ok: true });
});

test("StreamingToolParser: multiple tool calls", () => {
	const parser = new StreamingToolParser();
	const chunk = `<tool_call>{"name": "t1", "arguments": {}}</tool_call><tool_call>{"name": "t2", "arguments": {}}</tool_call>`;
	const result = parser.feed(chunk);

	assert.strictEqual(result.text, "");
	assert.strictEqual(result.toolCalls.length, 2);
	assert.strictEqual(result.toolCalls[0].name, "t1");
	assert.strictEqual(result.toolCalls[1].name, "t2");
});

test("StreamingToolParser: flush partial content", () => {
	const parser = new StreamingToolParser();
	const res1 = parser.feed("Unfinished text <tool_");
	assert.strictEqual(res1.text, "Unfinished text ");

	const res2 = parser.flush();
	assert.strictEqual(res2.text, "<tool_");
	assert.strictEqual(res2.toolCalls.length, 0);
});

test("StreamingToolParser: robust parsing in stream", () => {
	const parser = new StreamingToolParser();
	const result = parser.feed(
		`<tool_call>{"name": "broken", "arguments": {"a": 1}</tool_call>`,
	);

	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "broken");
	assert.deepStrictEqual(result.toolCalls[0].arguments, { a: 1 });
});

test("StreamingToolParser: Bengali delimiter basic", () => {
	const parser = new StreamingToolParser();
	const chunk = `Hello! তত{"name": "search", "arguments": {"query": "weather"}}✨ More text`;
	const result = parser.feed(chunk);

	assert.strictEqual(result.text, "Hello! ");
	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "search");
	assert.deepStrictEqual(result.toolCalls[0].arguments, { query: "weather" });
});

test("StreamingToolParser: Bengali delimiter fragmented", () => {
	const parser = new StreamingToolParser();

	const res1 = parser.feed(`Some text ${"তত".slice(0, 1)}`);
	assert.strictEqual(res1.toolCalls.length, 0);

	const res2 = parser.feed(`${"তত".slice(1)}{"name": "fragmented", "arg`);
	assert.strictEqual(res2.toolCalls.length, 0);

	const res3 = parser.feed('uments": {"ok": true}}✨ Trailing');
	assert.strictEqual(res3.toolCalls.length, 1);
	assert.strictEqual(res3.toolCalls[0].name, "fragmented");
});

test("StreamingToolParser: mixed XML and Bengali delimiters", () => {
	const parser = new StreamingToolParser();
	const chunk =
		'<tool_call>{"name": "xml_tool", "arguments": {}}</tool_call>তত{"name": "bengali_tool", "arguments": {}}✨';
	const result = parser.feed(chunk);

	assert.strictEqual(result.toolCalls.length, 2);
	assert.strictEqual(result.toolCalls[0].name, "xml_tool");
	assert.strictEqual(result.toolCalls[1].name, "bengali_tool");
});

test("StreamingToolParser: strips residual XML tags from tool JSON", () => {
	const parser = new StreamingToolParser();
	const S = Buffer.from("3c746f6f6c5f63616c6c3e", "hex").toString();
	const E = Buffer.from("3c2f746f6f6c5f63616c6c3e", "hex").toString();
	const chunk = `${S}<think_analyzing</think{"name": "read_file", "arguments": {"path": "/tmp/a.txt"}}${E}`;
	const result = parser.feed(chunk);

	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "read_file");
	assert.deepStrictEqual(result.toolCalls[0].arguments, { path: "/tmp/a.txt" });
});

test("StreamingToolParser: strips HTML entities from tool JSON", () => {
	const parser = new StreamingToolParser();
	const S = Buffer.from("3c746f6f6c5f63616c6c3e", "hex").toString();
	const E = Buffer.from("3c2f746f6f6c5f63616c6c3e", "hex").toString();
	const chunk = `${S}{"name": "search", "arguments": {"q": "foo&amp;bar"}}${E}`;
	const result = parser.feed(chunk);

	assert.strictEqual(result.toolCalls.length, 1);
	assert.strictEqual(result.toolCalls[0].name, "search");
	assert.strictEqual(
		(result.toolCalls[0].arguments as Record<string, unknown>).q,
		"foobar",
	);
});

test("RetryableQwenStreamError: properties", () => {
	const err = new RetryableQwenStreamError("chat is in progress", 3000);
	assert.strictEqual(err.name, "RetryableQwenStreamError");
	assert.strictEqual(err.message, "chat is in progress");
	assert.strictEqual(err.retryAfterMs, 3000);
	assert.ok(err instanceof Error);
});
