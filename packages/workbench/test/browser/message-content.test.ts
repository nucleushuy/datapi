import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { Window as TestWindow } from "happy-dom";
import { renderMessageContent } from "../../src/browser/message-content.ts";

function setup(t: TestContext) {
	const browser = new TestWindow({
		url: "http://localhost:4310",
		settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
	});
	const document = browser.document as unknown as Document;
	const container = document.createElement("div");
	document.body.append(container);
	t.after(() => browser.happyDOM.close());
	return { browser, document, container };
}

test("Markdown preserves structure, accessible tables and external citations without active HTML", (t) => {
	const { container } = setup(t);
	renderMessageContent(
		container,
		[
			"## Dataset findings",
			"",
			"**Observed** missing values; *not* a causal claim.",
			"",
			"- First finding",
			"- Second finding",
			"",
			"| Column | Missing |",
			"| --- | ---: |",
			"| revenue | 12 |",
			"",
			"[1](https://example.com/evidence) [unsafe](javascript:alert%281%29)",
			"",
			'<img src="https://example.com/track" onerror="alert(1)"><script>alert(2)</script>',
			"",
			"![Remote chart](https://example.com/chart.png)",
		].join("\n"),
	);
	assert.equal(container.querySelector("h3")?.textContent, "Dataset findings");
	assert.equal(container.querySelector("strong")?.textContent, "Observed");
	assert.equal(container.querySelectorAll("li").length, 2);
	assert.equal(container.querySelector('th[scope="col"]')?.textContent, "Column");
	assert.equal(container.querySelector("td.numeric")?.textContent, "12");
	assert.equal(container.querySelectorAll("a").length, 1);
	assert.equal(container.querySelector("a")?.rel, "noopener noreferrer");
	assert.equal(container.querySelectorAll("script, img, iframe, [onerror], [onclick]").length, 0);
	assert.match(container.textContent ?? "", /<script>alert\(2\)<\/script>/);
	assert.match(container.textContent ?? "", /\[Image: Remote chart\]/);
});

test("code is highlighted, line numbered, collapsible and copies exact text", async (t) => {
	const { browser, container } = setup(t);
	const source = [
		"import pandas as pd",
		'name = "<script>not executable</script>"',
		...Array.from({ length: 12 }, (_, i) => `print(${i})`),
	].join("\n");
	let copied = "";
	Object.defineProperty(browser.navigator, "clipboard", {
		value: {
			writeText: async (text: string) => {
				copied = text;
			},
		},
	});
	renderMessageContent(container, `\`\`\`python\n${source}\n\`\`\``);
	assert.ok(container.querySelector(".hljs-keyword"));
	assert.equal(container.querySelectorAll(".code-line").length, 14);
	assert.equal(container.querySelectorAll(".code-line[hidden]").length, 2);
	assert.equal(container.querySelectorAll("script").length, 0);
	const expand = container.querySelector<HTMLButtonElement>('[aria-expanded="false"]')!;
	expand.click();
	assert.equal(container.querySelectorAll(".code-line[hidden]").length, 0);
	expand.click();
	assert.equal(container.querySelectorAll(".code-line[hidden]").length, 2);
	container.querySelector<HTMLButtonElement>('[aria-label="Copy python code"]')!.click();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(copied, source);
});

test("multiline code tokens and diff formatting preserve exact visible content", (t) => {
	const { container } = setup(t);
	renderMessageContent(container, '```python\nvalue = """first\nsecond"""\n```\n\n```diff\n-old\n+new\n```');
	assert.equal(container.querySelectorAll(".message-code").length, 2);
	assert.equal(container.querySelectorAll(".code-lines")[0].querySelectorAll(".hljs-string").length, 2);
	assert.equal(container.querySelector(".code-diff-add .code-source")?.textContent, "+new");
	assert.equal(container.querySelector(".code-diff-remove .code-source")?.textContent, "-old");
});

test("formulas render to bounded MathML without links, network resources or executable markup", (t) => {
	const { container } = setup(t);
	renderMessageContent(
		container,
		"Mean: $\\frac{\\sum_i x_i}{n}$.\n\n$$\ny = x^2\n$$\n\n$\\href{javascript:alert(1)}{unsafe}$",
	);
	assert.ok(container.querySelector("math mfrac"));
	assert.ok(container.querySelector(".message-math-block math"));
	assert.equal(container.querySelectorAll("a, img, script, [href], [src], [style]").length, 0);
});

test("unknown languages and incomplete streaming fences stay readable and safe", (t) => {
	const { container } = setup(t);
	renderMessageContent(container, "```unknown\n<img src=x onerror=alert(1)>\n");
	assert.equal(container.querySelector(".code-source")?.textContent, "<img src=x onerror=alert(1)>");
	assert.equal(container.querySelectorAll("img").length, 0);
	renderMessageContent(container, "Next response");
	assert.equal(container.querySelectorAll(".message-code").length, 0);
	assert.equal(container.textContent, "Next response");
});
