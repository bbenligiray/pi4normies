import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_MESSAGE, renderMarkdown } from "../src/render.ts";

const html = (md: string) =>
	renderMarkdown(md)
		.map((c) => c.html)
		.join("\n\n");

test("inline formatting and escaping", () => {
	assert.equal(
		html("Some **bold <x>** and `a<b>&` and _it_ ~~del~~"),
		"Some <b>bold &lt;x&gt;</b> and <code>a&lt;b&gt;&amp;</code> and <i>it</i> <s>del</s>",
	);
	assert.equal(html("# Title & more"), "<b>Title &amp; more</b>");
	assert.equal(html("a \\*b\\*"), "a *b*");
});

test("links: only safe schemes, attributes escaped", () => {
	assert.equal(html('[x](https://a.com/?a=1&b="2")'), '<a href="https://a.com/?a=1&amp;b=&quot;2&quot;">x</a>');
	assert.equal(html("[x](javascript:alert(1))"), "x");
	assert.equal(html("![pic](https://a.com/p.png)"), '<a href="https://a.com/p.png">pic</a>');
});

test("lists, tasks and nesting", () => {
	assert.equal(html("- one\n- two\n  1. a\n  2. b"), "• one\n• two\n  1. a\n  2. b");
	assert.equal(html("- [ ] todo\n- [x] done"), "☐ todo\n☑ done");
	assert.equal(html("3. c\n4. d"), "3. c\n4. d");
});

test("code, quotes, tables", () => {
	assert.equal(html("```js\nif (a<b) {}\n```"), '<pre><code class="language-js">if (a&lt;b) {}</code></pre>');
	assert.equal(html("```\nplain\n```"), "<pre>plain</pre>");
	assert.equal(html("> quote **b**"), "<blockquote>quote <b>b</b></blockquote>");
	assert.equal(html("| a | bb |\n|---|---|\n| 1 | 2 |"), "<pre>a | bb\n--|---\n1 | 2</pre>");
});

test("raw HTML is shown, not interpreted", () => {
	assert.equal(html("hi <script>x</script>"), "hi &lt;script&gt;x&lt;/script&gt;");
});

test("long text is split under the limit", () => {
	for (const md of ["x ".repeat(6000), "para\n\n".repeat(1500), `\`\`\`\n${"line\n".repeat(3000)}\`\`\``]) {
		const chunks = renderMarkdown(md);
		assert.ok(chunks.length > 1);
		for (const c of chunks) assert.ok(c.html.length <= MAX_MESSAGE, `chunk of ${c.html.length}`);
	}
	const code = renderMarkdown(`\`\`\`\n${"line\n".repeat(3000)}\`\`\``);
	for (const c of code) assert.match(c.html, /^<pre>[\s\S]*<\/pre>$/);
});

test("empty input gives no messages", () => {
	assert.deepEqual(renderMarkdown(""), []);
	assert.deepEqual(renderMarkdown("\n\n"), []);
});
